"""Travel Coordinator orchestration.

Plan flow
---------
1. validate request                      (already a TripRequest)
2. discover the three specialists        (Agent Cards over HTTP, concurrently)
3. Destination + Budget                  (two A2A tasks, concurrently)
4. Itinerary                             (A2A task that depends on 3's results)
5. consolidate                           (coordinator ADK agent + deterministic checks)

Refinement flow
---------------
The coordinator's refinement-router ADK agent decides which specialists must
re-run; only those receive new A2A tasks, the rest of the previous plan is
reused. Itinerary always re-runs when its inputs change.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable
from typing import Any

import httpx
from google.adk.models.base_llm import BaseLlm

from shared.config import Settings
from shared.events import SPECIALIST_IDS, AgentId
from shared.exceptions import RemoteTaskError, TravelPlannerError
from shared.schemas import (
    BudgetPlan,
    BudgetTask,
    CoordinatorSummary,
    DestinationResearch,
    DestinationTask,
    ItineraryPlan,
    ItineraryTask,
    RefinementDecision,
    TravelPlan,
    TripOverview,
    TripRequest,
)

from .a2a_client import RemoteAgentCaller
from .agent import build_consolidator, build_refinement_router, run_structured
from .consistency import check_consistency
from .discovery import AGENT_NAMES, DiscoveredAgent, discover
from .event_store import EventEmitter, ExecutionStore

logger = logging.getLogger("coordinator.orchestrator")


# --------------------------------------------------------------------- summaries
def summarize_destination(r: DestinationResearch) -> str:
    cats = sorted({a.category.lower() for a in r.attractions})
    return f"{len(r.attractions)} attractions ({', '.join(cats[:4])}), {len(r.local_food)} local dishes"


def summarize_budget(b: BudgetPlan) -> str:
    verdict = f"{b.currency} {b.remaining:,.0f} remaining" if not b.over_budget else f"over by {b.currency} {b.overrun_amount:,.0f}"
    return f"Estimated {b.currency} {b.total_estimated:,.0f} of {b.currency} {b.budget:,.0f} ({verdict})"


def summarize_itinerary(i: ItineraryPlan) -> str:
    count = sum(len(d.activities) for d in i.days)
    return f"{len(i.days)} days, {count} scheduled activities, {i.currency} {i.total_estimated_cost:,.0f} in day costs"


def describe_request(r: TripRequest) -> str:
    people = f"{r.travelers} traveler{'s' if r.travelers > 1 else ''}"
    interests = f"; interests: {', '.join(r.interests)}" if r.interests else ""
    return f"{r.days}-day {r.travel_style} trip to {r.destination} for {people}, budget {r.currency} {r.budget:,.0f}{interests}"


def _digest(request: TripRequest, d: DestinationResearch, b: BudgetPlan, i: ItineraryPlan) -> str:
    """Compact JSON digest for the coordinator's own LLM calls (keeps prompts small)."""
    return json.dumps(
        {
            "request": request.model_dump(mode="json"),
            "destination": {
                "overview": d.destination_overview,
                "attractions": [{"name": a.name, "category": a.category, "area": a.area} for a in d.attractions],
                "local_food": [f.name for f in d.local_food],
                "getting_around": d.getting_around,
            },
            "budget": {
                "total_estimated": b.total_estimated,
                "budget": b.budget,
                "remaining": b.remaining,
                "over_budget": b.over_budget,
                "category_totals": {t.category: t.amount for t in b.category_totals},
                "cost_saving_tips": b.cost_saving_tips,
            },
            "itinerary": [{"day": day.day, "theme": day.theme, "area": day.area_focus} for day in i.days],
        }
    )


def fallback_summary(request: TripRequest, budget: BudgetPlan) -> CoordinatorSummary:
    """Used only if the coordinator's own Gemini call fails; specialist results are still real."""
    return CoordinatorSummary(
        headline=f"{request.days} days in {request.destination}",
        summary=summarize_budget(budget) + ".",
        packing_list=[],
        local_recommendations=[],
        safety_reminders=[],
        cost_saving_suggestions=budget.cost_saving_tips,
        alternative_destinations=[],
    )


