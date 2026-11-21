"""End-to-end: frontend-facing HTTP API -> coordinator -> A2A specialists -> SSE.

Four real HTTP servers run (coordinator + 3 specialists). The test consumes the
SSE stream exactly like the browser does and checks orchestration order.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest

from coordinator.main import create_app
from shared.schemas import TravelPlan

from .conftest import make_settings
from .fakes import FakeGemini, ServerThread, free_port

PLAN_BODY = {
    "destination": "Cebu",
    "days": 3,
    "travelers": 1,
    "budget": 10000,
    "currency": "PHP",
    "interests": ["beaches", "adventure", "local food"],
    "start_date": "2026-12-04",
    "end_date": "2026-12-06",
}


@pytest.fixture
def coordinator(specialist_cluster, tmp_path: Path) -> Iterator[str]:
    urls = {k: v.url for k, v in specialist_cluster.items()}
    app = create_app(make_settings(tmp_path, urls), model=FakeGemini(delay=0.05))
    server = ServerThread(app, free_port()).start()
    yield server.url
    server.stop()


async def read_sse(client: httpx.AsyncClient, url: str) -> list[tuple[str, str | None, str]]:
    """Return [(event, id, data)] until the server closes the stream."""
    messages: list[tuple[str, str | None, str]] = []
    event, event_id, data = "message", None, []
    async with client.stream("GET", url, timeout=60) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        async for line in response.aiter_lines():
            if line == "":
                if data:
                    messages.append((event, event_id, "\n".join(data)))
                event, event_id, data = "message", None, []
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("id:"):
                event_id = line[3:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())
    return messages


def _index(events: list[dict], predicate) -> int:
    return next(i for i, e in enumerate(events) if predicate(e))


async def test_full_plan_workflow(coordinator: str) -> None:
    async with httpx.AsyncClient(base_url=coordinator, timeout=30) as client:
        health = (await client.get("/health")).json()
        assert health["status"] == "ok" and health["gemini_configured"] is True

        agents = (await client.get("/api/agents")).json()["agents"]
        assert [a["id"] for a in agents] == ["coordinator", "destination", "budget", "itinerary"]
        assert all(a["status"] == "available" for a in agents)

        created = await client.post("/api/plans", json=PLAN_BODY)
        assert created.status_code == 202
        execution_id, token = created.json()["execution_id"], created.json()["access_token"]

        messages = await read_sse(client, f"/api/executions/{execution_id}/events?token={token}")
        assert messages[-1][0] == "end" and json.loads(messages[-1][2])["status"] == "completed"
        events = [json.loads(d) for (name, _, d) in messages if name == "execution_event"]

        # Ordered, gap-free sequence numbers that match the SSE ids.
        assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
        assert [int(i) for (n, i, _) in messages if n == "execution_event"] == [e["seq"] for e in events]

        assert events[0]["type"] == "execution_started"
        assert events[-1]["type"] == "execution_completed"

        # Discovery of all three Agent Cards happens before any delegation.
        discovered = {e["agent_id"] for e in events if e["type"] == "discovery_response" and e["status"] == "available"}
        assert discovered == {"destination", "budget", "itinerary"}
        first_request = _index(events, lambda e: e["type"] == "a2a_request")
        assert all(i < first_request for i, e in enumerate(events) if e["type"] == "discovery_response")

        # Destination + Budget are delegated concurrently: both requests go out before either completes.
        def done(agent: str) -> int:
            return _index(events, lambda e: e["type"] == "agent_status" and e["agent_id"] == agent and e["status"] == "completed")

        def sent(agent: str) -> int:
            return _index(events, lambda e: e["type"] == "a2a_request" and e["target_agent_id"] == agent)

        assert max(sent("destination"), sent("budget")) < min(done("destination"), done("budget"))

        # Itinerary depends on both results and receives them in its A2A payload.
        assert sent("itinerary") > max(done("destination"), done("budget"))
        itinerary_payload = events[sent("itinerary")]["payload"]["message"]["parts"][0]["text"]
        assert itinerary_payload["destination_research"]["attractions"][0]["name"] == "Kawasan Falls"
        assert itinerary_payload["budget_plan"]["total_estimated"] == 8250

        # Every A2A event carries a task id from the remote agent.
        for e in events:
            if e["type"] in {"a2a_task", "a2a_status_update", "a2a_artifact"}:
                assert e["task_id"] and e["channel"] == "a2a"

        snapshot = (await client.get(f"/api/executions/{execution_id}", params={"token": token})).json()
        assert snapshot["status"] == "completed" and len(snapshot["events"]) == len(events)
        plan = TravelPlan.model_validate(snapshot["result"])
        assert plan.overview.estimated_total == 8250 and plan.overview.remaining == 1750
        assert [d.date for d in plan.itinerary.days] == ["2026-12-04", "2026-12-05", "2026-12-06"]
        assert plan.summary.headline == "Three sun-soaked days in Cebu"
        assert plan.agents_invoked == ["destination", "budget", "itinerary"]

        # Reconnection: resuming from a cursor replays only later events.
        cursor = len(events) - 3
        replay = await read_sse(client, f"/api/executions/{execution_id}/events?token={token}&last_event_id={cursor}")
        assert [json.loads(d)["seq"] for (n, _, d) in replay if n == "execution_event"] == [cursor + 1, cursor + 2, cursor + 3]
        header_replay = await read_sse_with_header(client, f"/api/executions/{execution_id}/events?token={token}", cursor)
        assert header_replay == [cursor + 1, cursor + 2, cursor + 3]

        # Refinement re-runs only the agents chosen by the coordinator's router (budget + itinerary).
        refined = await client.post(
            f"/api/executions/{execution_id}/refine", params={"token": token}, json={"instruction": "Make the trip cheaper"}
        )
        assert refined.status_code == 202
        new_id, new_token = refined.json()["execution_id"], refined.json()["access_token"]
        assert new_id != execution_id
        refine_messages = await read_sse(client, f"/api/executions/{new_id}/events?token={new_token}")
        refine_events = [json.loads(d) for (n, _, d) in refine_messages if n == "execution_event"]
        targets = {e["target_agent_id"] for e in refine_events if e["type"] == "a2a_request"}
        assert targets == {"budget", "itinerary"}
        refined_plan = TravelPlan.model_validate(
            (await client.get(f"/api/executions/{new_id}", params={"token": new_token})).json()["result"]
        )
        assert refined_plan.parent_execution_id == execution_id
        assert refined_plan.request.travel_style == "budget"
        assert refined_plan.agents_invoked == ["budget", "itinerary"]
        assert refined_plan.destination == plan.destination  # reused, not regenerated


async def read_sse_with_header(client: httpx.AsyncClient, url: str, last_event_id: int) -> list[int]:
    seqs: list[int] = []
    async with client.stream("GET", url, headers={"Last-Event-ID": str(last_event_id)}, timeout=30) as response:
        async for line in response.aiter_lines():
            if line.startswith("data:") and '"seq"' in line:
                seqs.append(json.loads(line[5:])["seq"])
    return seqs


async def test_security_and_validation(coordinator: str) -> None:
    async with httpx.AsyncClient(base_url=coordinator, timeout=30) as client:
        bad = await client.post("/api/plans", json={**PLAN_BODY, "budget": -1})
        assert bad.status_code == 422

        created = (await client.post("/api/plans", json=PLAN_BODY)).json()
        execution_id = created["execution_id"]
        assert (await client.get(f"/api/executions/{execution_id}")).status_code == 401
        assert (await client.get(f"/api/executions/{execution_id}", params={"token": "nope"})).status_code == 401
        assert (await client.get(f"/api/executions/{execution_id}/events", params={"token": "nope"})).status_code == 401
        assert (await client.get("/api/executions/unknown", params={"token": "x"})).status_code == 404
        # Another execution's token cannot read this one.
        other = (await client.post("/api/plans", json=PLAN_BODY)).json()
        assert (await client.get(f"/api/executions/{execution_id}", params={"token": other["access_token"]})).status_code == 401

        cors = await client.options("/api/plans", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
        assert cors.headers["access-control-allow-origin"] == "http://localhost:3000"
        evil = await client.options("/api/plans", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        assert "access-control-allow-origin" not in evil.headers


async def test_offline_specialist_fails_execution(tmp_path: Path, specialist_cluster) -> None:
    urls = {k: v.url for k, v in specialist_cluster.items()}
    urls["itinerary"] = f"http://127.0.0.1:{free_port()}"  # nothing listening
    server = ServerThread(create_app(make_settings(tmp_path, urls), model=FakeGemini(delay=0.01)), free_port()).start()
    try:
        async with httpx.AsyncClient(base_url=server.url, timeout=30) as client:
            agents = {a["id"]: a for a in (await client.get("/api/agents")).json()["agents"]}
            assert agents["itinerary"]["status"] == "offline" and "is the agent running" in agents["itinerary"]["error"]

            created = (await client.post("/api/plans", json=PLAN_BODY)).json()
            messages = await read_sse(client, f"/api/executions/{created['execution_id']}/events?token={created['access_token']}")
            events = [json.loads(d) for (n, _, d) in messages if n == "execution_event"]
            assert events[-1]["type"] == "execution_failed"
            assert "Itinerary Planning Agent" in events[-1]["message"]
            assert any(e["type"] == "discovery_response" and e["status"] == "offline" for e in events)
            assert not any(e["type"] == "a2a_request" for e in events), "no work is delegated when discovery fails"
            snap = (await client.get(f"/api/executions/{created['execution_id']}", params={"token": created["access_token"]})).json()
            assert snap["status"] == "failed" and snap["result"] is None
    finally:
        server.stop()


async def test_gemini_not_configured_returns_503(tmp_path: Path) -> None:
    server = ServerThread(create_app(make_settings(tmp_path, {})), free_port()).start()
    try:
        async with httpx.AsyncClient(base_url=server.url) as client:
            assert (await client.get("/health")).json()["gemini_configured"] is False
            response = await client.post("/api/plans", json=PLAN_BODY)
            assert response.status_code == 503 and "GOOGLE_API_KEY" in response.json()["detail"]
    finally:
        server.stop()
