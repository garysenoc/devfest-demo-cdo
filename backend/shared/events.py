"""Typed execution-event contract streamed to the frontend over SSE.

Every event is produced by real backend execution: the coordinator emits an
event when it performs an orchestration step, and translates every A2A protocol
message it sends or receives (Agent Card fetches, SendStreamingMessage
requests, Task / TaskStatusUpdateEvent / TaskArtifactUpdateEvent responses)
into an event with ``channel="a2a"``.

The TypeScript mirror of this file lives in ``lib/types.ts``.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

AgentId = Literal["coordinator", "destination", "budget", "itinerary"]
SPECIALIST_IDS: tuple[AgentId, ...] = ("destination", "budget", "itinerary")

AgentStatus = Literal[
    "offline",
    "discovering",
    "available",
    "pending",
    "running",
    "communicating",
    "completed",
    "failed",
    "retrying",
]

EventType = Literal[
    "execution_started",
    "execution_completed",
    "execution_failed",
    "agent_status",
    "orchestration",
    "discovery_request",
    "discovery_response",
    "a2a_request",
    "a2a_task",
    "a2a_status_update",
    "a2a_artifact",
    "a2a_error",
    "validation",
    "plan_ready",
]

Channel = Literal["a2a", "internal"]
ExecutionStatus = Literal["running", "completed", "failed"]


def utc_now() -> datetime:
    return datetime.now(UTC)


class ExecutionEvent(BaseModel):
    """One entry on the execution timeline."""

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    seq: int = 0  # assigned by the event store; strictly increasing per execution
    execution_id: str
    timestamp: datetime = Field(default_factory=utc_now)
    type: EventType
    channel: Channel = "internal"
    agent_id: AgentId
    target_agent_id: AgentId | None = None
    task_id: str | None = None
    status: AgentStatus | None = None
    message: str
    payload: Any | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Payload sanitization for the communication inspector
# ---------------------------------------------------------------------------
_SECRET_KEY = re.compile(r"(api[_-]?key|token|secret|password|authorization|credential)", re.I)
_MAX_STRING = 4000
_MAX_ITEMS = 60
_MAX_DEPTH = 12


def sanitize_payload(value: Any, *, _depth: int = 0) -> Any:
    """Return a JSON-safe, size-bounded copy with secret-looking keys redacted."""
    if _depth > _MAX_DEPTH:
        return "…"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for i, (key, item) in enumerate(value.items()):
            if i >= _MAX_ITEMS:
                out["…"] = f"{len(value) - _MAX_ITEMS} more keys"
                break
            key_str = str(key)
            out[key_str] = "[redacted]" if _SECRET_KEY.search(key_str) else sanitize_payload(item, _depth=_depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        items = [sanitize_payload(v, _depth=_depth + 1) for v in list(value)[:_MAX_ITEMS]]
        if len(value) > _MAX_ITEMS:
            items.append(f"… {len(value) - _MAX_ITEMS} more items")
        return items
    if isinstance(value, str):
        return value if len(value) <= _MAX_STRING else value[:_MAX_STRING] + f"… [{len(value) - _MAX_STRING} chars truncated]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)
