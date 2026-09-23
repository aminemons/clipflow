"""Bounded, explainable smart-highlight selection.

The local selector deliberately works from transcript and inexpensive media
signals.  It proposes a small ranked subset of the source rather than trying
to cover the whole recording.  The optional Groq path only ranks already
validated local candidates; a hosted model never gets to choose arbitrary
timestamps.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Callable

import httpx

from . import config, media


Progress = Callable[..., Any]
_WORD_RE = re.compile(r"[\w']+", re.UNICODE)
_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "how",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "so",
    "that",
    "the",
    "this",
    "to",
    "was",
    "we",
    "what",
    "when",
    "where",
    "which",
    "with",
    "you",
    "your",
}


class HighlightError(RuntimeError):
    """Raised when hosted ranking is configured but cannot return valid data."""


def _cancel(
    progress: Progress | None, stage: str = "highlights", value: int = 0
) -> None:
    """Call progress compatibly with both the app's two-argument callback and tests."""
    if progress is None:
        return
    try:
        result = progress(stage, value)
    except TypeError:
        result = progress(value)
    if result is False:
        raise RuntimeError("job cancelled")


def _clean_transcript(transcript: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(transcript, list):
        return rows
    for raw in transcript:
        if not isinstance(raw, dict):
            continue
        try:
            start = float(raw.get("start", 0))
            end = float(raw.get("end", start))
        except (TypeError, ValueError):
            continue
        text = str(raw.get("text", "")).strip()
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or end <= start
            or not text
        ):
            continue
        row = {"start": max(0.0, start), "end": max(0.0, end), "text": text}
        words: list[dict[str, Any]] = []
        raw_words = raw.get("words")
        if isinstance(raw_words, list):
            for raw_word in raw_words:
                if not isinstance(raw_word, dict):
                    continue
                try:
                    word_start = float(raw_word.get("start", 0))
                    word_end = float(raw_word.get("end", word_start))
                except (TypeError, ValueError):
                    continue
                word_text = str(raw_word.get("text", raw_word.get("word", ""))).strip()
                if (
                    math.isfinite(word_start)
                    and math.isfinite(word_end)
                    and word_end > word_start
                    and word_text
                ):
                    word_start = max(row["start"], word_start)
                    word_end = min(row["end"], word_end)
                    if word_end > word_start:
                        words.append(
                            {"start": word_start, "end": word_end, "text": word_text}
                        )
        if words:
            row["words"] = sorted(words, key=lambda word: (word["start"], word["end"]))
        rows.append(row)
    return sorted(rows, key=lambda row: (row["start"], row["end"]))


def _words(text: str) -> list[str]:
    return [x.lower() for x in _WORD_RE.findall(text) if x.lower() not in _STOPWORDS]


def _topic_terms(topic: str) -> set[str]:
    return set(_words(str(topic or "")))


def _topic_score(text: str, terms: set[str]) -> float:
    if not terms:
        return 0.0
    words = set(_words(text))
    # Requiring at most three matches made a long topic prompt score as a
    # perfect hit after only three incidental words.  Five keeps a one-word
    # topic exact while making longer prompts earn their relevance score.
    return min(1.0, len(words & terms) / max(1.0, min(5.0, len(terms))))


def _novelty(text: str, prior: set[str]) -> float:
    words = set(_words(text))
    if not words:
        return 0.0
    return len(words - prior) / len(words)


def _safe_target(target: float, tolerance: float) -> tuple[float, float, float]:
    try:
        desired = float(target)
    except (TypeError, ValueError):
        desired = 30.0
    try:
        # The public contract expresses tolerance as a fraction of target
        # (0.30 means target +/- 30 percent), matching the editor control.
        tol = desired * abs(float(tolerance))
    except (TypeError, ValueError):
        tol = 0.25 * desired
    desired = max(1.0, desired) if math.isfinite(desired) else 30.0
    tol = min(desired * 0.95, max(0.0, tol)) if math.isfinite(tol) else desired * 0.25
    return desired, max(0.2, desired - tol), desired + tol


def _is_cancelled(exc: BaseException) -> bool:
    return exc.__class__.__name__ == "JobCancelled" or "cancel" in str(exc).lower()


def _duration(source: Path, rows: list[dict[str, Any]]) -> float:
    """Probe only when possible; transcript end is a safe structural fallback."""
    try:
        value = float(media.metadata(source)[0])
        if math.isfinite(value) and value > 0:
            return value
    except Exception as exc:
        if _is_cancelled(exc):
            raise
        pass
    return max((float(row["end"]) for row in rows), default=0.0)


