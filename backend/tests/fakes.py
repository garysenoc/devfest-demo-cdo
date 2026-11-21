"""Test doubles. Used ONLY by automated tests — never by the application.

``FakeGemini`` is an ADK ``BaseLlm`` that returns deterministic, schema-valid
JSON for each agent (detected from the system instruction). Everything else —
ADK runners, A2A servers, A2A clients, HTTP, SSE — is the real implementation.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
from collections.abc import AsyncGenerator
from typing import Any

import uvicorn
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from pydantic import PrivateAttr


def destination_output(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "destination_overview": f"{request['destination']} offers beaches, waterfalls and great street food.",
        "best_areas_to_stay": ["Cebu City", "Moalboal"],
        "attractions": [
            {
                "name": "Kawasan Falls",
                "category": "adventure",
                "description": "Turquoise multi-tier waterfalls. Canyoneering starts upstream.",
                "area": "Badian",
                "estimated_cost_per_person": 1500,
                "visit_duration_hours": 5,
                "best_time_of_day": "morning",
                "suitable_activities": ["canyoneering", "swimming"],
                "rationale": "Matches the adventure interest.",
                "wikipedia_title": "Kawasan Falls",
            },
            {
                "name": "Moalboal Sardine Run",
                "category": "beach",
                "description": "Snorkel with millions of sardines just off the shore.",
                "area": "Moalboal",
                "estimated_cost_per_person": 300,
                "visit_duration_hours": 2,
                "best_time_of_day": "afternoon",
                "suitable_activities": ["snorkeling"],
                "rationale": "Beach and marine life.",
                "wikipedia_title": None,
            },
            {
                "name": "Larsian BBQ",
                "category": "food",
                "description": "Open-air barbecue stalls loved by locals.",
                "area": "Cebu City",
                "estimated_cost_per_person": 250,
                "visit_duration_hours": 1.5,
                "best_time_of_day": "evening",
                "suitable_activities": ["street food"],
                "rationale": "Local food interest.",
                "wikipedia_title": None,
            },
        ],
        "local_food": [
            {"name": "Lechon", "description": "Roast pig", "where_to_try": "Carcar", "estimated_cost_per_person": 300},
            {"name": "Puso", "description": "Hanging rice", "where_to_try": "Larsian", "estimated_cost_per_person": 10},
        ],
        "getting_around": "Ceres buses run to the south; jeepneys and Grab in the city.",
        "notes": ["Bring cash for small vendors."],
    }


def budget_output(request: dict[str, Any]) -> dict[str, Any]:
    days, people = request["days"], request["travelers"]
    return {
        "line_items": [
            {"category": "transportation", "description": "Buses and jeepneys", "amount": 600 * days * people, "basis": "600/day/person"},
            {"category": "accommodation", "description": "Budget hostel", "amount": 900 * max(days - 1, 1), "basis": "900/night"},
            {"category": "food", "description": "Local meals", "amount": 600 * days * people, "basis": "600/day/person"},
            {"category": "activities", "description": "Canyoneering + snorkel", "amount": 1800 * people, "basis": "fees"},
            {"category": "miscellaneous", "description": "SIM and tips", "amount": 300, "basis": "flat"},
        ],
        "contingency_percent": 10,
        "cost_saving_tips": ["Take the bus", "Eat at carinderias"],
        "assumptions": ["Prices as of this year"],
    }


def itinerary_output(request: dict[str, Any]) -> dict[str, Any]:
    return {
        "days": [
            {
                "day": d,
                "theme": f"Day {d} adventures",
                "area_focus": "Badian" if d == 1 else "Moalboal",
                "activities": [
                    {
                        "time_slot": "evening",
                        "start_time": "19:00",
                        "title": "Dinner at Larsian BBQ",
                        "description": "Grilled skewers",
                        "location": "Cebu City",
                        "estimated_cost": 250,
                        "transport_note": "Grab, 20 min",
                    },
                    {
                        "time_slot": "morning",
                        "start_time": "08:00",
                        "title": "Kawasan Falls canyoneering",
                        "description": "Jump and swim",
                        "location": "Badian",
                        "estimated_cost": 1500,
                        "transport_note": "Bus, 3 h",
                    },
                ],
                "notes": ["Bring water shoes"],
            }
            for d in range(request["days"], 0, -1)  # reversed on purpose: finalizer must sort
        ],
        "general_tips": ["Start early"],
    }


SUMMARY_OUTPUT = {
    "headline": "Three sun-soaked days in Cebu",
    "summary": "A beach and adventure trip that fits the budget.",
    "packing_list": ["Reef-safe sunscreen", "Water shoes"],
    "local_recommendations": ["Try puso with BBQ"],
    "safety_reminders": ["Wear a life vest when canyoneering"],
    "cost_saving_suggestions": ["Use Ceres buses"],
    "alternative_destinations": ["Bohol", "Siquijor"],
}

REFINEMENT_OUTPUT = {
    "rerun_destination": False,
    "rerun_budget": True,
    "rerun_itinerary": True,
    "new_budget": None,
    "new_days": None,
    "add_interests": [],
    "travel_style": "budget",
    "guidance": "Reduce costs: cheaper lodging and public transport.",
    "rationale": "Budget and itinerary must change to lower costs.",
}


class FakeGemini(BaseLlm):
    """Deterministic stand-in for Gemini. ``fail_first`` makes the first N calls
    return non-JSON text (exercises A2A failure + retry); ``delay`` simulates latency."""

    model: str = "fake-gemini"
    delay: float = 0.2
    fail_first: int = 0
    _calls: int = PrivateAttr(default=0)

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        await asyncio.sleep(self.delay)
        self._calls += 1
        if self._calls <= self.fail_first:
            yield _text("Sorry, I cannot produce JSON right now.")
            return
        system = str(llm_request.config.system_instruction or "")
        user = _last_user_json(llm_request)
        if "You are the Destination Research Agent" in system:
            body = destination_output(user["request"])
        elif "You are the Budget Planning Agent" in system:
            body = budget_output(user["request"])
        elif "You are the Itinerary Planning Agent" in system:
            body = itinerary_output(user["request"])
        elif "refinement router" in system:
            body = REFINEMENT_OUTPUT
        elif "You are the Travel Coordinator" in system:
            body = SUMMARY_OUTPUT
        else:
            raise AssertionError(f"FakeGemini received an unknown agent prompt: {system[:80]}")
        yield _text(json.dumps(body))


def _text(text: str) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]))


def _last_user_json(llm_request: LlmRequest) -> dict[str, Any]:
    for content in reversed(llm_request.contents):
        if content.role == "user" and content.parts:
            text = "".join(p.text or "" for p in content.parts)
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                continue
    return {}


# ---------------------------------------------------------------------------
# Real HTTP servers on free ports
# ---------------------------------------------------------------------------
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class ServerThread:
    """Run an ASGI app with uvicorn in a background thread (its own event loop)."""

    def __init__(self, app: Any, port: int):
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> ServerThread:
        self.thread.start()
        deadline = time.time() + 15
        while not self.server.started:
            if time.time() > deadline or not self.thread.is_alive():
                raise RuntimeError(f"server on port {self.port} failed to start")
            time.sleep(0.05)
        return self

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=10)
