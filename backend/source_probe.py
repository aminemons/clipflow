"""Small, bounded source probes for remote video imports.

The probe only asks yt-dlp for metadata.  It never downloads media and it
never follows a URL outside the provider allowlist used by the import API.
"""

from __future__ import annotations

import math
import re
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

YTDLP_FAQ_URL = "https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp"


class YouTubeSourceError(RuntimeError):
    """Safe, structured failure returned by either inspect or download."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        operation: str,
        help_url: str | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.operation = operation
        self.help_url = help_url
        self.retryable = retryable

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": str(self),
            "operation": self.operation,
            "help_url": self.help_url,
            "retryable": self.retryable,
        }


def classify_youtube_error(exc: BaseException, operation: str = "inspect") -> YouTubeSourceError:
    """Map noisy yt-dlp/provider errors to stable, safe UI-facing failures.

    yt-dlp errors can contain request URLs, extractor internals, and account
    details. The app only needs a diagnosis and a supported next step, so raw
    provider text is intentionally not copied into the result.
    """
    text = str(exc).lower()
    if re.search(r"sign in to confirm|not a bot|botguard|captcha|confirm you.re a bot", text):
        return YouTubeSourceError(
            "youtube_anti_bot",
            "YouTube rejected this server connection. Retry later, use Clipflow Desktop, or upload a local copy of the video.",
            operation=operation,
            help_url=YTDLP_FAQ_URL,
            retryable=True,
        )
    if re.search(r"private video|sign in to view|login required|age.?restricted|members.?only", text):
        return YouTubeSourceError(
            "youtube_access_required",
            "This YouTube video requires access that the importer cannot use. Choose a public video or import a local file.",
            operation=operation,
            help_url=YTDLP_FAQ_URL,
        )
    if re.search(r"video (?:is )?unavailable|video removed|not available|does not exist|copyright", text):
        return YouTubeSourceError(
            "youtube_unavailable",
            "YouTube reports that this video is unavailable, removed, or restricted. Check the URL and choose another public video.",
            operation=operation,
        )
    if re.search(r"timed out|timeout|temporary failure|connection (?:reset|refused)|network", text):
        return YouTubeSourceError(
            "youtube_network",
            "YouTube could not be reached right now. Check the connection and retry.",
            operation=operation,
            retryable=True,
        )
    if re.search(r"requested format|no suitable format|format not available", text):
        return YouTubeSourceError(
            "youtube_format",
            "YouTube did not provide a compatible stream at the requested quality. Choose a lower quality and retry.",
            operation=operation,
        )
    if re.search(r"javascript runtime|deno|challenge|extractor.*outdated|update yt-dlp", text):
        return YouTubeSourceError(
            "youtube_runtime",
            "The YouTube importer needs its current yt-dlp runtime support. Update the app and retry.",
            operation=operation,
        )
    return YouTubeSourceError(
        "youtube_provider_error",
        f"Could not {operation} the YouTube video. Check the URL and retry, or use a local video file.",
        operation=operation,
        retryable=True,
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


def _browser_retry_options(options: dict[str, Any]) -> dict[str, Any]:
    """Use yt-dlp's supported browser transport for one bounded retry."""
    retry = dict(options)
    try:
        from yt_dlp.networking.impersonate import ImpersonateTarget  # type: ignore

        retry["impersonate"] = ImpersonateTarget(client="chrome")
    except ImportError:
        # The alternate player client is still a useful fallback in minimal
        # installations. Release builds include the browser transport.
        pass
    extractor_args = dict(retry.get("extractor_args") or {})
    extractor_args["youtube"] = {"player_client": ["web_safari"]}
    retry["extractor_args"] = extractor_args
    return retry


def extract_youtube(
    url: str,
    *,
    download: bool,
    options: dict[str, Any],
    operation: str,
) -> dict[str, Any]:
    """Run yt-dlp and retry one anti-bot response with its browser transport.

    The retry changes the request fingerprint and YouTube player client. It
    does not read browser cookies, use a proxy, or loop indefinitely.
    """
    try:
        import yt_dlp  # type: ignore
    except ImportError as exc:
        raise RuntimeError("YouTube support requires yt-dlp") from exc

    first_error: YouTubeSourceError | None = None
    attempt = options
    for index in range(2):
        try:
            with yt_dlp.YoutubeDL(attempt) as downloader:
                info = downloader.extract_info(url, download=download)
            if not isinstance(info, dict):
                raise RuntimeError("YouTube returned no video metadata")
            return info
        except YouTubeSourceError:
            raise
        except Exception as exc:
            classified = classify_youtube_error(exc, operation)
            if index == 0 and classified.code == "youtube_anti_bot":
                first_error = classified
                attempt = _browser_retry_options(options)
                continue
            if first_error and classified.code == "youtube_provider_error":
                raise first_error from exc
            raise classified from exc
    raise first_error or YouTubeSourceError(
        "youtube_provider_error",
        f"Could not {operation} the YouTube video.",
        operation=operation,
        retryable=True,
    )


def _number(value: Any, default: float = 0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) and result >= 0 else default


def probe_youtube(url: str) -> dict[str, Any]:
    """Extract safe, JSON-ready metadata without downloading the source."""
    normalized = validate_youtube_url(url)
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 20,
        "retries": 1,
        "js_runtimes": {"node": {}},
    }
    info = extract_youtube(
        normalized,
        download=False,
        options=opts,
        operation="inspect",
    )
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