def _boundaries(source: Path, duration: float) -> list[float]:
    """Collect scene boundaries and use silence only when scene analysis fails."""
    points: list[float] = [0.0, duration]
    analyzed = False
    try:
        # analyze_segments performs one sparse scene pass and one silence pass
        # internally; reusing its endpoints avoids decoding audio twice.
        points.extend(
            float(x)
            for pair in media.analyze_segments(source, max(1.0, duration / 8))
            for x in pair
        )
        analyzed = len(points) > 2
    except Exception as exc:
        if _is_cancelled(exc):
            raise
    if not analyzed:
        try:
            points.extend(
                float(x) for pair in media.detect_silence(source) for x in pair
            )
        except Exception as exc:
            if _is_cancelled(exc):
                raise
    return sorted(
        {round(max(0.0, min(duration, x)), 3) for x in points if math.isfinite(x)}
    )


def _candidate_windows(
    source: Path,
    rows: list[dict[str, Any]],
    desired: float,
    low: float,
    high: float,
    progress: Progress | None,
    *,
    sentence_context: str = "keep",
) -> list[dict[str, Any]]:
    duration = _duration(source, rows)
    if duration <= 0:
        return []
    # A clip cannot be target length when the source itself is shorter.  Lower
    # the floor only in that case so a 4-second source still yields a safe clip
    # instead of an empty result.
    effective_low = min(low, duration)
    effective_high = min(high, duration)
    try:
        boundaries = _boundaries(source, duration)
    except Exception as exc:
        if _is_cancelled(exc):
            raise
        boundaries = [0.0, duration]
    # Transcript turns are useful hard anchors.  A bounded stride keeps 21m
    # inputs small while still offering alternatives across the whole source.
    anchors = sorted(
        {
            0.0,
            *(float(r["start"]) for r in rows),
            *(float(r["end"]) for r in rows),
            *boundaries,
        }
    )
    stride = max(1.0, desired * 0.42)
    starts = {max(0.0, min(duration, x)) for x in anchors}
    starts.update(
        round(x, 3) for x in [i * stride for i in range(int(duration / stride) + 1)]
    )
    candidates: list[dict[str, Any]] = []
    for index, start in enumerate(sorted(starts)):
        _cancel(
            progress, "highlights", min(65, 15 + int(index / max(1, len(starts)) * 50))
        )
        # Prefer the nearest boundary but preserve exact target when no boundary
        # exists.  All windows are bounded to source duration.
        possible = [
            end
            for end in anchors
            if start + effective_low <= end <= min(duration, start + effective_high)
        ]
        end = (
            min(possible, key=lambda x: abs(x - (start + desired)))
            if possible
            else min(duration, start + desired)
        )
        if end <= start + 0.5:
            continue
        overlapping = [r for r in rows if r["end"] > start and r["start"] < end]
        if sentence_context == "keep" and overlapping:
            # Transcript segments are the finest reliable timing unit we have.
            # Expand only when the complete boundary segment still fits the
            # requested window; this avoids silently truncating a caption turn.
            expanded_start = min(start, overlapping[0]["start"])
            expanded_end = max(end, overlapping[-1]["end"])
            if expanded_end - expanded_start <= effective_high + 0.05:
                start, end = expanded_start, expanded_end
        text_rows = (
            overlapping
            if sentence_context == "keep"
            else [r for r in overlapping if r["start"] >= start and r["end"] <= end]
        )
        # Keep whole transcript turns where they fit. Word timings can remove
        # only the non-speech padding around those turns.
        if sentence_context == "keep" and text_rows:
            first_words = text_rows[0].get("words", [])
            last_words = text_rows[-1].get("words", [])
            if first_words:
                start = max(start, first_words[0]["start"])
            if last_words:
                end = min(end, last_words[-1]["end"])
        text = " ".join(r["text"] for r in text_rows).strip()
        dur = end - start
        if dur < effective_low - 0.05 or dur > effective_high + 0.05:
            continue
        if text_rows:
            first_row_words = text_rows[0].get("words") or []
            last_row_words = text_rows[-1].get("words") or []
            first_edge = (
                first_row_words[0]["start"] if first_row_words else text_rows[0]["start"]
            )
            last_edge = (
                last_row_words[-1]["end"] if last_row_words else text_rows[-1]["end"]
            )
        else:
            first_edge, last_edge = start, end
        complete = start <= first_edge + 0.05 and end >= last_edge - 0.05
        speech = sum(
            max(0.0, min(end, r["end"]) - max(start, r["start"])) for r in text_rows
        )
        density = min(1.0, speech / max(dur, 1.0))
        words = _words(text)
        info = min(1.0, len(set(words)) / max(8.0, desired * 1.7))
        topic = _topic_score(text, _topic_terms(""))
        # A deterministic title/reason is generated from observed transcript.
        first = " ".join(text.split()[:9]).rstrip(".,:;!? ")
        title = first[:72] or "Visual moment"
        candidates.append(
            {
                "id": len(candidates),
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                "duration": dur,
                "density": density,
                "info": info,
                "topic": topic,
                "complete": complete,
                "title": title,
            }
        )
    return candidates


