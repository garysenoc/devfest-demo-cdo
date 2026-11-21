"""Event store: ordering, isolation, tokens, live wake-ups, restart recovery."""

from __future__ import annotations

import asyncio
from pathlib import Path

from coordinator.event_store import EventEmitter, ExecutionStore


async def test_sequence_and_isolation(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "e.db")
    a, _ = await store.create_execution(kind="plan", request={"destination": "Cebu"})
    b, _ = await store.create_execution(kind="plan", request={"destination": "Bohol"})
    ea, eb = EventEmitter(store, a), EventEmitter(store, b)

    await asyncio.gather(
        *(ea.emit("orchestration", "coordinator", f"a{i}") for i in range(20)),
        *(eb.emit("orchestration", "coordinator", f"b{i}") for i in range(5)),
    )

    events_a = await store.events_after(a)
    assert [e.seq for e in events_a] == list(range(1, 21))
    assert all(e.message.startswith("a") for e in events_a)
    assert len(await store.events_after(b)) == 5
    assert [e.seq for e in await store.events_after(a, 18)] == [19, 20]


async def test_token_verification(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "e.db")
    execution_id, token = await store.create_execution(kind="plan", request={})
    assert await store.verify_token(execution_id, token) is True
    assert await store.verify_token(execution_id, "wrong") is False
    assert await store.verify_token(execution_id, None) is False
    assert await store.verify_token("missing", token) is None


async def test_wait_for_new_wakes_subscriber(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "e.db")
    execution_id, _ = await store.create_execution(kind="plan", request={})
    emitter = EventEmitter(store, execution_id)

    waiter = asyncio.create_task(store.wait_for_new(execution_id, 0, timeout=5))
    await asyncio.sleep(0.05)
    assert not waiter.done()
    await emitter.status("budget", "running", "go")
    assert await asyncio.wait_for(waiter, 1) is True
    assert await store.wait_for_new(execution_id, 1, timeout=0.05) is False


async def test_payloads_are_sanitized(tmp_path: Path) -> None:
    store = ExecutionStore(tmp_path / "e.db")
    execution_id, _ = await store.create_execution(kind="plan", request={})
    event = await EventEmitter(store, execution_id).emit(
        "a2a_request", "coordinator", "x", channel="a2a", payload={"token": "abc"}, secret="s"
    )
    assert event.payload == {"token": "[redacted]"}
    assert event.metadata == {"secret": "[redacted]"}


async def test_finish_and_restart_recovery(tmp_path: Path) -> None:
    db = tmp_path / "e.db"
    store = ExecutionStore(db)
    done, _ = await store.create_execution(kind="plan", request={})
    running, _ = await store.create_execution(kind="plan", request={})
    await store.finish(done, result={"ok": True})
    store.close()

    restarted = ExecutionStore(db)
    assert restarted.mark_interrupted() == 1
    record = await restarted.get_execution(running)
    assert record is not None and record.status == "failed" and "Interrupted" in (record.error or "")
    finished = await restarted.get_execution(done)
    assert finished is not None and finished.status == "completed" and finished.result == {"ok": True}
