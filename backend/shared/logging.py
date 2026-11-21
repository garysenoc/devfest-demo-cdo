"""Consistent log formatting for every service."""

from __future__ import annotations

import logging

_CONFIGURED = False


def configure_logging(service: str, level: str = "INFO") -> logging.Logger:
    global _CONFIGURED
    if not _CONFIGURED:
        logging.basicConfig(
            level=level,
            format=f"%(asctime)s %(levelname)-7s [{service}] %(name)s: %(message)s",
            datefmt="%H:%M:%S",
        )
        # The A2A SDK and httpx are chatty at INFO; keep the demo console readable.
        for noisy in ("httpx", "a2a", "google_genai.models", "google_adk.google.adk.models"):
            logging.getLogger(noisy).setLevel(logging.WARNING)
        _CONFIGURED = True
    return logging.getLogger(service)
