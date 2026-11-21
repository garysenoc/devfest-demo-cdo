"""Unit tests: validation, calculations, events, configuration, agent construction."""

from __future__ import annotations

import json
from datetime import date

import pytest
from pydantic import ValidationError

from agents.budget.agent import build_agent as build_budget
from agents.budget.calculations import finalize_budget
from agents.destination.agent import build_agent as build_destination
from agents.destination.prompts import SPEC as DEST_SPEC
from agents.itinerary.agent import build_agent as build_itinerary
from agents.itinerary.scheduling import finalize_itinerary
from coordinator.agent import build_consolidator, build_refinement_router
from coordinator.consistency import check_consistency
from coordinator.discovery import validate_card
from coordinator.orchestrator import TravelOrchestrator, summarize_budget
from shared.a2a_server import build_agent_card
from shared.agent_runtime import parse_json_text
from shared.config import Settings
from shared.events import ExecutionEvent, sanitize_payload
from shared.exceptions import AgentDiscoveryError, ConfigurationError
from shared.schemas import (
    BudgetEstimate,
    BudgetPlan,
    DestinationResearch,
    DestinationTask,
    ItineraryDraft,
    ItineraryPlan,
    RefinementDecision,
    TravelPlan,
    TripRequest,
)

from .fakes import REFINEMENT_OUTPUT, SUMMARY_OUTPUT, FakeGemini, budget_output, destination_output, itinerary_output

CEBU = {
    "destination": "Cebu",
    "days": 3,
    "travelers": 1,
    "budget": 10000,
    "currency": "php",
    "interests": ["beaches", "Beaches", " adventure "],
}


def cebu() -> TripRequest:
    return TripRequest.model_validate(CEBU)


def budget_plan(request: TripRequest | None = None) -> BudgetPlan:
    request = request or cebu()
    return finalize_budget(BudgetEstimate.model_validate(budget_output(request.model_dump())), request)


def itinerary_plan(request: TripRequest | None = None) -> ItineraryPlan:
    request = request or cebu()
    return finalize_itinerary(ItineraryDraft.model_validate(itinerary_output(request.model_dump())), request)


# --------------------------------------------------------------- input validation
class TestTripRequest:
    def test_normalizes_currency_and_interests(self) -> None:
        r = cebu()
        assert r.currency == "PHP"
        assert r.interests == ["beaches", "adventure"]
        assert r.travel_style == "balanced"

    def test_dates_override_duration(self) -> None:
        r = TripRequest.model_validate({**CEBU, "start_date": "2026-12-01", "end_date": "2026-12-04", "days": 2})
        assert r.days == 4

    @pytest.mark.parametrize(
        "patch",
        [
            {"budget": 0},
            {"budget": -5},
            {"days": 0},
            {"days": 15},
            {"travelers": 0},
            {"currency": "P1P"},
            {"destination": ""},
            {"start_date": "2026-12-05", "end_date": "2026-12-01"},
            {"start_date": "2026-12-01", "end_date": "2027-01-30"},
        ],
    )
    def test_rejects_invalid_input(self, patch: dict) -> None:
        with pytest.raises(ValidationError):
            TripRequest.model_validate({**CEBU, **patch})

    def test_refine_request_bounds(self) -> None:
        from shared.schemas import RefineRequest

        assert RefineRequest(instruction="  cheaper please ").instruction == "cheaper please"
        with pytest.raises(ValidationError):
            RefineRequest(instruction="x")


# --------------------------------------------------------------- budget arithmetic
class TestBudgetCalculations:
    def test_totals_contingency_and_remaining(self) -> None:
        plan = budget_plan()
        totals = {t.category: t.amount for t in plan.category_totals}
        assert totals == {"transportation": 1800, "accommodation": 1800, "food": 1800, "activities": 1800, "miscellaneous": 300}
        assert plan.subtotal == 7500
        assert plan.contingency_amount == 750
        assert plan.total_estimated == 8250
        assert plan.remaining == 1750
        assert not plan.over_budget and plan.overrun_amount == 0
        assert plan.per_person_total == 8250
        assert plan.daily_spend_allowance == pytest.approx((10000 - 1800 - 1800 - 750) / 3, abs=0.01)

    def test_detects_overrun(self) -> None:
        request = TripRequest.model_validate({**CEBU, "budget": 4000})
        plan = budget_plan(request)
        assert plan.over_budget
        assert plan.overrun_amount == 4250
        assert plan.remaining == -4250
        assert plan.daily_spend_allowance == 0  # fixed costs alone exceed the budget

    def test_missing_categories_are_zero(self) -> None:
        estimate = BudgetEstimate(
            line_items=[{"category": "food", "description": "x", "amount": 100, "basis": "y"}],  # type: ignore[list-item]
            contingency_percent=0,
            cost_saving_tips=[],
            assumptions=[],
        )
        plan = finalize_budget(estimate, cebu())
        assert len(plan.category_totals) == 5
        assert plan.total_estimated == 100

    def test_summary_text(self) -> None:
        assert "PHP 1,750 remaining" in summarize_budget(budget_plan())


