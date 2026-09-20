from pathlib import Path

import httpx
import pytest

from backend import highlights


def _local_media(monkeypatch, duration=30.0):
    monkeypatch.setattr(
        highlights.media, "metadata", lambda _: (duration, 1280, 720, 30.0)
    )
    monkeypatch.setattr(highlights.media, "detect_silence", lambda _: [])
    monkeypatch.setattr(
        highlights.media, "analyze_segments", lambda *_args, **_kwargs: []
    )


def test_topic_changes_the_selected_interval(monkeypatch, tmp_path):
    _local_media(monkeypatch, 20)
    source = tmp_path / "source.mp4"
    source.touch()
    transcript = [
        {"start": 0, "end": 5, "text": "Football defenders protect the goal"},
        {"start": 10, "end": 15, "text": "Baking bread needs yeast and heat"},
    ]
    football = highlights.suggest_highlights(source, transcript, 5, 1, 0.2, "football")
    baking = highlights.suggest_highlights(source, transcript, 5, 1, 0.2, "baking")
    assert football and baking
    assert football[0]["start"] < 8
    assert baking[0]["start"] >= 8
    assert "matches the requested topic" in baking[0]["reason"]


def test_long_topic_requires_more_than_three_incidental_words():
    terms = highlights._topic_terms("alpha beta gamma delta epsilon zeta")
    assert highlights._topic_score("alpha beta gamma unrelated", terms) < 1.0
    assert highlights._topic_score(
        "alpha beta gamma delta epsilon", terms
    ) == 1.0


def test_local_score_prefers_clip_near_requested_duration():
    candidates = [
        {
            "id": 0,
            "start": 0.0,
            "end": 4.0,
            "duration": 4.0,
            "text": "same useful passage",
            "density": 1.0,
            "info": 0.5,
        },
        {
            "id": 1,
            "start": 8.0,
            "end": 10.0,
            "duration": 2.0,
            "text": "same useful passage",
            "density": 1.0,
            "info": 0.5,
        },
    ]
    for candidate in candidates:
        candidate["target"] = 4.0
    ranked = highlights._rank_candidates(candidates, "useful")
    assert ranked[0]["id"] == 0


def test_source_bounds_tolerance_and_no_duplicate_intervals(monkeypatch, tmp_path):
    _local_media(monkeypatch, 10)
    source = tmp_path / "source.mp4"
    source.touch()
    rows = [
        {"start": 0, "end": 4, "text": "A useful introduction"},
        {"start": 0, "end": 4, "text": "A useful introduction"},
        {"start": 8, "end": 18, "text": "Text beyond the source"},
    ]
    result = highlights.suggest_highlights(source, rows, 5, 8, 0.2, "")
    assert len(result) <= 8
    assert len({(row["start"], row["end"]) for row in result}) == len(result)
    assert all(0 <= row["start"] < row["end"] <= 10.05 for row in result)
    assert all(3.95 <= row["end"] - row["start"] <= 6.05 for row in result)


def test_strict_max_caps_smart_windows(monkeypatch, tmp_path):
    _local_media(monkeypatch, 20)
    source = tmp_path / "source.mp4"
    source.touch()
    result = highlights.suggest_highlights(
        source,
        [{"start": 0, "end": 4, "text": "A complete sentence."}],
        5,
        1,
        0.2,
        "",
        "local",
        None,
        strict_max=4.5,
        sentence_context="keep",
    )
    assert result
    assert all(row["end"] - row["start"] <= 4.55 for row in result)


def test_short_silent_source_is_safe(monkeypatch, tmp_path):
    _local_media(monkeypatch, 3)
    source = tmp_path / "silent.mp4"
    source.touch()
    result = highlights.suggest_highlights(source, [], 10, 2, 2, "")
    assert len(result) == 1
    assert result[0]["start"] == 0
    assert result[0]["end"] == 3
    assert result[0]["reason"]


class _FakeClient:
    response = httpx.Response(
        200, json={"choices": [{"message": {"content": '{"ids":[0]}'}}]}
    )

    def __init__(self, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, *_args, **_kwargs):
        return self.response


def test_hosted_selection_only_accepts_valid_candidate_ids(monkeypatch, tmp_path):
    _local_media(monkeypatch, 20)
    source = tmp_path / "source.mp4"
    source.touch()
    monkeypatch.setattr(
        highlights.config,
        "value",
        lambda name, default="": "secret" if name == "GROQ_API_KEY" else default,
    )
    monkeypatch.setattr(highlights.httpx, "Client", _FakeClient)
    _FakeClient.response = httpx.Response(
        200, json={"choices": [{"message": {"content": '{"ids":[999, 0, 0, "1"]}'}}]}
    )
    result = highlights.suggest_highlights(
        source, [{"start": 0, "end": 5, "text": "A real passage"}], 5, 2, 1, "", "groq"
    )
    assert result and result[0]["start"] == 0
    assert all(
        set(item) == {"start", "end", "title", "reason", "score"} for item in result
    )


def test_hosted_malformed_response_is_clear(monkeypatch, tmp_path):
    _local_media(monkeypatch, 20)
    source = tmp_path / "source.mp4"
    source.touch()
    monkeypatch.setattr(
        highlights.config,
        "value",
        lambda name, default="": "secret" if name == "GROQ_API_KEY" else default,
    )
    monkeypatch.setattr(highlights.httpx, "Client", _FakeClient)
    _FakeClient.response = httpx.Response(
        200, json={"choices": [{"message": {"content": "not json"}}]}
    )
    with pytest.raises(highlights.HighlightError, match="malformed"):
        highlights.suggest_highlights(
            source, [{"start": 0, "end": 5, "text": "A passage"}], 5, 1, 1, "", "groq"
        )


def test_hosted_without_key_fails_without_request(monkeypatch, tmp_path):
    _local_media(monkeypatch, 20)
    source = tmp_path / "source.mp4"
    source.touch()
    monkeypatch.setattr(highlights.config, "value", lambda _name, default="": default)
    with pytest.raises(highlights.HighlightError, match="GROQ_API_KEY"):
        highlights.suggest_highlights(
            source, [{"start": 0, "end": 5, "text": "A passage"}], 5, 1, 1, "", "groq"
        )
