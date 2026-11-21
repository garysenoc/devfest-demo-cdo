"""Deterministic budget arithmetic.

Gemini estimates the individual line items; totals, contingency, remaining
budget and overrun detection are computed here so they are always exact.
"""

from __future__ import annotations

from shared.schemas import BUDGET_CATEGORIES, BudgetEstimate, BudgetPlan, CategoryTotal, TripRequest


def _money(value: float) -> float:
    return round(value, 2)


def finalize_budget(estimate: BudgetEstimate, request: TripRequest) -> BudgetPlan:
    totals = {category: 0.0 for category in BUDGET_CATEGORIES}
    for item in estimate.line_items:
        totals[item.category] += item.amount

    subtotal = sum(totals.values())
    contingency = subtotal * estimate.contingency_percent / 100
    total = subtotal + contingency
    remaining = request.budget - total
    fixed = totals["transportation"] + totals["accommodation"] + contingency
    daily_allowance = max(0.0, (request.budget - fixed) / request.days)

    return BudgetPlan(
        **estimate.model_dump(),
        currency=request.currency,
        budget=_money(request.budget),
        travelers=request.travelers,
        days=request.days,
        category_totals=[CategoryTotal(category=c, amount=_money(totals[c])) for c in BUDGET_CATEGORIES],
        subtotal=_money(subtotal),
        contingency_amount=_money(contingency),
        total_estimated=_money(total),
        remaining=_money(remaining),
        over_budget=remaining < 0,
        overrun_amount=_money(max(0.0, -remaining)),
        per_person_total=_money(total / request.travelers),
        daily_spend_allowance=_money(daily_allowance),
    )
