"""Centralized configuration loaded from environment variables / `.env`.

All services (coordinator + specialists) read the same settings object so the
ports, URLs and Gemini configuration are defined in exactly one place.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .exceptions import ConfigurationError

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    """Runtime settings. Every field maps to an upper-case environment variable."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Gemini / Google GenAI -------------------------------------------------
    google_api_key: str | None = Field(default=None, description="Gemini API key from Google AI Studio.")
    google_genai_use_vertexai: bool = Field(default=False, description="Use Vertex AI instead of the Gemini API.")
    google_cloud_project: str | None = None
    google_cloud_location: str | None = None
    gemini_model: str = Field(default="gemini-3.5-flash", description="Model used by every agent.")

    # --- Network layout --------------------------------------------------------
    agent_host: str = Field(default="127.0.0.1", description="Interface the services bind to.")
    agent_public_host: str = Field(default="localhost", description="Host advertised in Agent Cards.")
    coordinator_port: int = 8000
    destination_agent_port: int = 8001
    budget_agent_port: int = 8002
    itinerary_agent_port: int = 8003

    destination_agent_url: str | None = None
    budget_agent_url: str | None = None
    itinerary_agent_url: str | None = None

    # --- Coordinator behaviour -------------------------------------------------
    a2a_timeout_seconds: float = Field(default=180.0, gt=0)
    a2a_max_retries: int = Field(default=1, ge=0, le=5)
    discovery_timeout_seconds: float = Field(default=5.0, gt=0)
    max_concurrent_executions: int = Field(default=4, ge=1, le=50)
    cors_origins: str = Field(default="http://localhost:3000,http://127.0.0.1:3000")
    coordinator_db_path: Path = Field(default=BACKEND_DIR / ".data" / "coordinator.db")
    log_level: str = "INFO"

    @field_validator("log_level")
    @classmethod
    def _upper(cls, value: str) -> str:
        return value.upper()

    # --- Derived helpers -------------------------------------------------------
    def _default_url(self, port: int) -> str:
        return f"http://{self.agent_public_host}:{port}"

    @property
    def specialist_urls(self) -> dict[str, str]:
        return {
            "destination": (self.destination_agent_url or self._default_url(self.destination_agent_port)).rstrip("/"),
            "budget": (self.budget_agent_url or self._default_url(self.budget_agent_port)).rstrip("/"),
            "itinerary": (self.itinerary_agent_url or self._default_url(self.itinerary_agent_port)).rstrip("/"),
        }

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def validate_gemini(self) -> None:
        """Fail fast with an actionable message when Gemini is not configured."""
        if self.google_genai_use_vertexai:
            if not self.google_cloud_project or not self.google_cloud_location:
                raise ConfigurationError(
                    "GOOGLE_GENAI_USE_VERTEXAI=TRUE requires GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION. See README > Installation > Step 4: Gemini setup."
                )
        elif not self.google_api_key:
            raise ConfigurationError(
                "GOOGLE_API_KEY is not set. Create a key at https://aistudio.google.com/apikey, "
                "copy .env.example to .env and set GOOGLE_API_KEY. See README > Installation > Step 4: Gemini setup."
            )
        self.export_genai_env()

    def export_genai_env(self) -> None:
        """google-genai (used by ADK) reads credentials from os.environ."""
        if self.google_api_key:
            os.environ.setdefault("GOOGLE_API_KEY", self.google_api_key)
        os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "TRUE" if self.google_genai_use_vertexai else "FALSE")
        if self.google_cloud_project:
            os.environ.setdefault("GOOGLE_CLOUD_PROJECT", self.google_cloud_project)
        if self.google_cloud_location:
            os.environ.setdefault("GOOGLE_CLOUD_LOCATION", self.google_cloud_location)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
