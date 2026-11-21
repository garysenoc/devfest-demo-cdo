"""Remote agent discovery via A2A Agent Cards.

The coordinator never hard-codes what a specialist can do: it fetches the
specialist's card from ``/.well-known/agent-card.json`` with the official
``A2ACardResolver`` and validates the advertised skill, transport and
streaming capability before delegating work.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

import httpx
from a2a.client import A2ACardResolver
from a2a.types import AgentCard
from a2a.utils.constants import AGENT_CARD_WELL_KNOWN_PATH, TransportProtocol
from google.protobuf.json_format import MessageToDict

from shared.events import AgentId
from shared.exceptions import AgentDiscoveryError

from .event_store import EventEmitter

AGENT_NAMES: dict[AgentId, str] = {
    "coordinator": "Travel Coordinator",
    "destination": "Destination Research Agent",
    "budget": "Budget Planning Agent",
    "itinerary": "Itinerary Planning Agent",
}

# The skill each specialist must advertise for the coordinator to delegate to it.
REQUIRED_SKILLS: dict[AgentId, str] = {
    "destination": "destination_research",
    "budget": "budget_estimation",
    "itinerary": "itinerary_planning",
}


@dataclass
class DiscoveredAgent:
    agent_id: AgentId
    base_url: str
    card: AgentCard
    latency_ms: int

    @property
    def card_json(self) -> dict:
        return MessageToDict(self.card)


def card_url(base_url: str) -> str:
    return base_url.rstrip("/") + AGENT_CARD_WELL_KNOWN_PATH


def validate_card(agent_id: AgentId, card: AgentCard) -> None:
    """Raise AgentDiscoveryError unless the card can serve our delegation."""
    skill = REQUIRED_SKILLS[agent_id]
    if skill not in {s.id for s in card.skills}:
        raise AgentDiscoveryError(agent_id, f"Agent Card for {agent_id} does not advertise required skill '{skill}'")
    if not card.capabilities.streaming:
        raise AgentDiscoveryError(agent_id, f"Agent Card for {agent_id} does not declare streaming support")
    if not any(i.protocol_binding == TransportProtocol.JSONRPC.value for i in card.supported_interfaces):
        raise AgentDiscoveryError(agent_id, f"Agent Card for {agent_id} has no JSON-RPC interface")


async def fetch_card(agent_id: AgentId, base_url: str, http: httpx.AsyncClient, timeout: float) -> DiscoveredAgent:
    started = time.perf_counter()
    try:
        card = await asyncio.wait_for(A2ACardResolver(http, base_url).get_agent_card(), timeout)
    except TimeoutError as exc:
        raise AgentDiscoveryError(agent_id, f"Timed out after {timeout:.0f}s fetching {card_url(base_url)}") from exc
    except Exception as exc:  # resolver wraps connection + parse errors
        raise AgentDiscoveryError(agent_id, f"Could not fetch Agent Card from {card_url(base_url)} (is the agent running?)") from exc
    validate_card(agent_id, card)
    return DiscoveredAgent(agent_id, base_url, card, int((time.perf_counter() - started) * 1000))


async def discover(agent_id: AgentId, base_url: str, http: httpx.AsyncClient, timeout: float, emitter: EventEmitter) -> DiscoveredAgent:
    """Fetch + validate a card, emitting discovery events for the dashboard."""
    url = card_url(base_url)
    name = AGENT_NAMES[agent_id]
    await emitter.status(agent_id, "discovering", f"Discovering {name}")
    await emitter.emit(
        "discovery_request",
        "coordinator",
        f"GET {url}",
        channel="a2a",
        target=agent_id,
        message_type="AgentCard",
        direction="request",
        endpoint=url,
    )
    try:
        found = await fetch_card(agent_id, base_url, http, timeout)
    except AgentDiscoveryError as exc:
        await emitter.emit(
            "discovery_response",
            agent_id,
            str(exc),
            channel="a2a",
            target="coordinator",
            status="offline",
            message_type="AgentCard",
            direction="response",
            endpoint=url,
            error=True,
        )
        raise
    skills = ", ".join(s.name for s in found.card.skills)
    await emitter.emit(
        "discovery_response",
        agent_id,
        f"{found.card.name} Agent Card discovered ({skills})",
        channel="a2a",
        target="coordinator",
        status="available",
        payload=found.card_json,
        message_type="AgentCard",
        direction="response",
        endpoint=url,
        duration_ms=found.latency_ms,
    )
    return found
