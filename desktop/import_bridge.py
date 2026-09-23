"""Secure desktop receiver for Clipflow's browser-to-desktop import tickets."""

from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx

LOGGER = logging.getLogger("clipflow.desktop")
DEFAULT_WORKER_ORIGINS = ("https://clipflow-aminemons.swedencentral.cloudapp.azure.com",)
DEFAULT_WEB_ORIGINS = ("https://clipflow-aminemons.vercel.app",)
MAX_VIDEO_BYTES = 500 * 1024 * 1024
TICKET_RE = re.compile(r"^[A-Za-z0-9_-]{20,512}$")


class ImportBridgeError(RuntimeError):
    """An actionable, safe-to-display import failure."""


def _origin(value: str) -> str:
    try:
        parts = urlsplit(value)
        if (parts.scheme != "https" or not parts.hostname or parts.username or
                parts.password or parts.path not in ("", "/") or parts.query or
                parts.fragment):
            raise ValueError
        port = parts.port
    except (ValueError, TypeError):
        raise ImportBridgeError("The Clipflow import link contains an invalid server address.") from None
    host = parts.hostname.lower()
    if not re.fullmatch(r"[a-z0-9.-]+", host):
        raise ImportBridgeError("The Clipflow import link contains an invalid server address.")
    return f"https://{host}" + (f":{port}" if port and port != 443 else "")


def _configured_origins(env_name: str, defaults: tuple[str, ...]) -> set[str]:
    configured = os.environ.get(env_name)
    values = [item.strip() for item in configured.split(",") if item.strip()] if configured else list(defaults)
    try:
        return {_origin(item) for item in values}
    except ImportBridgeError:
        raise ImportBridgeError(f"{env_name} contains an invalid HTTPS origin.") from None


def _parse_link(link: str) -> tuple[str, str]:
    try:
        parts = urlsplit(link)
        query = parse_qs(parts.query, strict_parsing=True)
    except ValueError:
        raise ImportBridgeError("This Clipflow import link is malformed. Create a new link in your browser.") from None
    if parts.scheme != "clipflow" or parts.netloc != "import" or parts.path not in ("", "/"):
        raise ImportBridgeError("This is not a valid Clipflow import link. Create a new link in your browser.")
    if set(query) != {"ticket", "server"} or len(query["ticket"]) != 1 or len(query["server"]) != 1:
        raise ImportBridgeError("This Clipflow import link is incomplete. Create a new link in your browser.")
    ticket, server_value = query["ticket"][0], query["server"][0]
    if not TICKET_RE.fullmatch(ticket):
        raise ImportBridgeError("This Clipflow import ticket is invalid or expired. Create a new link in your browser.")
    server = _origin(server_value)
    if server not in _configured_origins("CLIPFLOW_TRUSTED_WORKER_ORIGINS", DEFAULT_WORKER_ORIGINS):
        raise ImportBridgeError("This import link points to an untrusted server. Open Clipflow and create a new link.")
    return ticket, server


def _valid_youtube_url(value: object) -> str:
    if not isinstance(value, str):
        raise ImportBridgeError("The import service returned an invalid video link.")
    parts = None
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower()
    except ValueError:
        host = ""
    if (parts is None or parts.scheme != "https" or host not in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"}
            or parts.username or parts.password):
        raise ImportBridgeError("The import service did not return a valid YouTube video link.")
    return value


def _download(url: str, target: Path, quality: int) -> Path:
    try:
        import yt_dlp
    except ImportError:
        raise ImportBridgeError("Clipflow cannot download this video because yt-dlp is missing. Reinstall the latest desktop package.") from None

    def limit_hook(data: dict) -> None:
        # Account for concurrently downloading streams and intermediate merge
        # files, not only the currently active yt-dlp fragment.
        current_size = sum(path.stat().st_size for path in target.iterdir() if path.is_file())
        estimate = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        if current_size > MAX_VIDEO_BYTES or estimate > MAX_VIDEO_BYTES:
            raise ImportBridgeError("This video is larger than Clipflow's 500 MB import limit.")

    format_selector = (
        f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/"
        f"best[height<={quality}][ext=mp4]/best[height<={quality}]"
    )
    options = {
        "format": format_selector,
        "merge_output_format": "mp4", "outtmpl": str(target / "video.%(ext)s"),
        "max_filesize": MAX_VIDEO_BYTES, "noplaylist": True, "quiet": True,
        "no_warnings": True, "progress_hooks": [limit_hook],
    }
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            result = downloader.extract_info(url, download=True)
            filepath = Path(downloader.prepare_filename(result))
            if filepath.suffix.lower() != ".mp4":
                filepath = filepath.with_suffix(".mp4")
    except ImportBridgeError:
        raise
    except Exception:
        LOGGER.exception("YouTube download failed")
        raise ImportBridgeError("Clipflow could not download this YouTube video. Check your internet connection and try again.") from None
    if not filepath.is_file():
        raise ImportBridgeError("The downloaded video was not created. Try another YouTube video.")
    if filepath.stat().st_size > MAX_VIDEO_BYTES:
        raise ImportBridgeError("This video is larger than Clipflow's 500 MB import limit.")
    return filepath


def import_ticket(link: str) -> str:
    """Download a ticket-authorized video, upload it, then return editor URL."""
    ticket, server = _parse_link(link)  # validate before any secret is sent
    headers = {"Authorization": f"Bearer {ticket}"}
    try:
        with httpx.Client(timeout=httpx.Timeout(60, read=300)) as client:
            response = client.get(f"{server}/api/desktop-import/ticket", headers=headers)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ImportBridgeError("The import service returned an invalid response. Create a new import link and retry.")
            video_url = _valid_youtube_url(payload.get("url"))
            quality = payload.get("quality")
            if isinstance(quality, bool) or quality not in (360, 720, 1080):
                raise ImportBridgeError("The import service returned invalid video settings.")
            web_origin = _origin(payload.get("web_origin", ""))
            if web_origin not in _configured_origins("CLIPFLOW_TRUSTED_WEB_ORIGINS", DEFAULT_WEB_ORIGINS):
                raise ImportBridgeError("The import service returned an untrusted Clipflow website.")
            with tempfile.TemporaryDirectory(prefix="clipflow-import-") as temporary:
                video_path = _download(video_url, Path(temporary), quality)
                size = video_path.stat().st_size
                if size > MAX_VIDEO_BYTES:
                    raise ImportBridgeError("This video is larger than Clipflow's 500 MB import limit.")
                with video_path.open("rb") as video:
                    uploaded = client.post(
                        f"{server}/api/desktop-import/upload", headers=headers,
                        data={"quality": quality},
                        files={"file": (video_path.name, video, "video/mp4")},
                    )
                uploaded.raise_for_status()
                upload_payload = uploaded.json()
                if not isinstance(upload_payload, dict):
                    raise ImportBridgeError("The import service returned an invalid project response. Contact Clipflow support.")
                project_id = upload_payload.get("project_id")
    except ImportBridgeError:
        raise
    except httpx.HTTPStatusError as exc:
        LOGGER.warning("Desktop import service returned HTTP %s", exc.response.status_code)
        raise ImportBridgeError("Clipflow could not complete this import. The link may have expired; create a new one and retry.") from None
    except (httpx.HTTPError, ValueError, OSError):
        LOGGER.exception("Desktop import failed")
        raise ImportBridgeError("Clipflow could not complete this import. Check your internet connection and try again.") from None
    if not isinstance(project_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", project_id):
        raise ImportBridgeError("The import service returned an invalid project link. Contact Clipflow support.")
    return f"{web_origin}/#/editor/{project_id}"