class TravelOrchestrator:
    def __init__(self, settings: Settings, store: ExecutionStore, http: httpx.AsyncClient, model: str | BaseLlm | None = None):
        self.settings = settings
        self.store = store
        self.http = http
        self.model = model
        self.caller = RemoteAgentCaller(http, timeout=settings.a2a_timeout_seconds, max_retries=settings.a2a_max_retries)
        self._tasks: set[asyncio.Task] = set()

    # ----------------------------------------------------------- lifecycle
    def start(self, coro: Awaitable[None]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def shutdown(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # ------------------------------------------------------------- helpers
    async def _discover(self, emitter: EventEmitter, agent_ids: list[AgentId]) -> dict[AgentId, DiscoveredAgent]:
        urls = self.settings.specialist_urls
        found = await asyncio.gather(
            *(discover(a, urls[a], self.http, self.settings.discovery_timeout_seconds, emitter) for a in agent_ids)
        )
        return {f.agent_id: f for f in found}

    async def _gather_or_raise(self, *aws: Awaitable[Any]) -> list[Any]:
        """Run concurrently; let siblings finish so their events are complete, then raise the first error."""
        results = await asyncio.gather(*aws, return_exceptions=True)
        for r in results:
            if isinstance(r, BaseException):
                raise r
        return list(results)

    async def _consolidate(
        self,
        emitter: EventEmitter,
        execution_id: str,
        request: TripRequest,
        dest: DestinationResearch,
        budget: BudgetPlan,
        itinerary: ItineraryPlan,
        invoked: list[AgentId],
        *,
        parent_id: str | None = None,
        instruction: str | None = None,
    ) -> TravelPlan:
        await emitter.status("coordinator", "running", "Coordinator consolidating results (Gemini via ADK)")
        consistency = check_consistency(request, dest, budget, itinerary)
        await emitter.emit(
            "validation",
            "coordinator",
            f"Cross-checked agent results: {sum(f.level == 'warning' for f in consistency)} warning(s)",
            payload=[f.model_dump() for f in consistency],
        )
        try:
            summary = await run_structured(build_consolidator(self.model), _digest(request, dest, budget, itinerary), CoordinatorSummary)
        except Exception as exc:
            logger.warning("Consolidation agent failed: %r", exc)
            await emitter.emit("orchestration", "coordinator", "Coordinator summary agent failed; using fallback summary")
            summary = fallback_summary(request, budget)
        return TravelPlan(
            execution_id=execution_id,
            parent_execution_id=parent_id,
            refinement_instruction=instruction,
            request=request,
            overview=TripOverview(
                destination=request.destination,
                start_date=request.start_date,
                end_date=request.end_date,
                days=request.days,
                travelers=request.travelers,
                currency=request.currency,
                budget=budget.budget,
                estimated_total=budget.total_estimated,
                remaining=budget.remaining,
                over_budget=budget.over_budget,
            ),
            destination=dest,
            budget=budget,
            itinerary=itinerary,
            summary=summary,
            consistency=consistency,
            agents_invoked=invoked,
        )

    async def _finish_ok(self, emitter: EventEmitter, plan: TravelPlan) -> None:
        await emitter.emit("plan_ready", "coordinator", "Travel plan generated", headline=plan.summary.headline)
        await self.store.finish(
            plan.execution_id,
            result=plan.model_dump(mode="json"),
            final_event=emitter.build("execution_completed", "coordinator", "Execution completed", status="completed"),
        )

    async def _finish_failed(self, emitter: EventEmitter, exc: Exception) -> None:
        if isinstance(exc, TravelPlannerError):
            message = str(exc)
            agent = getattr(exc, "agent_id", None)
            if agent:
                message = f"{AGENT_NAMES.get(agent, agent)}: {message}"
            if isinstance(exc, RemoteTaskError):
                message += " Check that agent's terminal for details (common causes: Gemini credentials or permissions, quota, model or region availability)."
        else:
            logger.exception("Unexpected orchestration failure", exc_info=exc)
            message = "Unexpected coordinator error. Check the coordinator logs for details."
        await self.store.finish(
            emitter.execution_id,
            error=message,
            final_event=emitter.build("execution_failed", "coordinator", f"Execution failed: {message}", status="failed", error=message),
        )

    # ----------------------------------------------------------- plan flow
    async def run_plan(self, execution_id: str, request: TripRequest) -> None:
        emitter = EventEmitter(self.store, execution_id)
        try:
            await emitter.emit(
                "execution_started",
                "coordinator",
                "Coordinator received travel request",
                status="running",
                payload=request.model_dump(mode="json"),
            )
            await emitter.emit("orchestration", "coordinator", f"Validated request: {describe_request(request)}")

            agents = await self._discover(emitter, list(SPECIALIST_IDS))

            await emitter.emit(
                "orchestration",
                "coordinator",
                "Delegating Destination Research and Budget Planning in parallel",
                status="communicating",
            )
            dest, budget = await self._gather_or_raise(
                self.caller.call(
                    agents["destination"],
                    DestinationTask(request=request),
                    DestinationResearch,
                    label=f"Research attractions in {request.destination}",
                    emitter=emitter,
                    summarize=summarize_destination,
                ),
                self.caller.call(
                    agents["budget"],
                    BudgetTask(request=request),
                    BudgetPlan,
                    label=f"Estimate trip costs for {request.currency} {request.budget:,.0f}",
                    emitter=emitter,
                    summarize=summarize_budget,
                ),
            )
            assert isinstance(dest, DestinationResearch) and isinstance(budget, BudgetPlan)

            await emitter.emit(
                "orchestration",
                "coordinator",
                "Research and budget received; forwarding both results to the Itinerary Agent",
                status="communicating",
            )
            itinerary = await self.caller.call(
                agents["itinerary"],
                ItineraryTask(request=request, destination_research=dest, budget_plan=budget),
                ItineraryPlan,
                label=f"Plan {request.days} days using research + budget",
                emitter=emitter,
                summarize=summarize_itinerary,
            )

            plan = await self._consolidate(emitter, execution_id, request, dest, budget, itinerary, list(SPECIALIST_IDS))
            await emitter.status("coordinator", "completed", "Coordinator finished consolidation", summary=plan.summary.headline)
            await self._finish_ok(emitter, plan)
        except asyncio.CancelledError:
            await self.store.finish(execution_id, error="Cancelled: the coordinator is shutting down.")
            raise
        except Exception as exc:
            await self._finish_failed(emitter, exc)

    # ----------------------------------------------------- refinement flow
    async def _decide(self, emitter: EventEmitter, previous: TravelPlan, instruction: str) -> RefinementDecision:
        await emitter.emit("orchestration", "coordinator", "Coordinator analysing refinement request (Gemini via ADK)", status="running")
        payload = json.dumps(
            {
                "instruction": instruction,
                "current_plan": json.loads(_digest(previous.request, previous.destination, previous.budget, previous.itinerary)),
            }
        )
        try:
            decision = await run_structured(build_refinement_router(self.model), payload, RefinementDecision, timeout=60)
        except Exception as exc:
            logger.warning("Refinement router failed: %r", exc)
            await emitter.emit("orchestration", "coordinator", "Refinement router failed; re-running all specialists")
            decision = RefinementDecision(
                rerun_destination=True,
                rerun_budget=True,
                rerun_itinerary=True,
                new_budget=None,
                new_days=None,
                add_interests=[],
                travel_style=None,
                guidance=instruction,
                rationale="Fallback: router unavailable, so every specialist re-runs.",
            )
        return decision

    @staticmethod
    def apply_decision(previous: TripRequest, decision: RefinementDecision) -> tuple[TripRequest, RefinementDecision]:
        """Apply structured changes and enforce dependency rules deterministically."""
        updates: dict = {}
        if decision.new_budget and decision.new_budget > 0 and decision.new_budget != previous.budget:
            updates["budget"] = decision.new_budget
        if decision.new_days and 1 <= decision.new_days <= 14 and decision.new_days != previous.days:
            updates["days"] = decision.new_days
            updates["end_date"] = None  # dates no longer match; keep the start date
        if decision.add_interests:
            updates["interests"] = previous.interests + [i for i in decision.add_interests if i not in previous.interests]
        if decision.travel_style and decision.travel_style != previous.travel_style:
            updates["travel_style"] = decision.travel_style
        request = TripRequest.model_validate({**previous.model_dump(), **updates})

        rerun_dest = decision.rerun_destination or "days" in updates or "interests" in updates
        rerun_budget = decision.rerun_budget or any(k in updates for k in ("budget", "days", "travel_style"))
        rerun_itin = True  # the schedule always reflects the latest inputs
        return request, decision.model_copy(
            update={"rerun_destination": rerun_dest, "rerun_budget": rerun_budget, "rerun_itinerary": rerun_itin}
        )

    async def run_refinement(self, execution_id: str, previous: TravelPlan, instruction: str) -> None:
        emitter = EventEmitter(self.store, execution_id)
        try:
            await emitter.emit(
                "execution_started",
                "coordinator",
                f'Coordinator received refinement: "{instruction}"',
                status="running",
                payload={"instruction": instruction, "parent_execution_id": previous.execution_id},
            )
            raw = await self._decide(emitter, previous, instruction)
            request, decision = self.apply_decision(previous.request, raw)
            selected: list[AgentId] = []
            if decision.rerun_destination:
                selected.append("destination")
            if decision.rerun_budget:
                selected.append("budget")
            if decision.rerun_itinerary:
                selected.append("itinerary")
            await emitter.emit(
                "orchestration",
                "coordinator",
                f"Refinement plan: re-run {', '.join(AGENT_NAMES[a] for a in selected)}. {decision.rationale}",
                payload=decision.model_dump(),
            )
            for agent_id in SPECIALIST_IDS:
                if agent_id not in selected:
                    await emitter.emit("orchestration", "coordinator", f"Reusing previous {AGENT_NAMES[agent_id]} result")

            agents = await self._discover(emitter, selected)
            guidance = decision.guidance or instruction

            jobs: list[Awaitable[Any]] = []
            if decision.rerun_destination:
                jobs.append(
                    self.caller.call(
                        agents["destination"],
                        DestinationTask(request=request, refinement=guidance, previous=previous.destination),
                        DestinationResearch,
                        label=f"Refine attractions: {guidance[:60]}",
                        emitter=emitter,
                        summarize=summarize_destination,
                    )
                )
            if decision.rerun_budget:
                jobs.append(
                    self.caller.call(
                        agents["budget"],
                        BudgetTask(request=request, refinement=guidance, previous=previous.budget),
                        BudgetPlan,
                        label=f"Re-estimate costs: {guidance[:60]}",
                        emitter=emitter,
                        summarize=summarize_budget,
                    )
                )
            dest, budget = previous.destination, previous.budget
            if jobs:
                await emitter.emit("orchestration", "coordinator", "Delegating refinement tasks", status="communicating")
                for result in await self._gather_or_raise(*jobs):
                    if isinstance(result, DestinationResearch):
                        dest = result
                    elif isinstance(result, BudgetPlan):
                        budget = result

            await emitter.emit("orchestration", "coordinator", "Forwarding updated inputs to the Itinerary Agent", status="communicating")
            itinerary = await self.caller.call(
                agents["itinerary"],
                ItineraryTask(
                    request=request, destination_research=dest, budget_plan=budget, refinement=guidance, previous=previous.itinerary
                ),
                ItineraryPlan,
                label=f"Update {request.days}-day schedule: {guidance[:50]}",
                emitter=emitter,
                summarize=summarize_itinerary,
            )
            plan = await self._consolidate(
                emitter, execution_id, request, dest, budget, itinerary, selected, parent_id=previous.execution_id, instruction=instruction
            )
            await emitter.status("coordinator", "completed", "Coordinator finished refinement", summary=plan.summary.headline)
            await self._finish_ok(emitter, plan)
        except asyncio.CancelledError:
            await self.store.finish(execution_id, error="Cancelled: the coordinator is shutting down.")
            raise
        except Exception as exc:
            await self._finish_failed(emitter, exc)
