"""Small, deterministic motion templates for the libass render pass."""

import unicodedata
from textwrap import wrap

from .caption_layout import font_name


PRESETS = {
    "opening": (5, 0.50, 0.28, 50, "FFFFFF", 3.2),
    "speaker": (4, 0.10, 0.67, 36, "FFFFFF", 4.0),
    "callout": (5, 0.50, 0.21, 48, "FFE9A7", 3.5),
}
MAX_TEXT = 72


def valid_motion_graphic(graphic):
    if graphic is None:
        return True
    if not isinstance(graphic, dict) or set(graphic) != {"preset", "text"}:
        return False
    preset, text = graphic["preset"], graphic["text"]
    return (
        isinstance(preset, str)
        and preset in PRESETS
        and isinstance(text, str)
        and 1 <= len(text.strip()) <= len(text) <= MAX_TEXT
        and all(not unicodedata.category(char).startswith("C") for char in text)
    )


def graphic_dialogue(graphic, height: int) -> str:
    if graphic is None or not valid_motion_graphic(graphic):
        return ""
    align, left, top, size, rgb, seconds = PRESETS[graphic["preset"]]
    # Visible equivalents keep text literal. Only the template emits ASS tags.
    text = graphic["text"].strip().translate(str.maketrans("\\{}", "＼｛｝"))
    family = font_name("outfit", text)
    x, y = round(720 * left), round(height * top)
    bgr = rgb[4:] + rgb[2:4] + rgb[:2]
    # Split long labels into short lines so positioned text stays in frame.
    lines = r"\N".join(wrap(text, width=20))
    tags = (
        f"{{\\an{align}\\move({x},{y+18},{x},{y},0,320)\\fad(140,200)"
        f"\\fn{family}\\fs{size}\\b1\\bord3\\shad1\\1c&H{bgr}&}}"
    )
    return f"Dialogue: 1,0:00:00.00,0:00:{seconds:05.2f},Clip,,0,0,0,,{tags}{lines}\n"
