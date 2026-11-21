"""Deterministic cross-checks between the specialists' results.

These run after all agents return, so the coordinator can flag
inconsistencies (e.g. the itinerary costs more than the budget allocates).
"""

from __future__ import annotations

from shared.schemas import BudgetPlan, ConsistencyFinding, DestinationResearch, ItineraryPlan, TripRequest

MAX_ACTIVITIES_PER_DAY = 6
ITINERARY_TOLERANCE = 1.15


def _fmt(amount: float, currency: str) -> str:
    return f"{currency} {amount:,.0f}"


def check_consistency(
    request: TripRequest, destination: DestinationResearch, budget: BudgetPlan, itinerary: ItineraryPlan
) -> list[ConsistencyFinding]:
    findings: list[ConsistencyFinding] = []
    cur = request.currency

    if len(itinerary.days) != request.days:
        findings.append(
            ConsistencyFinding(
                level="warning", message=f"Itinerary covers {len(itinerary.days)} day(s) but the trip is {request.days} day(s)."
            )
        )

    if budget.currency != cur or itinerary.currency != cur:
        findings.append(ConsistencyFinding(level="warning", message="Agents returned amounts in different currencies."))

    if budget.over_budget:
        findings.append(
            ConsistencyFinding(
                level="warning",
                message=f"Estimated total {_fmt(budget.total_estimated, cur)} exceeds the budget by {_fmt(budget.overrun_amount, cur)}. See cost-saving tips.",
            )
        )
    else:
        findings.append(
            ConsistencyFinding(
                level="info",
                message=f"Estimated total {_fmt(budget.total_estimated, cur)} fits the budget with {_fmt(budget.remaining, cur)} to spare.",
            )
        )

    totals = {t.category: t.amount for t in budget.category_totals}
    allocation = totals.get("food", 0) + totals.get("activities", 0) + totals.get("transportation", 0)
    if allocation > 0 and itinerary.total_estimated_cost > allocation * ITINERARY_TOLERANCE:
        findings.append(
            ConsistencyFinding(
                level="warning",
                message=(
                    f"Itinerary activity costs ({_fmt(itinerary.total_estimated_cost, cur)}) exceed the budget's "
                    f"food + activities + transport allocation ({_fmt(allocation, cur)})."
                ),
            )
        )

    for day in itinerary.days:
        if len(day.activities) > MAX_ACTIVITIES_PER_DAY:
            findings.append(
                ConsistencyFinding(level="warning", message=f"Day {day.day} has {len(day.activities)} activities, which may be rushed.")
            )
        starts = [a.start_time for a in day.activities]
        if len(starts) != len(set(starts)):
            findings.append(ConsistencyFinding(level="warning", message=f"Day {day.day} has activities scheduled at the same time."))

    scheduled_text = " ".join(f"{a.title} {a.location}".lower() for d in itinerary.days for a in d.activities)
    scheduled = [a.name for a in destination.attractions if a.name.lower() in scheduled_text]
    findings.append(
        ConsistencyFinding(
            level="info",
            message=f"{len(scheduled)} of {len(destination.attractions)} recommended attractions appear in the itinerary.",
        )
    )
    return findings
