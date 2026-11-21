"""A2A integration tests over real HTTP.

Each specialist runs as a real uvicorn server exposing ADK's A2A app; the
coordinator side uses the official a2a-sdk client. Only Gemini is faked.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from coordinator.a2a_client import RemoteAgentCaller
from coordinator.discovery import discover, fetch_card
from coordinator.event_store import EventEmitter, ExecutionStore
from coordinator.orchestrator import summarize_budget, summarize_destination
from shared.exceptions import AgentDiscoveryError, RemoteTaskError
from shared.schemas import BudgetPlan, BudgetTask, DestinationResearch, DestinationTask, TripRequest

from .fakes import FakeGemini

REQUEST = TripRequest(destination="Cebu", days=3, travelers=2, budget=20000, currency="PHP", interests=["beaches"])


async def _emitter(tmp_path: Path) -> EventEmitter:
    store = ExecutionStore(tmp_path / "events.db")
    execution_id, _ = await store.create_execution(kind="plan", request=REQUEST.model_dump(mode="json"))
    return EventEmitter(store, execution_id)


async def test_agent_card_endpoint_and_health(specialist_cluster) -> None:
    async with httpx.AsyncClient() as http:
        for agent_id, server in specialist_cluster.items():
            card = (await http.get(f"{server.url}/.well-known/agent-card.json")).json()
            assert card["supportedInterfaces"][0]["url"] == f"{server.url}/"
            assert card["capabilities"]["streaming"] is True
            assert card["skills"]
            health = (await http.get(f"{server.url}/health")).json()
            assert health == {
                "status": "ok",
                "agent_id": agent_id,
                "name": card["name"],
                "agent_card": f"{server.url}/.well-known/agent-card.json",
            }


async def test_discovery_emits_events(specialist_cluster, tmp_path: Path) -> None:
    emitter = await _emitter(tmp_path)
    async with httpx.AsyncClient() as http:
        found = await discover("budget", specialist_cluster["budget"].url, http, 3, emitter)
    assert found.card.name == "Budget Planning Agent"
    events = await emitter.store.events_after(emitter.execution_id)
    assert [(e.type, e.status) for e in events] == [
        ("agent_status", "discovering"),
        ("discovery_request", None),
        ("discovery_response", "available"),
    ]
    assert events[2].channel == "a2a" and events[2].payload["name"] == "Budget Planning Agent"


async def test_discovery_of_offline_agent_fails(tmp_path: Path) -> None:
    async with httpx.AsyncClient() as http:
        with pytest.raises(AgentDiscoveryError, match="is the agent running"):
            await fetch_card("destination", "http://127.0.0.1:9", http, 2)


async def test_task_lifecycle_and_artifact(specialist_cluster, tmp_path: Path) -> None:
    emitter = await _emitter(tmp_path)
    async with httpx.AsyncClient(timeout=30) as http:
        agent = await discover("destination", specialist_cluster["destination"].url, http, 3, emitter)
        caller = RemoteAgentCaller(http, timeout=20, max_retries=0)
        result = await caller.call(
            agent, DestinationTask(request=REQUEST), DestinationResearch, label="research", emitter=emitter, summarize=summarize_destination
        )
    assert isinstance(result, DestinationResearch) and len(result.attractions) == 3

    events = [e for e in await emitter.store.events_after(emitter.execution_id) if e.type.startswith("a2a_")]
    kinds = [e.type for e in events]
    assert kinds[0] == "a2a_request" and events[0].agent_id == "coordinator" and events[0].target_agent_id == "destination"
    assert events[0].payload["message"]["parts"][0]["text"]["request"]["destination"] == "Cebu"
    assert kinds[1] == "a2a_task" and events[1].metadata["task_state"] == "TASK_STATE_SUBMITTED"
    states = [e.metadata.get("task_state") for e in events if e.type == "a2a_status_update"]
    assert states[0] == "TASK_STATE_WORKING" and states[-1] == "TASK_STATE_COMPLETED"
    artifact = next(e for e in events if e.type == "a2a_artifact")
    assert artifact.payload["artifactUpdate"]["artifact"]["parts"][0]["data"]["attractions"][0]["name"] == "Kawasan Falls"
    # One task id is tracked across every response event.
    task_ids = {e.task_id for e in events[1:]}
    assert len(task_ids) == 1 and None not in task_ids

    final = (await emitter.store.events_after(emitter.execution_id))[-1]
    assert final.type == "agent_status" and final.status == "completed" and final.metadata["summary"].startswith("3 attractions")


async def test_budget_artifact_has_code_computed_totals(specialist_cluster, tmp_path: Path) -> None:
    emitter = await _emitter(tmp_path)
    async with httpx.AsyncClient(timeout=30) as http:
        agent = await discover("budget", specialist_cluster["budget"].url, http, 3, emitter)
        plan = await RemoteAgentCaller(http, timeout=20, max_retries=0).call(
            agent, BudgetTask(request=REQUEST), BudgetPlan, label="budget", emitter=emitter, summarize=summarize_budget
        )
    # 2 travelers x 3 days: transport 3600 + lodging 1800 + food 3600 + activities 3600 + misc 300 = 12900, +10%
    assert plan.subtotal == 12900 and plan.total_estimated == 14190 and plan.remaining == 5810
    assert plan.travelers == 2 and plan.currency == "PHP"


async def test_failed_task_is_retried(start_specialist, tmp_path: Path) -> None:
    server = start_specialist("destination", FakeGemini(fail_first=1, delay=0.05))
    emitter = await _emitter(tmp_path)
    async with httpx.AsyncClient(timeout=30) as http:
        agent = await discover("destination", server.url, http, 3, emitter)
        caller = RemoteAgentCaller(http, timeout=20, max_retries=1, retry_backoff=0.01)
        result = await caller.call(
            agent, DestinationTask(request=REQUEST), DestinationResearch, label="r", emitter=emitter, summarize=summarize_destination
        )
    assert result.attractions
    events = await emitter.store.events_after(emitter.execution_id)
    failed_state = [e for e in events if e.metadata.get("task_state") == "TASK_STATE_FAILED"]
    assert failed_state, "the first attempt should end in TASK_STATE_FAILED on the wire"
    assert [e.status for e in events if e.type == "agent_status"][-2:] == ["pending", "completed"]
    assert any(e.status == "retrying" and e.metadata["attempt"] == 2 for e in events)
    assert len({e.task_id for e in events if e.type == "a2a_task"}) == 2  # two distinct remote tasks


async def test_failed_task_without_retries_raises(start_specialist, tmp_path: Path) -> None:
    server = start_specialist("destination", FakeGemini(fail_first=5, delay=0.01))
    emitter = await _emitter(tmp_path)
    async with httpx.AsyncClient(timeout=30) as http:
        agent = await discover("destination", server.url, http, 3, emitter)
        with pytest.raises(RemoteTaskError, match="TASK_STATE_FAILED"):
            await RemoteAgentCaller(http, timeout=20, max_retries=0).call(
                agent, DestinationTask(request=REQUEST), DestinationResearch, label="r", emitter=emitter, summarize=summarize_destination
            )


async def test_timeout(start_specialist, tmp_path: Path) -> None:
    server = start_specialist("budget", FakeGemini(delay=5))
    emitter = await _emitter(tmp_path)
    async with httpx.AsyncClient(timeout=30) as http:
        agent = await discover("budget", server.url, http, 3, emitter)
        with pytest.raises(RemoteTaskError, match="timed out"):
            await RemoteAgentCaller(http, timeout=0.5, max_retries=0).call(
                agent, BudgetTask(request=REQUEST), BudgetPlan, label="b", emitter=emitter, summarize=summarize_budget
            )
    events = await emitter.store.events_after(emitter.execution_id)
    assert events[-1].type == "a2a_error" and events[-1].status == "failed"
