"""Short caption cues. Segment timing is divided proportionally, not word-aligned."""
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
