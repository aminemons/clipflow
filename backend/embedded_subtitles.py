"""Read timed text already present in a source video before loading speech AI."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


TEXT_CODECS = {"subrip", "mov_text", "webvtt", "ass", "ssa", "text"}
TIMING = re.compile(
    r"(?m)^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+"
    r"(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})"
)


def _seconds(groups: tuple[str, ...]) -> float:
    hours, minutes, seconds, millis = map(int, groups)
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def extract_text_subtitles(
    source: Path, streams: list[dict], ffmpeg: str
) -> list[dict[str, float | str]]:
    """Return source-time cues from the first convertible subtitle stream.

    Bitmap subtitle tracks and text burned into video pixels have no extractable
    timed text. On conversion failure, callers fall back to speech recognition.
    """
    subtitles = [s for s in streams if s.get("codec_type") == "subtitle"]
    text_stream = next(
        (s for s in subtitles if s.get("codec_name") in TEXT_CODECS), None
    )
    if text_stream is None:
        return []
    try:
        result = subprocess.run(
            [ffmpeg, "-v", "error", "-i", str(source), "-map",
             f"0:{int(text_stream['index'])}", "-f", "srt", "-"],
            capture_output=True, timeout=60, check=True,
        )
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return []

    content = result.stdout[:5_000_000].decode("utf-8-sig", errors="replace")
    matches = list(TIMING.finditer(content))
    cues = []
    for index, match in enumerate(matches):
        start = _seconds(match.groups()[:4])
        end = _seconds(match.groups()[4:])
        body_end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
        body = content[match.end():body_end].strip()
        body = re.sub(r"\n\s*\d+\s*$", "", body).strip()
        text = re.sub(r"<[^>]*>|\{\\[^}]*\}", "", body).strip()
        if end > start and text:
            cues.append({"start": start, "end": end, "text": text[:4000]})
    return cues