# --------------------------------------------------------------- itinerary
class TestItinerary:
    def test_sorts_days_and_activities_and_totals(self) -> None:
        r = TripRequest.model_validate({**CEBU, "start_date": "2026-12-01", "end_date": "2026-12-03"})
        plan = itinerary_plan(r)
        assert [d.day for d in plan.days] == [1, 2, 3]
        assert [d.date for d in plan.days] == ["2026-12-01", "2026-12-02", "2026-12-03"]
        assert [a.time_slot for a in plan.days[0].activities] == ["morning", "evening"]
        assert plan.days[0].estimated_cost == 1750
        assert plan.total_estimated_cost == 5250

    def test_trims_extra_days(self) -> None:
        draft = ItineraryDraft.model_validate(itinerary_output({"days": 5}))
        plan = finalize_itinerary(draft, cebu())
        assert len(plan.days) == 3

    def test_consistency_findings(self) -> None:
        r = cebu()
        dest = DestinationResearch.model_validate(destination_output(r.model_dump()))
        findings = check_consistency(r, dest, budget_plan(r), itinerary_plan(r))
        messages = " ".join(f.message for f in findings)
        assert "fits the budget" in messages
        assert "2 of 3 recommended attractions" in messages
        assert all(f.level == "info" for f in findings)

    def test_consistency_flags_problems(self) -> None:
        r = TripRequest.model_validate({**CEBU, "budget": 3000, "days": 4})
        dest = DestinationResearch.model_validate(destination_output(r.model_dump()))
        findings = check_consistency(r, dest, budget_plan(r), itinerary_plan(cebu()))
        warnings = [f.message for f in findings if f.level == "warning"]
        assert any("exceeds the budget" in w for w in warnings)
        assert any("covers 3 day(s) but the trip is 4" in w for w in warnings)


# --------------------------------------------------------------- refinement rules
class TestRefinementRules:
    def test_budget_style_change_forces_budget_and_itinerary(self) -> None:
        decision = RefinementDecision.model_validate({**REFINEMENT_OUTPUT, "rerun_budget": False})
        request, final = TravelOrchestrator.apply_decision(cebu(), decision)
        assert request.travel_style == "budget"
        assert final.rerun_budget and final.rerun_itinerary and not final.rerun_destination

    def test_extra_day_reruns_everything_and_clears_end_date(self) -> None:
        prev = TripRequest.model_validate({**CEBU, "start_date": "2026-12-01", "end_date": "2026-12-03"})
        decision = RefinementDecision.model_validate({**REFINEMENT_OUTPUT, "rerun_budget": False, "travel_style": None, "new_days": 4})
        request, final = TravelOrchestrator.apply_decision(prev, decision)
        assert request.days == 4 and request.end_date is None and request.start_date == date(2026, 12, 1)
        assert final.rerun_destination and final.rerun_budget and final.rerun_itinerary

    def test_new_interest_reruns_destination(self) -> None:
        decision = RefinementDecision.model_validate({**REFINEMENT_OUTPUT, "travel_style": None, "add_interests": ["diving"]})
        request, final = TravelOrchestrator.apply_decision(cebu(), decision)
        assert request.interests[-1] == "diving"
        assert final.rerun_destination


