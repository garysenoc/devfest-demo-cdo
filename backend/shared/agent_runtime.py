"""Helpers used by every ADK agent in this project.

* ``parse_json_text`` — tolerant JSON extraction from model text.
* ``make_finalizer`` — an ADK ``after_model_callback`` that validates the
  model's structured output against a Pydantic contract and applies
  deterministic post-processing (e.g. budget arithmetic) *inside* the agent,
  so the A2A artifact that leaves the service is already validated.
* ``logging_callbacks`` — before/after agent callbacks for execution logging.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable
from typing import Any, TypeVar

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.I)


def parse_json_text(text: str) -> Any:
    """Parse JSON that may be wrapped in Markdown fences or surrounded by prose."""
    cleaned = _FENCE.sub("", text.strip())
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start == -1 or end <= start:
            raise
        return json.loads(cleaned[start : end + 1])


def content_text(content: types.Content | None) -> str:
    if not content or not content.parts:
        return ""
    return "".join(p.text or "" for p in content.parts if not getattr(p, "thought", False))


def make_finalizer(
    *,
    input_model: type[BaseModel],
    output_model: type[T],
    finalize: Callable[[T, Any], BaseModel],
    logger: logging.Logger,
) -> Callable[[CallbackContext, LlmResponse], LlmResponse | None]:
    """Build an after_model_callback that validates + finalizes structured output.

    ``finalize(model_output, task_payload)`` returns the artifact model that will
    be sent back over A2A. Raising here fails the A2A task (the coordinator will
    see TASK_STATE_FAILED and may retry).
    """

    def _callback(callback_context: CallbackContext, llm_response: LlmResponse) -> LlmResponse | None:
        if llm_response.partial or not llm_response.content:
            return None
        text = content_text(llm_response.content)
        if not text.strip():
            return None
        task_payload = input_model.model_validate(parse_json_text(content_text(callback_context.user_content)))
        try:
            draft = output_model.model_validate(parse_json_text(text))
        except (json.JSONDecodeError, ValidationError) as exc:
            logger.warning("Model output failed %s validation: %s", output_model.__name__, exc)
            raise ValueError(f"model output did not match the {output_model.__name__} contract") from exc
        final = finalize(draft, task_payload)
        logger.info("Validated %s and produced %s", output_model.__name__, type(final).__name__)
        return LlmResponse(
            content=types.Content(role="model", parts=[types.Part(text=final.model_dump_json())]),
            usage_metadata=llm_response.usage_metadata,
            finish_reason=llm_response.finish_reason,
        )

    return _callback


AgentCallback = Callable[[CallbackContext], None]


def logging_callbacks(logger: logging.Logger) -> tuple[AgentCallback, AgentCallback]:
    """(before_agent_callback, after_agent_callback) that log each invocation and its duration."""

    def before(callback_context: CallbackContext) -> None:
        callback_context.state["temp:started_at"] = time.perf_counter()
        logger.info("Agent %s started invocation %s", callback_context.agent_name, callback_context.invocation_id)

    def after(callback_context: CallbackContext) -> None:
        started = callback_context.state.get("temp:started_at")
        elapsed = f"{time.perf_counter() - started:.1f}s" if isinstance(started, float) else "n/a"
        logger.info("Agent %s finished invocation %s in %s", callback_context.agent_name, callback_context.invocation_id, elapsed)

    return before, after
