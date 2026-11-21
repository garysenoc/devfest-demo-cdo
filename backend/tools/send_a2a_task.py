"""Send one real A2A task straight to a specialist — no coordinator involved.

    cd backend
    uv run python -m tools.send_a2a_task destination
    uv run python -m tools.send_a2a_task budget --url http://localhost:8002
    uv run python -m tools.send_a2a_task itinerary      # first calls destination + budget for inputs

Prints the discovered Agent Card, every streamed protocol event
(Task / TaskStatusUpdateEvent / TaskArtifactUpdateEvent) and the final artifact.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid

import httpx
from a2a.client import ClientConfig, ClientFactory
from a2a.types import Message, Part, Role, SendMessageRequest, TaskState
from google.protobuf.json_format import MessageToDict
from pydantic import BaseModel

from coordinator.discovery import fetch_card
from shared.agent_runtime import parse_json_text
from shared.config import get_settings
from shared.schemas import BudgetPlan, BudgetTask, DestinationResearch, DestinationTask, ItineraryTask, TripRequest

DEMO = TripRequest(
    destination="Cebu",
    days=3,
    travelers=1,
    budget=10000,
    currency="PHP",
    interests=["beaches", "adventure", "local food"],
)


async def send(agent_id: str, url: str, payload: BaseModel, http: httpx.AsyncClient, verbose: bool = True) -> dict:
    found = await fetch_card(agent_id, url, http, timeout=5)  # type: ignore[arg-type]
    card = found.card
    if verbose:
        print(f"\n== Agent Card: {card.name} v{card.version} ({found.latency_ms} ms)")
        print(f"   endpoint : {card.supported_interfaces[0].url}  [{card.supported_interfaces[0].protocol_binding}]")
        print(f"   streaming: {card.capabilities.streaming}")
        for skill in card.skills:
            print(f"   skill    : {skill.id} — {skill.description}")
    client = ClientFactory(ClientConfig(streaming=True, httpx_client=http)).create(card)
    request = SendMessageRequest(
        message=Message(message_id=uuid.uuid4().hex, role=Role.ROLE_USER, parts=[Part(text=payload.model_dump_json())])
    )
    started = time.perf_counter()
    artifact = ""
    print(f"\n-> SendStreamingMessage to {agent_id} ({len(request.message.parts[0].text):,} bytes)")
    async for response in client.send_message(request):
        kind = response.WhichOneof("payload")
        elapsed = f"{time.perf_counter() - started:6.2f}s"
        if kind == "task":
            print(f"<- {elapsed} Task                     id={response.task.id} state={TaskState.Name(response.task.status.state)}")
        elif kind == "status_update":
            st = response.status_update.status
            note = " (+message)" if st.HasField("message") and st.message.parts else ""
            print(f"<- {elapsed} TaskStatusUpdateEvent    state={TaskState.Name(st.state)}{note}")
            if st.state == TaskState.TASK_STATE_FAILED:
                print("   failure:", "".join(p.text for p in st.message.parts))
        elif kind == "artifact_update":
            art = response.artifact_update.artifact
            artifact = "".join(p.text for p in art.parts)
            print(f"<- {elapsed} TaskArtifactUpdateEvent  artifact={art.artifact_id} ({len(artifact):,} chars)")
        else:
            print(f"<- {elapsed} {kind}: {json.dumps(MessageToDict(response))[:200]}")
    if not artifact:
        raise SystemExit("No artifact returned (see failure above).")
    return parse_json_text(artifact)


async def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("agent", choices=["destination", "budget", "itinerary"])
    parser.add_argument("--url", help="Agent base URL (defaults to the configured URL)")
    parser.add_argument("--full", action="store_true", help="Print the full artifact JSON")
    args = parser.parse_args()
    urls = settings.specialist_urls
    url = args.url or urls[args.agent]

    async with httpx.AsyncClient(timeout=httpx.Timeout(10, read=settings.a2a_timeout_seconds)) as http:
        if args.agent == "destination":
            result = await send("destination", url, DestinationTask(request=DEMO), http)
        elif args.agent == "budget":
            result = await send("budget", url, BudgetTask(request=DEMO), http)
        else:
            print("Gathering inputs for the itinerary from the destination and budget agents...")
            dest = DestinationResearch.model_validate(
                await send("destination", urls["destination"], DestinationTask(request=DEMO), http, False)
            )
            budget = BudgetPlan.model_validate(await send("budget", urls["budget"], BudgetTask(request=DEMO), http, False))
            result = await send("itinerary", url, ItineraryTask(request=DEMO, destination_research=dest, budget_plan=budget), http)

    text = json.dumps(result, indent=2, ensure_ascii=False)
    print("\n== Result artifact" + ("" if args.full else " (first 60 lines; --full for all)"))
    print(text if args.full else "\n".join(text.splitlines()[:60]))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