def _rank_candidates(
    candidates: list[dict[str, Any]], topic: str
) -> list[dict[str, Any]]:
    terms = _topic_terms(topic)
    seen: set[str] = set()
    for candidate in candidates:
        text = candidate["text"]
        candidate["topic"] = _topic_score(text, terms)
        candidate["topic_terms"] = bool(terms)
        candidate["novelty"] = _novelty(text, seen)
        seen.update(_words(text))
        target = candidate.get("target")
        try:
            target_value = float(target)
            duration = float(candidate.get("duration", 0.0))
            duration_fit = max(
                0.0,
                1.0 - abs(duration - target_value) / max(target_value, 1.0),
            )
        except (TypeError, ValueError):
            duration_fit = 0.0
        candidate["duration_fit"] = duration_fit
        # Topic/relevance dominates; speech and lexical variety make silent or
        # repetitive intervals naturally rank below useful passages.
        candidate["score"] = round(
            max(
                0.0,
                0.42 * candidate["topic"]
                + 0.22 * candidate["density"]
                + 0.20 * candidate["info"]
                + 0.10 * candidate["novelty"]
                + 0.06 * duration_fit
                - (0.25 if candidate.get("complete") is False else 0.0),
            ),
            4,
        )
    return sorted(candidates, key=lambda x: (-x["score"], x["start"]))


