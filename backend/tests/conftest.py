from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from agents.budget.server import create_app as budget_app
from agents.destination.server import create_app as destination_app
from agents.itinerary.server import create_app as itinerary_app
from shared.config import Settings

from .fakes import FakeGemini, ServerThread, free_port

APP_FACTORIES = {"destination": destination_app, "budget": budget_app, "itinerary": itinerary_app}


@pytest.fixture
def start_specialist() -> Iterator[Callable[..., ServerThread]]:
    """Start a real A2A specialist server backed by FakeGemini on a free port."""
    started: list[ServerThread] = []

    def _start(agent_id: str, fake: FakeGemini | None = None) -> ServerThread:
        port = free_port()
        app = APP_FACTORIES[agent_id](model=fake or FakeGemini(), public_url=f"http://127.0.0.1:{port}")
        server = ServerThread(app, port).start()
        started.append(server)
        return server

    yield _start
    for server in started:
        server.stop()


@pytest.fixture(scope="module")
def specialist_cluster() -> Iterator[dict[str, ServerThread]]:
    """All three healthy specialists, shared by a test module."""
    servers: dict[str, ServerThread] = {}
    for agent_id, factory in APP_FACTORIES.items():
        port = free_port()
        servers[agent_id] = ServerThread(factory(model=FakeGemini(delay=0.3), public_url=f"http://127.0.0.1:{port}"), port).start()
    yield servers
    for server in servers.values():
        server.stop()


def make_settings(tmp_path: Path, urls: dict[str, str], **overrides: object) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        google_api_key=None,
        destination_agent_url=urls.get("destination", "http://127.0.0.1:9"),
        budget_agent_url=urls.get("budget", "http://127.0.0.1:9"),
        itinerary_agent_url=urls.get("itinerary", "http://127.0.0.1:9"),
        coordinator_db_path=tmp_path / "test.db",
        a2a_timeout_seconds=20,
        a2a_max_retries=1,
        discovery_timeout_seconds=3,
        **overrides,
    )
