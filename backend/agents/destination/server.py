"""Run the Destination Research Agent as a standalone A2A service.

cd backend && uv run python -m agents.destination.server
curl http://localhost:8001/.well-known/agent-card.json
"""

from __future__ import annotations

from google.adk.models.base_llm import BaseLlm
from starlette.applications import Starlette

from shared.a2a_server import create_a2a_app, run_specialist
from shared.config import get_settings

from .agent import build_agent
from .prompts import SPEC


def create_app(model: str | BaseLlm | None = None, public_url: str | None = None) -> Starlette:
    url = public_url or get_settings().specialist_urls[SPEC.agent_id]
    return create_a2a_app(build_agent(model), SPEC, public_url=url)


def main() -> None:
    run_specialist(SPEC.agent_id, create_app, get_settings().destination_agent_port)


if __name__ == "__main__":
    main()
