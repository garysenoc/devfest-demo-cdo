"""Execution + event persistence and live fan-out.

Design
------
* Executions and their events are persisted in SQLite, so a client can
  reconnect (``Last-Event-ID``), reload the page, or fetch the final plan long
  after the live stream ended.
* Each execution has a monotonically increasing ``seq`` assigned inside a
  write transaction, guaranteeing per-execution ordering.
* Live subscribers wait on a per-execution ``asyncio.Condition``; a writer
  bumps the in-memory high-water mark and notifies. Subscribers never read
  shared lists — they always re-read from the database after a wake-up.
* Each execution carries its own random access token (only a SHA-256 hash is
  stored). Event streams and snapshots require it, isolating sessions.

The store instance is owned by the FastAPI app (``app.state``), not a module
global, so tests and multiple apps never share state.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from shared.events import AgentId, AgentStatus, Channel, EventType, ExecutionEvent, ExecutionStatus, sanitize_payload, utc_now

_SCHEMA = """
CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    refinement TEXT,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (execution_id, seq)
);
"""


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class ExecutionRecord:
    id: str
    parent_id: str | None
    kind: str
    status: ExecutionStatus
    request: dict[str, Any]
    refinement: str | None
    result: dict[str, Any] | None
    error: str | None
    created_at: str
    updated_at: str


class ExecutionStore:
    def __init__(self, db_path: Path | str):
        if str(db_path) != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(db_path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(_SCHEMA)
        self._lock = threading.Lock()  # serializes sqlite access across worker threads
        self._conditions: dict[str, asyncio.Condition] = {}
        self._high_water: dict[str, int] = {}

    # ------------------------------------------------------------------ setup
    def close(self) -> None:
        with self._lock:
            self._db.close()

    def mark_interrupted(self) -> int:
        """Executions left 'running' by a previous process can never finish."""
        with self._lock, self._db:
            cur = self._db.execute(
                "UPDATE executions SET status='failed', error=?, updated_at=? WHERE status='running'",
                ("Interrupted: the coordinator restarted before this execution finished.", utc_now().isoformat()),
            )
            return cur.rowcount

    # ------------------------------------------------------------ executions
    async def create_execution(
        self, *, kind: str, request: dict[str, Any], parent_id: str | None = None, refinement: str | None = None
    ) -> tuple[str, str]:
        execution_id = uuid.uuid4().hex
        token = secrets.token_urlsafe(24)
        now = utc_now().isoformat()

        def _write() -> None:
            with self._lock, self._db:
                self._db.execute(
                    "INSERT INTO executions (id, parent_id, kind, status, token_hash, request_json, refinement, created_at, updated_at)"
                    " VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)",
                    (execution_id, parent_id, kind, _hash_token(token), json.dumps(request, default=str), refinement, now, now),
                )

        await asyncio.to_thread(_write)
        self._high_water[execution_id] = 0
        return execution_id, token

    async def verify_token(self, execution_id: str, token: str | None) -> bool | None:
        """None = unknown execution, False = bad token, True = ok."""

        def _read() -> str | None:
            with self._lock:
                row = self._db.execute("SELECT token_hash FROM executions WHERE id=?", (execution_id,)).fetchone()
            return row["token_hash"] if row else None

        stored = await asyncio.to_thread(_read)
        if stored is None:
            return None
        return bool(token) and hmac.compare_digest(stored, _hash_token(token or ""))

    async def get_execution(self, execution_id: str) -> ExecutionRecord | None:
        def _read() -> sqlite3.Row | None:
            with self._lock:
                return self._db.execute("SELECT * FROM executions WHERE id=?", (execution_id,)).fetchone()

        row = await asyncio.to_thread(_read)
        if row is None:
            return None
        return ExecutionRecord(
            id=row["id"],
            parent_id=row["parent_id"],
            kind=row["kind"],
            status=row["status"],
            request=json.loads(row["request_json"]),
            refinement=row["refinement"],
            result=json.loads(row["result_json"]) if row["result_json"] else None,
            error=row["error"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def finish(
        self,
        execution_id: str,
        *,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        final_event: ExecutionEvent | None = None,
    ) -> ExecutionEvent | None:
        """Mark an execution terminal. The terminal event (if given) is written in the
        SAME transaction, so a reader never sees a finished execution without it."""
        status = "failed" if error else "completed"

        def _write() -> ExecutionEvent | None:
            with self._lock, self._db:
                self._db.execute(
                    "UPDATE executions SET status=?, result_json=?, error=?, updated_at=? WHERE id=?",
                    (status, json.dumps(result, default=str) if result else None, error, utc_now().isoformat(), execution_id),
                )
                return self._insert_event(final_event) if final_event else None

        stored = await asyncio.to_thread(_write)
        if stored:
            await self._notify(stored)
        return stored

    async def count_running(self) -> int:
        def _read() -> int:
            with self._lock:
                return int(self._db.execute("SELECT COUNT(*) FROM executions WHERE status='running'").fetchone()[0])

        return await asyncio.to_thread(_read)

    # ---------------------------------------------------------------- events
    def _condition(self, execution_id: str) -> asyncio.Condition:
        cond = self._conditions.get(execution_id)
        if cond is None:
            cond = self._conditions[execution_id] = asyncio.Condition()
        return cond

    def _insert_event(self, event: ExecutionEvent) -> ExecutionEvent:
        """Assign the next seq and insert. Caller holds the lock + transaction."""
        row = self._db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE execution_id=?", (event.execution_id,)).fetchone()
        stored = event.model_copy(update={"seq": int(row[0])})
        self._db.execute(
            "INSERT INTO events (execution_id, seq, data_json) VALUES (?, ?, ?)",
            (stored.execution_id, stored.seq, stored.model_dump_json()),
        )
        self._db.execute("UPDATE executions SET updated_at=? WHERE id=?", (utc_now().isoformat(), event.execution_id))
        return stored

    async def _notify(self, stored: ExecutionEvent) -> None:
        cond = self._condition(stored.execution_id)
        async with cond:
            self._high_water[stored.execution_id] = max(self._high_water.get(stored.execution_id, 0), stored.seq)
            cond.notify_all()

    async def append(self, event: ExecutionEvent) -> ExecutionEvent:
        def _write() -> ExecutionEvent:
            with self._lock, self._db:
                return self._insert_event(event)

        stored = await asyncio.to_thread(_write)
        await self._notify(stored)
        return stored

    async def events_after(self, execution_id: str, after_seq: int = 0) -> list[ExecutionEvent]:
        def _read() -> list[sqlite3.Row]:
            with self._lock:
                return self._db.execute(
                    "SELECT data_json FROM events WHERE execution_id=? AND seq>? ORDER BY seq", (execution_id, after_seq)
                ).fetchall()

        rows = await asyncio.to_thread(_read)
        return [ExecutionEvent.model_validate_json(r["data_json"]) for r in rows]

    async def wait_for_new(self, execution_id: str, after_seq: int, timeout: float) -> bool:
        """Block until an event with seq > after_seq exists (True) or timeout (False)."""
        cond = self._condition(execution_id)
        async with cond:
            if self._high_water.get(execution_id, 0) > after_seq:
                return True
            try:
                await asyncio.wait_for(cond.wait(), timeout)
            except TimeoutError:
                return False
            return self._high_water.get(execution_id, 0) > after_seq

    def forget(self, execution_id: str) -> None:
        """Drop in-memory wake-up primitives once an execution is terminal and drained."""
        self._conditions.pop(execution_id, None)


class EventEmitter:
    """Execution-scoped helper that builds, sanitizes and stores events."""

    def __init__(self, store: ExecutionStore, execution_id: str):
        self.store = store
        self.execution_id = execution_id

    async def emit(
        self,
        type: EventType,
        agent_id: AgentId,
        message: str,
        *,
        channel: Channel = "internal",
        target: AgentId | None = None,
        task_id: str | None = None,
        status: AgentStatus | None = None,
        payload: Any | None = None,
        **metadata: Any,
    ) -> ExecutionEvent:
        return await self.store.append(
            self.build(type, agent_id, message, channel=channel, target=target, task_id=task_id, status=status, payload=payload, **metadata)
        )

    def build(
        self,
        type: EventType,
        agent_id: AgentId,
        message: str,
        *,
        channel: Channel = "internal",
        target: AgentId | None = None,
        task_id: str | None = None,
        status: AgentStatus | None = None,
        payload: Any | None = None,
        **metadata: Any,
    ) -> ExecutionEvent:
        """Construct a sanitized event without storing it."""
        return ExecutionEvent(
            execution_id=self.execution_id,
            type=type,
            channel=channel,
            agent_id=agent_id,
            target_agent_id=target,
            task_id=task_id,
            status=status,
            message=message,
            payload=sanitize_payload(payload) if payload is not None else None,
            metadata=sanitize_payload(metadata),
        )

    async def status(self, agent_id: AgentId, status: AgentStatus, message: str, **kwargs: Any) -> ExecutionEvent:
        return await self.emit("agent_status", agent_id, message, status=status, **kwargs)
