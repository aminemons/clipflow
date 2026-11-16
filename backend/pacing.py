"""Plan and translate speech-safe jump cuts without modifying source media."""

import math


def _speech_intervals(transcript, start, end):
    spans = []
    for row in transcript:
        a, b = max(start, float(row["start"])), min(end, float(row["end"]))
        if b > a:
            spans.append((a, b))
    merged = []
    for a, b in sorted(spans):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def plan_pause_cuts(clip, transcript, silence_at, *, brisk):
    """Remove only inner gaps supported by both speech timings and audio.

    Keep the edges of each breath, preserve opening and closing handles, and
    bound how many cuts and how much of a first draft may be removed.
    """
    start, end = float(clip["start"]), float(clip["end"])
    if end - start < 5:
        return []
    speech = _speech_intervals(transcript, start, end)
    pad = .18 if brisk else .32
    min_gap = .85 if brisk else 1.25
    gaps = [(left[1], right[0]) for left, right in zip(speech, speech[1:])
            if right[0] - left[1] >= min_gap]
    if not gaps:
        return []
    quiet = silence_at(start, end)
    candidates = []
    for a, b in gaps:
        for low, high in quiet:
            first = round(max(a + pad, low + .08, start + 1), 3)
            last = round(min(b - pad, high - .08, end - 1), 3)
            if last - first >= .38:
                candidates.append((first, last))

    accepted = []
    budget = (end - start) * (.32 if brisk else .23)
    for a, b in sorted(candidates, key=lambda pair: pair[0] - pair[1]):
        if len(accepted) >= 8 or budget < .38:
            break
        if any(a < high + .6 and b > low - .6 for low, high in accepted):
            continue
        if b - a > budget:
            midpoint = (a + b) / 2
            a = math.ceil((midpoint - budget / 2) * 1000) / 1000
            b = math.floor((midpoint + budget / 2) * 1000) / 1000
        if b - a >= .38:
            accepted.append((a, b))
            budget -= b - a
    return [{"start": a, "end": b} for a, b in sorted(accepted)]


def retained_ranges(clip):
    """Return clip-relative intervals, rejecting corrupt stored cut plans."""
    start, end = float(clip["start"]), float(clip["end"])
    cuts = clip.get("pause_cuts") or []
    full = [(0.0, end - start)]
    if not isinstance(cuts, list) or len(cuts) > 8:
        return full
    previous_cut = -1.0
    previous = start
    spans = []
    for cut in cuts:
        if not isinstance(cut, dict):
            return full
        a, b = cut.get("start"), cut.get("end")
        if not (
            isinstance(a, (int, float)) and isinstance(b, (int, float))
            and 0 <= a < b and math.isfinite(b) and previous_cut < a
        ):
            return full
        previous_cut = b
        if not start < a < b < end:
            continue
        spans.append((previous - start, a - start))
        previous = b
    spans.append((previous - start, end - start))
    return spans


def retime_rows(rows, spans):
    """Map source-relative captions to the assembled timeline."""
    output = []
    for a, b, text in rows:
        offset = 0.0
        for low, high in spans:
            first, last = max(a, low), min(b, high)
            if last > first:
                output.append((offset + first - low, offset + last - low, text))
            offset += high - low
    return sorted(output, key=lambda row: row[:2])
