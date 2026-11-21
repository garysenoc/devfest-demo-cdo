"""Shared Pydantic contracts.

Three groups of models live here:

1. ``TripRequest`` — validated user input.
2. Agent *output* models (``DestinationResearch``, ``BudgetEstimate``,
   ``ItineraryDraft``, ``CoordinatorSummary``, ``RefinementDecision``). These are
   passed to ADK as ``output_schema`` so Gemini returns structured JSON. They
   deliberately avoid default values so the generated JSON schema stays simple.
3. Finalized artifacts (``BudgetPlan``, ``ItineraryPlan``, ``TravelPlan``) that
   add deterministic, code-computed totals on top of the model output.

Money convention (stated in every prompt and field description):
  * attraction / food costs are PER PERSON
  * budget line items and itinerary activity costs are for the WHOLE GROUP
  * every amount is in the trip currency and is an ESTIMATE.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .events import AgentId

PRICE_DISCLAIMER = (
    "All prices are AI-generated estimates and have not been verified against live "
    "sources. Confirm current prices, opening hours and availability before booking."
)

TravelStyle = Literal["budget", "balanced", "comfort", "luxury"]
TimeOfDay = Literal["morning", "afternoon", "evening", "any"]
TimeSlot = Literal["morning", "afternoon", "evening"]
BudgetCategory = Literal["transportation", "accommodation", "food", "activities", "miscellaneous"]
BUDGET_CATEGORIES: tuple[BudgetCategory, ...] = (
    "transportation",
    "accommodation",
    "food",
    "activities",
    "miscellaneous",
)


# ---------------------------------------------------------------------------
# 1. User input
# ---------------------------------------------------------------------------
class TripRequest(BaseModel):
    """Travel requirements submitted by the user."""

    model_config = ConfigDict(str_strip_whitespace=True)

    destination: str = Field(min_length=2, max_length=100)
    origin: str | None = Field(default=None, max_length=100, description="Starting location")
    start_date: date | None = None
    end_date: date | None = None
    days: int = Field(default=3, ge=1, le=14, description="Trip duration in days")
    travelers: int = Field(default=1, ge=1, le=20)
    budget: float = Field(gt=0, le=100_000_000, description="Total budget for the whole group")
    currency: str = Field(default="PHP", min_length=3, max_length=3)
    interests: list[str] = Field(default_factory=list, max_length=12)
    travel_style: TravelStyle = "balanced"
    preferences: str | None = Field(default=None, max_length=600)

    @field_validator("currency")
    @classmethod
    def _currency_upper(cls, value: str) -> str:
        if not value.isalpha():
            raise ValueError("currency must be a 3-letter ISO code such as PHP or USD")
        return value.upper()

    @field_validator("interests")
    @classmethod
    def _clean_interests(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for item in value:
            item = item.strip()[:40]
            if item and item.lower() not in {c.lower() for c in cleaned}:
                cleaned.append(item)
        return cleaned

    @field_validator("origin", "preferences")
    @classmethod
    def _blank_to_none(cls, value: str | None) -> str | None:
        return value or None

    @model_validator(mode="after")
    def _dates_drive_duration(self) -> TripRequest:
        if self.start_date and self.end_date:
            if self.end_date < self.start_date:
                raise ValueError("return date must be on or after the departure date")
            span = (self.end_date - self.start_date).days + 1
            if span > 14:
                raise ValueError("trips longer than 14 days are not supported")
            self.days = span
        return self


# ---------------------------------------------------------------------------
# 2a. Destination Research Agent output
# ---------------------------------------------------------------------------
class Attraction(BaseModel):
    name: str
    category: str = Field(description="One of: beach, adventure, food, culture, nature, history, nightlife, shopping, relaxation")
    description: str = Field(description="Two sentences maximum")
    area: str = Field(description="Neighbourhood or municipality, used to group nearby stops")
    estimated_cost_per_person: float = Field(ge=0, description="Entrance/activity fee PER PERSON in trip currency (estimate)")
    # Use ge/le only in agent output models: Gemini's response schema (Vertex AI path)
    # rejects exclusiveMinimum/exclusiveMaximum, which gt/lt would generate.
    visit_duration_hours: float = Field(ge=0.25, le=12)
    best_time_of_day: TimeOfDay
    suitable_activities: list[str]
    rationale: str = Field(description="Why this matches the traveler's interests")
    wikipedia_title: str | None = Field(description="Exact English Wikipedia article title if one exists, else null")


class FoodRecommendation(BaseModel):
    name: str
    description: str
    where_to_try: str
    estimated_cost_per_person: float = Field(ge=0)


class DestinationResearch(BaseModel):
    destination_overview: str
    best_areas_to_stay: list[str]
    attractions: list[Attraction] = Field(min_length=1)
    local_food: list[FoodRecommendation]
    getting_around: str
    notes: list[str]


# ---------------------------------------------------------------------------
# 2b. Budget Planning Agent output (+ finalized plan)
# ---------------------------------------------------------------------------
class BudgetLineItem(BaseModel):
    category: BudgetCategory
    description: str
    amount: float = Field(ge=0, description="Cost for the WHOLE GROUP for the WHOLE TRIP, trip currency (estimate)")
    basis: str = Field(description="How the estimate was derived, e.g. '2 nights x 1,500 per room'")


class BudgetEstimate(BaseModel):
    """What the model produces; totals are computed in code afterwards."""

    line_items: list[BudgetLineItem] = Field(min_length=1)
    contingency_percent: float = Field(ge=0, le=25, description="Share of subtotal reserved for contingencies")
    cost_saving_tips: list[str]
    assumptions: list[str]


class CategoryTotal(BaseModel):
    category: BudgetCategory
    amount: float


class BudgetPlan(BudgetEstimate):
    """Finalized budget with deterministic arithmetic."""

    currency: str
    budget: float
    travelers: int
    days: int
    category_totals: list[CategoryTotal]
    subtotal: float
    contingency_amount: float
    total_estimated: float
    remaining: float
    over_budget: bool
    overrun_amount: float
    per_person_total: float
    daily_spend_allowance: float = Field(description="(budget - transport - accommodation - contingency) / days")


# ---------------------------------------------------------------------------
# 2c. Itinerary Planning Agent output (+ finalized plan)
# ---------------------------------------------------------------------------
class ItineraryActivity(BaseModel):
    time_slot: TimeSlot
    start_time: str = Field(description="24h local time HH:MM")
    title: str
    description: str
    location: str
    estimated_cost: float = Field(ge=0, description="Cost for the WHOLE GROUP, trip currency (estimate)")
    transport_note: str = Field(description="How to get here from the previous stop and roughly how long it takes")


class DayDraft(BaseModel):
    day: int = Field(ge=1)
    theme: str
    area_focus: str
    activities: list[ItineraryActivity] = Field(min_length=1)
    notes: list[str]


class ItineraryDraft(BaseModel):
    days: list[DayDraft] = Field(min_length=1)
    general_tips: list[str]


class DayPlan(DayDraft):
    date: str | None
    estimated_cost: float


class ItineraryPlan(BaseModel):
    days: list[DayPlan]
    general_tips: list[str]
    total_estimated_cost: float
    currency: str


# ---------------------------------------------------------------------------
# 2d. Coordinator (local ADK agents)
# ---------------------------------------------------------------------------
class CoordinatorSummary(BaseModel):
    headline: str
    summary: str
    packing_list: list[str]
    local_recommendations: list[str]
    safety_reminders: list[str]
    cost_saving_suggestions: list[str]
    alternative_destinations: list[str]


class RefinementDecision(BaseModel):
    rerun_destination: bool
    rerun_budget: bool
    rerun_itinerary: bool
    new_budget: float | None = Field(description="New total budget if the user asked to change it, else null")
    new_days: int | None = Field(description="New trip length in days if the user asked to change it, else null")
    add_interests: list[str]
    travel_style: TravelStyle | None
    guidance: str = Field(description="Concise instruction forwarded to the specialist agents")
    rationale: str = Field(description="One sentence explaining which agents are needed and why")


# ---------------------------------------------------------------------------
# 3. A2A task payloads (Coordinator -> specialists) and final plan
# ---------------------------------------------------------------------------
class DestinationTask(BaseModel):
    request: TripRequest
    refinement: str | None = None
    previous: DestinationResearch | None = None


class BudgetTask(BaseModel):
    request: TripRequest
    refinement: str | None = None
    previous: BudgetPlan | None = None


class ItineraryTask(BaseModel):
    request: TripRequest
    destination_research: DestinationResearch
    budget_plan: BudgetPlan
    refinement: str | None = None
    previous: ItineraryPlan | None = None


class ConsistencyFinding(BaseModel):
    level: Literal["info", "warning"]
    message: str


class TripOverview(BaseModel):
    destination: str
    start_date: date | None
    end_date: date | None
    days: int
    travelers: int
    currency: str
    budget: float
    estimated_total: float
    remaining: float
    over_budget: bool


class TravelPlan(BaseModel):
    execution_id: str
    parent_execution_id: str | None = None
    refinement_instruction: str | None = None
    request: TripRequest
    overview: TripOverview
    destination: DestinationResearch
    budget: BudgetPlan
    itinerary: ItineraryPlan
    summary: CoordinatorSummary
    consistency: list[ConsistencyFinding]
    agents_invoked: list[AgentId]
    disclaimer: str = PRICE_DISCLAIMER
    generated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class RefineRequest(BaseModel):
    instruction: str = Field(min_length=3, max_length=400)

    @field_validator("instruction")
    @classmethod
    def _strip(cls, value: str) -> str:
        return value.strip()
