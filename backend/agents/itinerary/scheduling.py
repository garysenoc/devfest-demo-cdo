"""Deterministic itinerary post-processing: ordering, dates and cost totals."""

from __future__ import annotations

import re
from datetime import timedelta

from shared.schemas import DayPlan, ItineraryDraft, ItineraryPlan, TripRequest

_SLOT_ORDER = {"morning": 0, "afternoon": 1, "evening": 2}
_HHMM = re.compile(r"^(\d{1,2}):(\d{2})")


def _minutes(start_time: str) -> int:
    match = _HHMM.match(start_time.strip())
    if not match:
        return 24 * 60
    return int(match.group(1)) * 60 + int(match.group(2))


def finalize_itinerary(draft: ItineraryDraft, request: TripRequest) -> ItineraryPlan:
    """Sort activities, renumber days, cap at the requested length, attach
    calendar dates and compute per-day and trip totals."""
    ordered_days = sorted(draft.days, key=lambda d: d.day)[: request.days]
    days: list[DayPlan] = []
    for index, day in enumerate(ordered_days, start=1):
        activities = sorted(day.activities, key=lambda a: (_SLOT_ORDER[a.time_slot], _minutes(a.start_time)))
        date = (request.start_date + timedelta(days=index - 1)).isoformat() if request.start_date else None
        days.append(
            DayPlan(
                **day.model_dump(exclude={"day", "activities"}),
                day=index,
                activities=activities,
                date=date,
                estimated_cost=round(sum(a.estimated_cost for a in activities), 2),
            )
        )
    return ItineraryPlan(
        days=days,
        general_tips=draft.general_tips,
        total_estimated_cost=round(sum(d.estimated_cost for d in days), 2),
        currency=request.currency,
    )
