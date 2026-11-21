"""Exception hierarchy shared across services.

Messages on these exceptions are considered safe to show to end users; never
put secrets, stack traces or raw provider errors in them.
"""

from __future__ import annotations


class TravelPlannerError(Exception):
    """Base class for all expected, user-presentable errors."""


class ConfigurationError(TravelPlannerError):
    """Missing or invalid configuration detected at startup."""


class AgentDiscoveryError(TravelPlannerError):
    """An Agent Card could not be fetched or failed validation."""

    def __init__(self, agent_id: str, message: str):
        super().__init__(message)
        self.agent_id = agent_id


class RemoteTaskError(TravelPlannerError):
    """A remote A2A task failed, timed out, or returned an invalid result."""

    def __init__(self, agent_id: str, message: str, *, task_id: str | None = None, retryable: bool = True):
        super().__init__(message)
        self.agent_id = agent_id
        self.task_id = task_id
        self.retryable = retryable


class ResultValidationError(RemoteTaskError):
    """A remote agent returned an artifact that does not match its contract."""