def _overlap(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Return overlap seconds; 100ms is the duplicate-window tolerance."""
    return max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))


def _select(
    candidates: list[dict[str, Any]], max_clips: int, topic: str
) -> list[dict[str, Any]]:
    try:
        limit = max(0, int(max_clips))
    except (TypeError, ValueError):
        limit = 0
    ranked = _rank_candidates(candidates, topic)
    # With no speech (or no transcript), every interval has the same evidence.
    # Pick temporal quantiles so structural fallback samples the source rather
    # than returning the first adjacent windows.
    if ranked and max(float(c.get("score", 0.0)) for c in ranked) <= 0.02:
        by_time = sorted(ranked, key=lambda x: x["start"])
        spread: list[dict[str, Any]] = []
        for index in range(min(limit, len(by_time))):
            wanted = (index + 0.5) / max(1, limit) * max(c["end"] for c in by_time)
            options = [c for c in by_time if c not in spread]
            if options:
                spread.append(
                    min(
                        options, key=lambda c: abs((c["start"] + c["end"]) / 2 - wanted)
                    )
                )
        ranked = spread + [c for c in ranked if c not in spread]
    selected: list[dict[str, Any]] = []
    for candidate in ranked:
        if len(selected) >= limit:
            break
        if any(
            _overlap(candidate, prior) > 0.1
            or (candidate["text"] and candidate["text"] == prior["text"])
            for prior in selected
        ):
            continue
        selected.append(candidate)
    return sorted(selected, key=lambda x: x["start"])


def _select_in_rank_order(
    candidates: list[dict[str, Any]], max_clips: int
) -> list[dict[str, Any]]:
    """Apply local overlap/count checks without replacing the provider ranking."""
    try:
        limit = max(0, int(max_clips))
    except (TypeError, ValueError):
        limit = 0
    selected: list[dict[str, Any]] = []
    for candidate in candidates:
        if len(selected) >= limit:
            break
        if any(
            _overlap(candidate, prior) > 0.1
            or (candidate["text"] and candidate["text"] == prior["text"])
            for prior in selected
        ):
            continue
        selected.append(candidate)
    # The UI consumes clips chronologically; ranking determines which survive.
    return sorted(selected, key=lambda x: x["start"])


def _model_candidate_context(
    candidates: list[dict[str, Any]], topic: str
) -> list[dict[str, Any]]:
    """Balance strong local candidates with coverage of the whole recording."""
    ranked = _rank_candidates(candidates, topic)
    selected: list[dict[str, Any]] = []

    def add(candidate: dict[str, Any]) -> bool:
        if any(_overlap(candidate, prior) > 0.1 for prior in selected):
            return False
        selected.append(candidate)
        return True

    # Reserve ten places for later parts of long sources; the heuristic can
    # otherwise fill a model request with passages from one dense conversation.
    for candidate in ranked:
        add(candidate)
        if len(selected) >= 20:
            break
    source_end = max((float(candidate["end"]) for candidate in ranked), default=0.0)
    for index in range(10):
        midpoint = (index + 0.5) / 10 * source_end
        for candidate in sorted(
            ranked,
            key=lambda item: abs((item["start"] + item["end"]) / 2 - midpoint),
        ):
            if add(candidate):
                break
    for candidate in ranked:
        if len(selected) >= 30:
            break
        add(candidate)
    # Thirty 300-character excerpts leave ample room below the text adapter's
    # 100 KB request cap, including escaped Unicode and metadata.
    return selected


def _public(candidate: dict[str, Any]) -> dict[str, Any]:
    text = candidate.get("text", "")
    reason_bits = []
    if candidate.get("topic", 0) >= 0.25:
        reason_bits.append("matches the requested topic")
    if candidate.get("density", 0) >= 0.5:
        reason_bits.append("contains sustained speech")
    if candidate.get("info", 0) >= 0.35:
        reason_bits.append("introduces several distinct terms")
    if candidate.get("complete") is False:
        reason_bits.append("review the start and end for a cut-off thought")
    reason = "; ".join(reason_bits) or (
        "structural fallback because no transcript keyword matched the topic"
        if candidate.get("topic_terms")
        else "selected from a distinct source interval"
    )
    return {
        "start": candidate["start"],
        "end": candidate["end"],
        "title": candidate["title"],
        "reason": reason,
        "score": float(candidate.get("score", 0.0)),
    }


def _hosted_rank(
    candidates: list[dict[str, Any]],
    topic: str,
    max_clips: int,
    progress: Progress | None,
) -> list[dict[str, Any]]:
    key = config.value("GROQ_API_KEY")
    if not key:
        raise HighlightError("GROQ_API_KEY is required for hosted highlights")
    model = config.value("GROQ_HIGHLIGHT_MODEL", "llama-3.3-70b-versatile")
    # Send only bounded candidate text. The model chooses IDs; local
    # timestamps remain authoritative and are checked again below.
    ranked = _model_candidate_context(candidates, topic)
    payload_candidates = [
        {
            "id": candidate["id"],
            "start": candidate["start"],
            "end": candidate["end"],
            "complete": candidate.get("complete", True),
            "text": candidate["text"][:300],
        }
        for candidate in ranked
    ]
    sent_by_id = {c["id"]: c for c in ranked}
    body = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    'Return JSON object {"ids":[integer]}. Rank candidate IDs from best to worst; '
                    "choose podcast moments with a clear hook, enough context to understand the setup, "
                    "and a satisfying payoff. Prefer a complete thought and a natural ending; reject "
                    "clips that start mid-sentence, cut off a punchline, or need missing context. "
                    "Choose only supplied IDs, return no timestamps, and return at most max_clips IDs."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "topic": str(topic)[:200],
                        "max_clips": max_clips,
                        "candidates": payload_candidates,
                    },
                    ensure_ascii=False,
                ),
            },
        ],
    }
    _cancel(progress, "highlights", 70)
    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
    except Exception as exc:
        raise HighlightError(
            f"Groq highlight request failed: {exc.__class__.__name__}"
        ) from exc
    if response.status_code in (401, 403):
        raise HighlightError("Groq rejected GROQ_API_KEY")
    if response.status_code >= 400:
        raise HighlightError(
            f"Groq highlight request failed with HTTP {response.status_code}"
        )
    try:
        outer = response.json()
        content = outer["choices"][0]["message"]["content"]
        if isinstance(content, str):
            # Some OpenAI-compatible gateways wrap JSON in a markdown fence.
            content = re.sub(
                r"^\s*```(?:json)?\s*|\s*```\s*$", "", content, flags=re.IGNORECASE
            )
        data = json.loads(content) if isinstance(content, str) else content
        ids = data.get("ids") if isinstance(data, dict) else None
        if not isinstance(ids, list):
            raise ValueError("ids must be a list")
        by_id = sent_by_id
        chosen = []
        for item in ids:
            if isinstance(item, bool) or not isinstance(item, int) or item not in by_id:
                continue
            if by_id[item] not in chosen:
                chosen.append(by_id[item])
        if payload_candidates and not chosen:
            raise HighlightError("Groq returned no valid highlight IDs")
        return _select_in_rank_order(chosen, max_clips)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HighlightError("Groq returned malformed highlight JSON") from exc


def _model_rank(candidates, topic, max_clips, provider, progress):
    from .language_models import generate_json

    ranked = _model_candidate_context(candidates, topic)
    _cancel(progress, "Ranking transcript passages", 70)
    data = generate_json(
        provider,
        (
            "Rank candidate IDs from best to worst. Select podcast moments with a clear hook, "
            "enough context to understand the setup, and a satisfying payoff. Prefer a complete "
            "thought and natural ending; avoid starts mid-sentence, cut-off punchlines, and clips "
            'needing missing context. Return only {"ids":[integer]} using supplied IDs, with no '
            "timestamps, at most max_clips IDs."
        ),
        {
            "topic": topic[:500],
            "max_clips": max_clips,
            "candidates": [
                {
                    "id": candidate["id"],
                    "start": candidate["start"],
                    "end": candidate["end"],
                    "complete": candidate.get("complete", True),
                    "text": candidate["text"][:300],
                }
                for candidate in ranked
            ],
        },
    )
    ids = data.get("ids")
    if not isinstance(ids, list):
        raise HighlightError("The provider did not return highlight IDs.")
    by_id = {c["id"]: c for c in ranked}
    chosen = []
    for ident in ids:
        if type(ident) is int and ident in by_id and by_id[ident] not in chosen:
            chosen.append(by_id[ident])
    if not chosen:
        raise HighlightError(
            "The provider returned no valid candidates. Try another topic or local analysis."
        )
    return _select_in_rank_order(chosen, max_clips)


def suggest_highlights(
    source: Path,
    transcript: list[dict],
    target: float,
    max_clips: int,
    tolerance: float,
    topic: str = "",
    provider: str = "local",
    progress: Progress | None = None,
    *,
    strict_max: float | None = None,
    sentence_context: str = "keep",
) -> list[dict]:
    """Return at most ``max_clips`` bounded highlight records.

    Every interval is generated locally and checked against source bounds and
    target tolerance. ``provider='groq'`` changes ranking only; missing keys and
    malformed responses fail clearly instead of silently accepting timestamps.
    """
    source = Path(source)
    provider_name = str(provider or "local").lower()
    if provider_name not in {"local", "groq", "openai", "anthropic", "gemini", "ollama"}:
        raise HighlightError(f"Unknown highlight provider: {provider}")
    rows = _clean_transcript(transcript)
    if sentence_context not in {"keep", "discard"}:
        raise HighlightError("sentence_context must be keep or discard")
    desired, low, high = _safe_target(target, tolerance)
    if strict_max is not None:
        try:
            hard_max = float(strict_max)
        except (TypeError, ValueError):
            raise HighlightError("strict_max must be a number")
        if not math.isfinite(hard_max) or hard_max <= 0:
            raise HighlightError("strict_max must be a positive number")
        high = min(high, hard_max)
        low = min(low, high)
    _cancel(progress, "highlights", 5)
    candidates = _candidate_windows(
        source,
        rows,
        desired,
        low,
        high,
        progress,
        sentence_context=sentence_context,
    )
    try:
        limit = max(0, int(max_clips))
    except (TypeError, ValueError):
        limit = 0
    if limit == 0 or not candidates:
        _cancel(progress, "highlights", 100)
        return []
    for candidate in candidates:
        candidate["target"] = desired
    selected = (
        _hosted_rank(candidates, topic, max_clips, progress)
        if provider_name == "groq"
        else _model_rank(candidates, topic, max_clips, provider_name, progress)
        if provider_name != "local" else _select(candidates, max_clips, topic)
    )
    result = []
    duration = _duration(source, rows)
    for candidate in selected:
        # Defensive validation makes future changes unable to leak bad host data.
        start, end = float(candidate["start"]), float(candidate["end"])
        minimum = min(low, duration) if duration > 0 else low
        if not (
            0 <= start < end <= duration + 0.05
            and minimum - 0.05 <= end - start <= high + 0.05
        ):
            continue
        result.append(_public(candidate))
    _cancel(progress, "highlights", 100)
    return result
