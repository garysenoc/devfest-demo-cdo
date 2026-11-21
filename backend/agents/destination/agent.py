"""Destination Research Agent — an ADK LlmAgent with a structured output contract."""

from __future__ import annotations

import logging

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.genai import types

from shared.agent_runtime import logging_callbacks, make_finalizer
from shared.config import get_settings
from shared.schemas import DestinationResearch, DestinationTask

from .prompts import INSTRUCTION, SPEC

logger = logging.getLogger("agents.destination")
_before, _after = logging_callbacks(logger)


def _finalize(draft: DestinationResearch, task: DestinationTask) -> DestinationResearch:
    # Drop duplicate attractions the model sometimes repeats.
    seen: set[str] = set()
    unique = []
    for attraction in draft.attractions:
        key = attraction.name.strip().lower()
        if key not in seen:
            seen.add(key)
            unique.append(attraction)
    return draft.model_copy(update={"attractions": unique})


def build_agent(model: str | BaseLlm | None = None) -> LlmAgent:
    """Create the agent. ``model`` may be a fake BaseLlm in automated tests."""
    return LlmAgent(
        name="destination_research_agent",
        description=SPEC.description,
        model=model or get_settings().gemini_model,
        instruction=INSTRUCTION,
        output_schema=DestinationResearch,
        generate_content_config=types.GenerateContentConfig(temperature=0.6),
        after_model_callback=make_finalizer(
            input_model=DestinationTask, output_model=DestinationResearch, finalize=_finalize, logger=logger
        ),
        before_agent_callback=_before,
        after_agent_callback=_after,
    )
