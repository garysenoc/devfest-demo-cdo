"""Expose an ADK agent as an independently running A2A service.

Uses ADK's official ``to_a2a`` helper (google.adk.a2a.utils.agent_to_a2a), which
wires the agent into the a2a-sdk JSON-RPC server via ``A2aAgentExecutor``.
We supply a hand-written Agent Card so skills, examples and I/O modes are
descriptive, and add a ``/health`` route for operational checks.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentProvider, AgentSkill
from a2a.utils.constants import PROTOCOL_VERSION_CURRENT, TransportProtocol
from google.adk.a2a.utils.agent_to_a2a import to_a2a
from google.adk.agents import BaseAgent
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse

ADK_DOCS = "https://adk.dev"


@dataclass(frozen=True)
class SkillSpec:
    id: str
    name: str
    description: str
    tags: list[str]
    examples: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AgentSpec:
    """Static description of a specialist service, rendered into its Agent Card."""

    agent_id: str
    name: str
    description: str
    skills: list[SkillSpec]
    version: str = "1.0.0"


def build_agent_card(spec: AgentSpec, url: str) -> AgentCard:
    rpc_url = url.rstrip("/") + "/"
    return AgentCard(
        name=spec.name,
        description=spec.description,
        version=spec.version,
        documentation_url=ADK_DOCS,
        provider=AgentProvider(organization="AI Travel Planner demo", url="https://github.com/google/adk-python"),
        supported_interfaces=[
            AgentInterface(
                url=rpc_url,
                protocol_binding=TransportProtocol.JSONRPC.value,
                protocol_version=PROTOCOL_VERSION_CURRENT,
            )
        ],
        capabilities=AgentCapabilities(streaming=True, push_notifications=False),
        default_input_modes=["application/json", "text/plain"],
        default_output_modes=["application/json"],
        skills=[
            AgentSkill(
                id=s.id,
                name=s.name,
                description=s.description,
                tags=s.tags,
                examples=s.examples,
                input_modes=["application/json"],
                output_modes=["application/json"],
            )
            for s in spec.skills
        ],
    )


def create_a2a_app(agent: BaseAgent, spec: AgentSpec, *, public_url: str) -> Starlette:
    """Build the Starlette app serving JSON-RPC at ``/`` and the card at
    ``/.well-known/agent-card.json``, plus ``/health``."""
    card = build_agent_card(spec, public_url)
    app = to_a2a(agent, agent_card=card)

    async def health(_: Request) -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "agent_id": spec.agent_id,
                "name": spec.name,
                "agent_card": f"{public_url.rstrip('/')}/.well-known/agent-card.json",
            }
        )

    app.add_route("/health", health, methods=["GET"])
    return app


def run_specialist(agent_id: str, create_app: Callable[[], Starlette], port: int) -> None:
    """Validate configuration, then serve a specialist with uvicorn."""
    import uvicorn

    from .config import get_settings
    from .exceptions import ConfigurationError
    from .logging import configure_logging

    settings = get_settings()
    logger = configure_logging(f"{agent_id}-agent", settings.log_level)
    try:
        settings.validate_gemini()
    except ConfigurationError as exc:
        logger.error("Startup aborted: %s", exc)
        raise SystemExit(2) from exc
    logger.info(
        "Serving %s on http://%s:%s (Agent Card: %s/.well-known/agent-card.json, model %s)",
        agent_id,
        settings.agent_host,
        port,
        settings.specialist_urls[agent_id],
        settings.gemini_model,
    )
    uvicorn.run(create_app(), host=settings.agent_host, port=port, log_level="warning")
