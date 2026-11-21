"""Travel Coordinator HTTP API.

    cd backend && uv run python -m coordinator.main      # http://localhost:8000

Endpoints
---------
GET  /health                                  liveness + configuration status
GET  /api/agents                              live Agent Card discovery for all specialists
POST /api/plans                               start a planning execution  -> {execution_id, access_token}
GET  /api/executions/{id}?token=...           snapshot: events so far + final plan
GET  /api/executions/{id}/events?token=...    Server-Sent Events (supports Last-Event-ID)
POST /api/executions/{id}/refine?token=...    start a refinement execution from a finished plan
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from google.adk.models.base_llm import BaseLlm
from sse_starlette.sse import EventSourceResponse

from shared.config import Settings, get_settings
from shared.events import SPECIALIST_IDS, AgentId
from shared.exceptions import AgentDiscoveryError, ConfigurationError
from shared.logging import configure_logging
from shared.schemas import RefineRequest, TravelPlan, TripRequest

from .discovery import AGENT_NAMES, card_url, fetch_card
from .event_store import ExecutionStore
from .orchestrator import TravelOrchestrator

TERMINAL_EVENTS = {"execution_completed", "execution_failed"}
HEARTBEAT_SECONDS = 15.0

ROLES = {
    "coordinator": "Orchestration and delegation",
    "destination": "Destination discovery and recommendations",
    "budget": "Expense estimation and optimization",
    "itinerary": "Daily schedules and organization",
}


def create_app(settings: Settings | None = None, *, model: str | BaseLlm | None = None) -> FastAPI:
    """App factory. ``model`` lets automated tests inject a fake LLM for the
    coordinator's own ADK agents; production uses Gemini from settings."""
    settings = settings or get_settings()
    logger = configure_logging("coordinator", settings.log_level)

    gemini_error: str | None = None
    if model is None:
        try:
            settings.validate_gemini()
        except ConfigurationError as exc:
            gemini_error = str(exc)
            logger.error("Gemini is not configured: %s", exc)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store = ExecutionStore(settings.coordinator_db_path)
        interrupted = store.mark_interrupted()
        if interrupted:
            logger.warning("Marked %d interrupted execution(s) from a previous run as failed", interrupted)
        timeout = httpx.Timeout(connect=5.0, read=settings.a2a_timeout_seconds, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as http:
            app.state.store = store
            app.state.http = http
            app.state.orchestrator = TravelOrchestrator(settings, store, http, model=model)
            logger.info("Coordinator ready. Specialists: %s", settings.specialist_urls)
            yield
            await app.state.orchestrator.shutdown()
        store.close()

    app = FastAPI(
        title="AI Travel Planner — Travel Coordinator",
        description="Google ADK coordinator delegating to specialist agents over the A2A protocol.",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Last-Event-ID", "X-Execution-Token"],
    )

    # ------------------------------------------------------------ helpers
    async def authorize(request: Request, execution_id: str, token: str | None) -> ExecutionStore:
        store: ExecutionStore = request.app.state.store
        ok = await store.verify_token(execution_id, token)
        if ok is None:
            raise HTTPException(404, "Execution not found")
        if not ok:
            raise HTTPException(401, "Invalid or missing execution token")
        return store

    def require_gemini() -> None:
        if gemini_error:
            raise HTTPException(503, gemini_error)

    async def enforce_capacity(store: ExecutionStore) -> None:
        if await store.count_running() >= settings.max_concurrent_executions:
            raise HTTPException(429, "Too many plans are being generated right now. Try again in a minute.")

    # ------------------------------------------------------------- routes
    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "coordinator",
            "model": settings.gemini_model if model is None else getattr(model, "model", str(model)),
            "gemini_configured": gemini_error is None,
            "specialists": settings.specialist_urls,
        }

    @app.get("/api/agents")
    async def agents(request: Request) -> dict[str, Any]:
        http: httpx.AsyncClient = request.app.state.http
        urls = settings.specialist_urls

        async def probe(agent_id: AgentId) -> dict[str, Any]:
            base = urls[agent_id]
            info: dict[str, Any] = {
                "id": agent_id,
                "name": AGENT_NAMES[agent_id],
                "description": "",
                "role": ROLES[agent_id],
                "url": base,
                "card_url": card_url(base),
                "status": "offline",
                "latency_ms": None,
                "error": None,
                "protocol_version": None,
                "streaming": False,
                "skills": [],
                "card": None,
            }
            try:
                found = await fetch_card(agent_id, base, http, settings.discovery_timeout_seconds)  # type: ignore[arg-type]
            except AgentDiscoveryError as exc:
                info["error"] = str(exc)
                return info
            card = found.card
            info.update(
                name=card.name,
                description=card.description,
                status="available",
                latency_ms=found.latency_ms,
                protocol_version=card.supported_interfaces[0].protocol_version if card.supported_interfaces else None,
                streaming=card.capabilities.streaming,
                skills=[{"id": s.id, "name": s.name, "description": s.description, "tags": list(s.tags)} for s in card.skills],
                card=found.card_json,
            )
            return info

        coordinator = {
            "id": "coordinator",
            "name": AGENT_NAMES["coordinator"],
            "description": (
                "Google ADK agent that validates requests, discovers specialists via their Agent Cards, "
                "delegates tasks over A2A, validates results and consolidates the final plan."
            ),
            "role": ROLES["coordinator"],
            "url": str(request.base_url).rstrip("/"),
            "card_url": None,
            "status": "available" if gemini_error is None else "offline",
            "latency_ms": 0,
            "error": gemini_error,
            "protocol_version": None,
            "streaming": True,
            "skills": [
                {
                    "id": "orchestration",
                    "name": "Multi-agent orchestration",
                    "description": "Parallel + dependent A2A delegation",
                    "tags": ["a2a", "adk"],
                },
                {
                    "id": "consolidation",
                    "name": "Plan consolidation",
                    "description": "Travel tips and consistency checks",
                    "tags": ["gemini"],
                },
            ],
            "card": None,
        }
        specialists = await asyncio.gather(*(probe(a) for a in SPECIALIST_IDS))
        return {"agents": [coordinator, *specialists], "checked_at": datetime.now(UTC).isoformat()}

    @app.post("/api/plans", status_code=202)
    async def create_plan(trip: TripRequest, request: Request) -> dict[str, str]:
        require_gemini()
        store: ExecutionStore = request.app.state.store
        await enforce_capacity(store)
        execution_id, token = await store.create_execution(kind="plan", request=trip.model_dump(mode="json"))
        request.app.state.orchestrator.start(request.app.state.orchestrator.run_plan(execution_id, trip))
        return {"execution_id": execution_id, "access_token": token}

    @app.post("/api/executions/{execution_id}/refine", status_code=202)
    async def refine(
        execution_id: str,
        body: RefineRequest,
        request: Request,
        token: str | None = Query(default=None),
        x_execution_token: str | None = Header(default=None),
    ) -> dict[str, str]:
        require_gemini()
        store = await authorize(request, execution_id, token or x_execution_token)
        parent = await store.get_execution(execution_id)
        if parent is None or parent.status != "completed" or not parent.result:
            raise HTTPException(409, "Only a completed plan can be refined")
        await enforce_capacity(store)
        previous = TravelPlan.model_validate(parent.result)
        new_id, new_token = await store.create_execution(
            kind="refine", request=previous.request.model_dump(mode="json"), parent_id=execution_id, refinement=body.instruction
        )
        request.app.state.orchestrator.start(request.app.state.orchestrator.run_refinement(new_id, previous, body.instruction))
        return {"execution_id": new_id, "access_token": new_token}

    @app.get("/api/executions/{execution_id}")
    async def snapshot(
        execution_id: str,
        request: Request,
        token: str | None = Query(default=None),
        x_execution_token: str | None = Header(default=None),
    ) -> dict[str, Any]:
        store = await authorize(request, execution_id, token or x_execution_token)
        record = await store.get_execution(execution_id)
        assert record is not None
        events = await store.events_after(execution_id, 0)
        return {
            "execution_id": record.id,
            "parent_execution_id": record.parent_id,
            "kind": record.kind,
            "status": record.status,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "request": record.request,
            "refinement_instruction": record.refinement,
            "error": record.error,
            "result": record.result,
            "events": [e.model_dump(mode="json") for e in events],
        }

    @app.get("/api/executions/{execution_id}/events")
    async def stream(
        execution_id: str,
        request: Request,
        token: str | None = Query(default=None),
        last_event_id: int | None = Query(default=None, ge=0),
        last_event_id_header: str | None = Header(default=None, alias="Last-Event-ID"),
    ) -> EventSourceResponse:
        store = await authorize(request, execution_id, token)
        cursor = last_event_id or 0
        if last_event_id_header and last_event_id_header.isdigit():
            cursor = max(cursor, int(last_event_id_header))

        async def generator() -> AsyncIterator[dict[str, str]]:
            nonlocal cursor
            while True:
                for event in await store.events_after(execution_id, cursor):
                    cursor = event.seq
                    yield {"event": "execution_event", "id": str(event.seq), "data": event.model_dump_json()}
                    if event.type in TERMINAL_EVENTS:
                        record = await store.get_execution(execution_id)
                        yield {"event": "end", "data": json.dumps({"status": record.status if record else "unknown"})}
                        store.forget(execution_id)
                        return
                record = await store.get_execution(execution_id)
                if record is None or record.status != "running":
                    # The terminal event is committed atomically with the status change,
                    # so drain once more; only end here if none exists (e.g. restart interruption).
                    if await store.events_after(execution_id, cursor):
                        continue
                    yield {"event": "end", "data": json.dumps({"status": record.status if record else "unknown"})}
                    return
                if await request.is_disconnected():
                    return
                await store.wait_for_new(execution_id, cursor, HEARTBEAT_SECONDS)

        return EventSourceResponse(generator(), ping=HEARTBEAT_SECONDS, headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


def main() -> None:
    import uvicorn

    settings = get_settings()
    logger = configure_logging("coordinator", settings.log_level)
    try:
        settings.validate_gemini()
    except ConfigurationError as exc:
        logger.error("Startup aborted: %s", exc)
        raise SystemExit(2) from exc
    uvicorn.run(create_app(settings), host=settings.agent_host, port=settings.coordinator_port, log_level="warning")


if __name__ == "__main__":
    main()
