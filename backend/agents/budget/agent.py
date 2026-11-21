"""Budget Planning Agent — Gemini estimates line items, code does the arithmetic."""

from __future__ import annotations

import logging

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.genai import types

from shared.agent_runtime import logging_callbacks, make_finalizer
from shared.config import get_settings
from shared.schemas import BudgetEstimate, BudgetPlan, BudgetTask

from .calculations import finalize_budget
from .prompts import INSTRUCTION, SPEC

logger = logging.getLogger("agents.budget")
_before, _after = logging_callbacks(logger)


def _finalize(estimate: BudgetEstimate, task: BudgetTask) -> BudgetPlan:
    return finalize_budget(estimate, task.request)


def build_agent(model: str | BaseLlm | None = None) -> LlmAgent:
    return LlmAgent(
        name="budget_planning_agent",
        description=SPEC.description,
        model=model or get_settings().gemini_model,
        instruction=INSTRUCTION,
        output_schema=BudgetEstimate,
        generate_content_config=types.GenerateContentConfig(temperature=0.3),
        after_model_callback=make_finalizer(input_model=BudgetTask, output_model=BudgetEstimate, finalize=_finalize, logger=logger),
        before_agent_callback=_before,
        after_agent_callback=_after,
    )
