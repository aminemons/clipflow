"""Serve the locally built portable release, never arbitrary workspace files."""

from fastapi import HTTPException
from fastapi.responses import FileResponse

from .config import ROOT


def register(app):
    artifact = ROOT / "build" / "desktop" / "Clipflow-windows-x64.zip"

    @app.get("/api/desktop")
    def desktop_release():
        ready = artifact.is_file()
        return {
            "available": ready,
            "platform": "Windows 10/11 · x64",
            "size_bytes": artifact.stat().st_size if ready else 0,
            "download_url": "/api/desktop/download" if ready else None,
        }

    @app.get("/api/desktop/download")
    def download_desktop():
        if not artifact.is_file():
            raise HTTPException(404, "Desktop release has not been built on this server. See docs/DESKTOP.md.")
        return FileResponse(artifact, filename=artifact.name, media_type="application/zip")
