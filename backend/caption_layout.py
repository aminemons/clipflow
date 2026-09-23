"""Short caption cues for aligned speech and older segment-only transcripts."""
import math
import re
from pathlib import Path

FONT_NAMES = {"outfit": "Outfit", "anton": "Anton", "noto-arabic": "Noto Sans Arabic"}


def font_name(key: str, text: str = "") -> str:
    if any("\u0600" <= char <= "\u06ff" for char in text):
        return FONT_NAMES["noto-arabic"]
    return FONT_NAMES.get(key, "Outfit")


def fonts_directory() -> Path:
    root = Path(__file__).resolve().parent.parent
    built = root / "frontend" / "dist" / "fonts"
    return built if built.exists() else root / "frontend" / "public" / "fonts"


def caption_cues(start: float, end: float, text: str, words_per_cue: int = 6):
    words = text.split()
    if not words or end <= start:
        return []
    return [(start + (end - start) * offset / len(words),
             start + (end - start) * min(offset + words_per_cue, len(words)) / len(words),
             " ".join(words[offset:offset + words_per_cue]))
            for offset in range(0, len(words), words_per_cue)]


def word_caption_cues(
    segment: dict,
    start: float,
    end: float,
    words_per_cue: int = 6,
    max_chars: int = 42,
):
    """Use word timing only while it still matches the editable segment text.

    Transcript corrections change ``text`` without realigning ``words``. In that
    case the caller falls back to the corrected text and segment timing rather
    than showing stale recognized words in the export. An empty list means the
    alignment is valid but this clip contains no spoken words from the segment.
    """
    raw = segment.get("words")
    if not isinstance(raw, list) or not raw or end <= start:
        return None
    words = []
    for item in raw:
        if not isinstance(item, dict):
            return None
        try:
            a, b = float(item["start"]), float(item["end"])
        except (KeyError, TypeError, ValueError):
            return None
        text = str(item.get("text", "")).strip()
        if not text or not all(math.isfinite(value) for value in (a, b)) or b <= a:
            return None
        words.append((a, b, text))
    words.sort(key=lambda word: word[0])

    def joined(items):
        return re.sub(r"\s+([,.;:!?%،؛؟])", r"\1", " ".join(item[2] for item in items))

    if " ".join(joined(words).split()) != " ".join(str(segment.get("text", "")).split()):
        return None
    visible = [word for word in words if word[1] > start and word[0] < end]
    cues = []
    batch = []

    def emit(items):
        if not items:
            return
        a, b = max(start, items[0][0]), min(end, items[-1][1])
        if b > a:
            cues.append((a, b, joined(items)))

    for index, word in enumerate(visible):
        proposed = joined([*batch, word])
        # Keep a single long word intact, but start a new cue before adding a
        # word that would make an otherwise multiword cue exceed the cap.
        if batch and (len(batch) >= words_per_cue or len(proposed) > max_chars):
            emit(batch)
            batch = []
        batch.append(word)
        next_gap = visible[index + 1][0] - word[1] if index + 1 < len(visible) else 0
        if (
            next_gap > 0.6
            or re.search(r"[.!?؟،؛,:;]$", word[2])
            or index == len(visible) - 1
        ):
            emit(batch)
            batch = []
    return cues
