"""Launcher alias kept for `uvicorn backend.main:app` deployments."""

from .app import app

__all__ = ["app"]
