"""The Travel Coordinator's own Google ADK agents.

The coordinator is itself an ADK application: Gemini-powered LlmAgents
consolidate the specialists' results and route refinement requests. They run
in-process through an ADK ``InMemoryRunner``. Specialist work is never done
here — it is always delegated over A2A (see ``a2a_client.py``).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TypeVar

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.runners import InMemoryRunner
from google.genai import types
from pydantic import BaseModel

from shared.agent_runtime import content_text, logging_callbacks, parse_json_text
from shared.config import get_settings
from shared.schemas import CoordinatorSummary, RefinementDecision

from .prompts import CONSOLIDATION_INSTRUCTION, REFINEMENT_INSTRUCTION

logger = logging.getLogger("coordinator.agent")
_before, _after = logging_callbacks(logger)

T = TypeVar("T", bound=BaseModel)
APP_NAME = "travel_coordinator"


def build_consolidator(model: str | BaseLlm | None = None) -> LlmAgent:
    return LlmAgent(
        name="travel_coordinator",
        description="Consolidates specialist results into a final travel plan summary with travel tips.",
        model=model or get_settings().gemini_model,
        instruction=CONSOLIDATION_INSTRUCTION,
        output_schema=CoordinatorSummary,
        generate_content_config=types.GenerateContentConfig(temperature=0.5),
        before_agent_callback=_before,
        after_agent_callback=_after,
    )


def build_refinement_router(model: str | BaseLlm | None = None) -> LlmAgent:
    return LlmAgent(
        name="refinement_router",
        description="Decides which specialist agents must re-run to apply a user's plan change.",
        model=model or get_settings().gemini_model,
        instruction=REFINEMENT_INSTRUCTION,
        output_schema=RefinementDecision,
        generate_content_config=types.GenerateContentConfig(temperature=0.1),
        before_agent_callback=_before,
        after_agent_callback=_after,
    )


async def run_structured(agent: LlmAgent, payload: str, output_model: type[T], *, timeout: float = 90.0) -> T:
    """Run an ADK agent once and validate its final response."""
    runner = InMemoryRunner(agent=agent, app_name=APP_NAME)
    user_id = "coordinator"
    session = await runner.session_service.create_session(app_name=APP_NAME, user_id=user_id, session_id=uuid.uuid4().hex)
    final_text = ""
    async with asyncio.timeout(timeout):
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session.id,
            new_message=types.Content(role="user", parts=[types.Part(text=payload)]),
        ):
            if event.error_code:
                raise RuntimeError(f"{agent.name} failed: {event.error_code}")
            if event.is_final_response() and event.content:
                final_text = content_text(event.content) or final_text
    if not final_text:
        raise RuntimeError(f"{agent.name} returned no final response")
    return output_model.model_validate(parse_json_text(final_text))
