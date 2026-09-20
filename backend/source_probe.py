"""Small, bounded source probes for remote video imports.

The probe only asks yt-dlp for metadata.  It never downloads media and it
never follows a URL outside the provider allowlist used by the import API.
"""

from __future__ import annotations

import math
from urllib.parse import urlparse
from typing import Any


YOUTUBE_HOSTS = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "www.youtu.be",
    }
)
def validate_youtube_url(url: str) -> str:
    """Validate and normalize a YouTube URL accepted by yt-dlp."""
    if not isinstance(url, str):
        raise ValueError("Enter a valid YouTube video URL.")
    candidate = url.strip()
    parsed = urlparse(candidate)
    host = (parsed.hostname or "").lower().rstrip(".")
    if (
        parsed.scheme not in {"https", "http"}
        or parsed.username
        or parsed.password
        or host not in YOUTUBE_HOSTS
        or not parsed.netloc
    ):
        raise ValueError("Enter a valid YouTube video URL.")
    return candidate


def _format_heights(info: dict[str, Any]) -> list[int]:
    heights: set[int] = set()
    for fmt in info.get("formats") or []:
        if not isinstance(fmt, dict):
            continue
        height = fmt.get("height")
        try:
            height = int(height)
        except (TypeError, ValueError):
            continue
        if 0 < height <= 1080 and (fmt.get("vcodec") or "") != "none":
            heights.add(height)
    # Some extractor responses omit ``formats`` but still expose the selected
    # stream's height.  This gives the UI one safe choice in that case.
    if not heights:
        try:
            height = int(info.get("height") or 0)
        except (TypeError, ValueError):
            height = 0
        if 0 < height <= 1080:
            heights.add(height)
    return sorted(heights)


def supported_qualities(info: dict[str, Any]) -> list[int]:
    """Return the actual available video heights up to 1080p."""
    return _format_heights(info)


def _number(value: Any, default: float = 0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) and result >= 0 else default


def probe_youtube(url: str) -> dict[str, Any]:
    """Extract safe, JSON-ready metadata without downloading the source."""
    normalized = validate_youtube_url(url)
    try:
        import yt_dlp  # type: ignore
    except ImportError as exc:
        raise RuntimeError("YouTube support requires yt-dlp") from exc

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 20,
        "retries": 1,
        "js_runtimes": {"node": {}},
    }
    with yt_dlp.YoutubeDL(opts) as downloader:
        info = downloader.extract_info(normalized, download=False)
    if not isinstance(info, dict):
        raise RuntimeError("YouTube returned no video metadata")
    # noplaylist should prevent this, but an extractor can still return an
    # entries wrapper.  Refuse ambiguous data rather than importing a playlist.
    entries = info.get("entries")
    if entries:
        first = next((entry for entry in entries if isinstance(entry, dict)), None)
        if first is None:
            raise RuntimeError("YouTube returned no video metadata")
        info = first
    duration = _number(info.get("duration"))
    width = int(_number(info.get("width")))
    height = int(_number(info.get("height")))
    return {
        "url": normalized,
        "title": str(info.get("title") or "YouTube import")[:200],
        "duration": round(duration, 3),
        "width": width,
        "height": height,
        "qualities": supported_qualities(info),
    }


def format_selector(quality: int) -> str:
    """Select the best AVC stream at or below the requested height.

    The final fallback is still bounded by the requested height.  This avoids
    silently downloading 1080p when the user selected 720p, while allowing
    older MP4-only/VP9-only responses to work when AVC is unavailable.
    """
    if not isinstance(quality, int) or isinstance(quality, bool) or not 1 <= quality <= 1080:
        raise ValueError("quality must be an integer between 1 and 1080")
    bounded = f"[height<={quality}]"
    return (
        f"bestvideo{bounded}[vcodec^=avc1]+bestaudio[ext=m4a]/"
        f"bestvideo{bounded}+bestaudio/"
        f"best{bounded}"
    )