# --------------------------------------------------------------- events + helpers
class TestEventsAndHelpers:
    def test_sanitize_redacts_and_truncates(self) -> None:
        out = sanitize_payload(
            {"api_key": "secret", "nested": {"Authorization": "Bearer x"}, "text": "a" * 5000, "items": list(range(100))}
        )
        assert out["api_key"] == "[redacted]"
        assert out["nested"]["Authorization"] == "[redacted]"
        assert out["text"].endswith("chars truncated]")
        assert len(out["items"]) == 61

    def test_event_defaults(self) -> None:
        e = ExecutionEvent(execution_id="x", type="orchestration", agent_id="coordinator", message="hi")
        assert e.channel == "internal" and e.seq == 0 and len(e.id) == 32
        assert json.loads(e.model_dump_json())["timestamp"].endswith("Z")

    def test_parse_json_text_handles_fences_and_prose(self) -> None:
        assert parse_json_text('```json\n{"a": 1}\n```') == {"a": 1}
        assert parse_json_text('Here you go: {"a": 2} thanks') == {"a": 2}
        with pytest.raises(ValueError):
            parse_json_text("no json")

    def test_task_payload_round_trip(self) -> None:
        task = DestinationTask(request=cebu())
        assert DestinationTask.model_validate_json(task.model_dump_json()) == task

    def test_fixture_outputs_satisfy_contracts(self) -> None:
        from shared.schemas import CoordinatorSummary

        CoordinatorSummary.model_validate(SUMMARY_OUTPUT)
        r = cebu()
        TravelPlan.model_json_schema()  # final plan schema builds
        assert DestinationResearch.model_validate(destination_output(r.model_dump())).attractions


# --------------------------------------------------------------- configuration
class TestConfiguration:
    def test_missing_api_key_is_a_clear_error(self) -> None:
        with pytest.raises(ConfigurationError, match="GOOGLE_API_KEY"):
            Settings(_env_file=None, google_api_key=None).validate_gemini()  # type: ignore[call-arg]

    def test_vertex_requires_project(self) -> None:
        with pytest.raises(ConfigurationError, match="GOOGLE_CLOUD_PROJECT"):
            Settings(_env_file=None, google_genai_use_vertexai=True).validate_gemini()  # type: ignore[call-arg]

    def test_default_urls_and_cors(self) -> None:
        s = Settings(_env_file=None)  # type: ignore[call-arg]
        assert s.specialist_urls == {
            "destination": "http://localhost:8001",
            "budget": "http://localhost:8002",
            "itinerary": "http://localhost:8003",
        }
        assert "http://localhost:3000" in s.cors_origin_list


# --------------------------------------------------------------- agent initialization + cards
class TestAgentsAndCards:
    @pytest.mark.parametrize(
        ("builder", "name", "schema"),
        [
            (build_destination, "destination_research_agent", "DestinationResearch"),
            (build_budget, "budget_planning_agent", "BudgetEstimate"),
            (build_itinerary, "itinerary_planning_agent", "ItineraryDraft"),
            (build_consolidator, "travel_coordinator", "CoordinatorSummary"),
            (build_refinement_router, "refinement_router", "RefinementDecision"),
        ],
    )
    def test_agents_build_with_structured_output(self, builder, name, schema) -> None:
        agent = builder(FakeGemini())
        assert agent.name == name
        assert agent.output_schema.__name__ == schema
        assert agent.instruction and agent.before_agent_callback and agent.after_agent_callback

    def test_agent_card_contents(self) -> None:
        card = build_agent_card(DEST_SPEC, "http://localhost:8001")
        assert card.name == "Destination Research Agent"
        assert card.supported_interfaces[0].url == "http://localhost:8001/"
        assert card.supported_interfaces[0].protocol_binding == "JSONRPC"
        assert card.capabilities.streaming
        assert "application/json" in card.default_output_modes
        validate_card("destination", card)

    def test_card_without_required_skill_is_rejected(self) -> None:
        card = build_agent_card(DEST_SPEC, "http://localhost:8001")
        with pytest.raises(AgentDiscoveryError, match="budget_estimation"):
            validate_card("budget", card)


# --------------------------------------------------------------- Gemini schema compatibility
@pytest.mark.parametrize("builder", [build_destination, build_budget, build_itinerary, build_consolidator, build_refinement_router])
def test_output_schema_is_accepted_by_gemini_sdk(builder) -> None:
    """Every agent's output_schema must convert to a google-genai Schema.

    Regression: Field(gt=...) emits `exclusiveMinimum`, which the SDK's Schema
    (used on the Vertex AI path) rejects, failing the agent at request time.
    """
    from google.genai import _transformers

    schema = builder(FakeGemini()).output_schema
    assert _transformers.t_schema(None, schema) is not None
