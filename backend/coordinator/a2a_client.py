"""Delegating tasks to remote specialists over A2A (official a2a-sdk client).

Every protocol message is mirrored into the execution event stream:

  coordinator --SendStreamingMessage--> specialist        (a2a_request)
  coordinator <--Task (SUBMITTED)------ specialist        (a2a_task)
  coordinator <--TaskStatusUpdateEvent  (WORKING, ...)    (a2a_status_update)
  coordinator <--TaskArtifactUpdateEvent (result JSON)    (a2a_artifact)
  coordinator <--TaskStatusUpdateEvent  (COMPLETED)       (a2a_status_update)

The artifact is validated against the specialist's Pydantic contract before it
is accepted. Timeouts, transport errors, failed tasks and invalid artifacts are
retried up to ``A2A_MAX_RETRIES`` times.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Callable
from typing import TypeVar

import httpx
from a2a.client import ClientConfig, ClientFactory
from a2a.types import (
    CancelTaskRequest,
    Message,
    Part,
    Role,
    SendMessageConfiguration,
    SendMessageRequest,
    TaskState,
)
from google.protobuf.json_format import MessageToDict
from pydantic import BaseModel, ValidationError

from shared.agent_runtime import parse_json_text
from shared.events import AgentId
from shared.exceptions import RemoteTaskError, ResultValidationError

from .discovery import AGENT_NAMES, DiscoveredAgent
from .event_store import EventEmitter

logger = logging.getLogger("coordinator.a2a")

T = TypeVar("T", bound=BaseModel)

_TERMINAL_FAILURES = {
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
}


def _state_name(state: int) -> str:
    return TaskState.Name(state)


def _looks_like_json(text: str) -> bool:
    try:
        parse_json_text(text)
    except ValueError:
        return False
    return True


def _parts_text(parts) -> str:
    return "".join(p.text for p in parts if p.text)


class RemoteAgentCaller:
    """Sends one structured task to one specialist and returns a validated result."""

    def __init__(self, http: httpx.AsyncClient, *, timeout: float, max_retries: int, retry_backoff: float = 1.5):
        self._http = http
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._factory = ClientFactory(ClientConfig(streaming=True, httpx_client=http))

    async def call(
        self,
        agent: DiscoveredAgent,
        payload: BaseModel,
        output_model: type[T],
        *,
        label: str,
        emitter: EventEmitter,
        summarize: Callable[[T], str],
    ) -> T:
        attempts = self._max_retries + 1
        for attempt in range(1, attempts + 1):
            try:
                return await self._attempt(agent, payload, output_model, label=label, emitter=emitter, summarize=summarize, attempt=attempt)
            except RemoteTaskError as exc:
                await emitter.emit(
                    "a2a_error",
                    agent.agent_id,
                    f"{AGENT_NAMES[agent.agent_id]} attempt {attempt} failed: {exc}",
                    channel="a2a",
                    target="coordinator",
                    task_id=exc.task_id,
                    status="failed",
                    attempt=attempt,
                )
                if not exc.retryable or attempt == attempts:
                    raise
                await emitter.status(
                    agent.agent_id,
                    "retrying",
                    f"Retrying {AGENT_NAMES[agent.agent_id]} (attempt {attempt + 1} of {attempts})",
                    attempt=attempt + 1,
                )
                await asyncio.sleep(self._retry_backoff * attempt)
        raise AssertionError("unreachable")

    async def _attempt(
        self,
        agent: DiscoveredAgent,
        payload: BaseModel,
        output_model: type[T],
        *,
        label: str,
        emitter: EventEmitter,
        summarize: Callable[[T], str],
        attempt: int,
    ) -> T:
        agent_id: AgentId = agent.agent_id
        name = AGENT_NAMES[agent_id]
        endpoint = agent.card.supported_interfaces[0].url
        client = self._factory.create(agent.card)
        message = Message(
            message_id=uuid.uuid4().hex,
            role=Role.ROLE_USER,
            parts=[Part(text=payload.model_dump_json(), media_type="application/json")],
            metadata={"task_label": label, "sender": "travel_coordinator", "attempt": attempt},
        )
        request = SendMessageRequest(
            message=message,
            configuration=SendMessageConfiguration(accepted_output_modes=["application/json", "text/plain"]),
        )
        request_dict = MessageToDict(request)
        # Inline the JSON task payload so the inspector shows structured data, not an escaped string.
        request_dict["message"]["parts"][0]["text"] = json.loads(request_dict["message"]["parts"][0]["text"])

        started = time.perf_counter()
        task_id: str | None = None
        artifact_text = ""
        final_state: int | None = None
        failure_text = ""

        await emitter.emit(
            "a2a_request",
            "coordinator",
            f"Submitting A2A task to {name}: {label}",
            channel="a2a",
            target=agent_id,
            status="communicating",
            payload=request_dict,
            message_type="SendStreamingMessage",
            direction="request",
            endpoint=endpoint,
            task_label=label,
            attempt=attempt,
        )
        await emitter.status(agent_id, "pending", f"{name} received task: {label}", task_label=label)

        try:
            async with asyncio.timeout(self._timeout):
                async for response in client.send_message(request):
                    kind = response.WhichOneof("payload")
                    raw = MessageToDict(response)
                    if kind == "task":
                        task_id = response.task.id
                        state = response.task.status.state
                        await emitter.emit(
                            "a2a_task",
                            agent_id,
                            f"{name} accepted task ({_state_name(state)})",
                            channel="a2a",
                            target="coordinator",
                            task_id=task_id,
                            status="pending",
                            payload=raw,
                            message_type="Task",
                            direction="response",
                            task_state=_state_name(state),
                            task_label=label,
                        )
                    elif kind == "status_update":
                        update = response.status_update
                        task_id = task_id or update.task_id
                        state = update.status.state
                        status_text = _parts_text(update.status.message.parts) if update.status.HasField("message") else ""
                        if state == TaskState.TASK_STATE_WORKING:
                            if not status_text:
                                msg = f"{name} processing request"
                            elif _looks_like_json(status_text):
                                msg = f"{name} produced structured output ({len(status_text):,} chars)"
                            else:
                                msg = f"{name} reported: {status_text[:120]}"
                            await emitter.emit(
                                "a2a_status_update",
                                agent_id,
                                msg,
                                channel="a2a",
                                target="coordinator",
                                task_id=task_id,
                                status="running",
                                payload=raw,
                                message_type="TaskStatusUpdateEvent",
                                direction="response",
                                task_state=_state_name(state),
                            )
                            if status_text and not artifact_text:
                                artifact_text = status_text  # fallback if no artifact arrives
                        else:
                            final_state = state
                            if state in _TERMINAL_FAILURES:
                                failure_text = status_text or _state_name(state)
                            await emitter.emit(
                                "a2a_status_update",
                                agent_id,
                                f"{name} task {_state_name(state).removeprefix('TASK_STATE_').lower()}",
                                channel="a2a",
                                target="coordinator",
                                task_id=task_id,
                                status=None,  # completion is announced after validation
                                payload=raw,
                                message_type="TaskStatusUpdateEvent",
                                direction="response",
                                task_state=_state_name(state),
                            )
                    elif kind == "artifact_update":
                        update = response.artifact_update
                        task_id = task_id or update.task_id
                        text = _parts_text(update.artifact.parts)
                        artifact_text = artifact_text + text if update.append else text
                        try:
                            artifact_payload = parse_json_text(text)
                        except ValueError:
                            artifact_payload = text
                        await emitter.emit(
                            "a2a_artifact",
                            agent_id,
                            f"{name} returned result artifact",
                            channel="a2a",
                            target="coordinator",
                            task_id=task_id,
                            status="communicating",
                            payload={
                                "artifactUpdate": {
                                    **raw["artifactUpdate"],
                                    "artifact": {**raw["artifactUpdate"]["artifact"], "parts": [{"data": artifact_payload}]},
                                }
                            },
                            message_type="TaskArtifactUpdateEvent",
                            direction="response",
                            artifact_id=update.artifact.artifact_id,
                        )
                    elif kind == "message":
                        artifact_text = _parts_text(response.message.parts)
                        final_state = TaskState.TASK_STATE_COMPLETED
        except TimeoutError as exc:
            await self._cancel_quietly(client, task_id)
            raise RemoteTaskError(agent_id, f"timed out after {self._timeout:.0f}s", task_id=task_id) from exc
        except RemoteTaskError:
            raise
        except Exception as exc:
            logger.warning("A2A transport error talking to %s: %r", agent_id, exc)
            raise RemoteTaskError(agent_id, f"A2A transport error ({type(exc).__name__})", task_id=task_id) from exc

        if final_state in _TERMINAL_FAILURES:
            raise RemoteTaskError(agent_id, f"remote task ended in {_state_name(final_state)}: {failure_text[:300]}", task_id=task_id)
        if final_state != TaskState.TASK_STATE_COMPLETED:
            raise RemoteTaskError(agent_id, "stream ended before the task completed", task_id=task_id)
        if not artifact_text.strip():
            raise ResultValidationError(agent_id, "task completed without a result artifact", task_id=task_id)

        try:
            result = output_model.model_validate(parse_json_text(artifact_text))
        except (ValueError, ValidationError) as exc:
            await emitter.emit(
                "validation",
                "coordinator",
                f"{name} result failed {output_model.__name__} validation",
                task_id=task_id,
                error=str(exc)[:500],
            )
            raise ResultValidationError(agent_id, f"result did not match {output_model.__name__}", task_id=task_id) from exc

        duration_ms = int((time.perf_counter() - started) * 1000)
        summary = summarize(result)
        await emitter.emit(
            "validation",
            "coordinator",
            f"Validated {name} result against {output_model.__name__} schema",
            task_id=task_id,
            schema=output_model.__name__,
        )
        await emitter.status(
            agent_id,
            "completed",
            f"{name} completed: {summary}",
            task_id=task_id,
            summary=summary,
            duration_ms=duration_ms,
        )
        return result

    async def _cancel_quietly(self, client, task_id: str | None) -> None:
        if not task_id:
            return
        try:
            await asyncio.wait_for(client.cancel_task(CancelTaskRequest(id=task_id)), 5)
        except Exception:  # best effort; the task may already be gone
            logger.debug("cancel_task failed for %s", task_id, exc_info=True)
