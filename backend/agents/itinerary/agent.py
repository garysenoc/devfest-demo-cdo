"""Itinerary Planning Agent — consumes the other specialists' results (via the coordinator)."""

from __future__ import annotations

import logging

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.genai import types

from shared.agent_runtime import logging_callbacks, make_finalizer
from shared.config import get_settings
from shared.schemas import ItineraryDraft, ItineraryPlan, ItineraryTask

from .prompts import INSTRUCTION, SPEC
from .scheduling import finalize_itinerary

logger = logging.getLogger("agents.itinerary")
_before, _after = logging_callbacks(logger)


def _finalize(draft: ItineraryDraft, task: ItineraryTask) -> ItineraryPlan:
    return finalize_itinerary(draft, task.request)


def build_agent(model: str | BaseLlm | None = None) -> LlmAgent:
    return LlmAgent(
        name="itinerary_planning_agent",
        description=SPEC.description,
        model=model or get_settings().gemini_model,
        instruction=INSTRUCTION,
        output_schema=ItineraryDraft,
        generate_content_config=types.GenerateContentConfig(temperature=0.5),
        after_model_callback=make_finalizer(input_model=ItineraryTask, output_model=ItineraryDraft, finalize=_finalize, logger=logger),
        before_agent_callback=_before,
        after_agent_callback=_after,
    )
