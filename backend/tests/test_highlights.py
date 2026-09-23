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


def test_local_novelty_does_not_depend_on_candidate_iteration_order():
    candidates = [
        {
            "id": index,
            "start": float(index * 2),
            "end": float(index * 2 + 4),
            "duration": 4.0,
            "target": 4.0,
            "text": "the same useful passage",
            "density": 1.0,
            "info": 0.5,
        }
        for index in range(2)
    ]

    forward = {
        row["id"]: row["novelty"]
        for row in highlights._rank_candidates(
            [dict(candidate) for candidate in candidates], ""
        )
    }
    reverse = {
        row["id"]: row["novelty"]
        for row in highlights._rank_candidates(
            [dict(candidate) for candidate in reversed(candidates)], ""
        )
    }

    assert forward == reverse == {0: 0.5, 1: 0.5}


def test_arabic_lexical_features_normalize_marks_and_common_function_words():
    assert highlights._words("إِنَّ هٰذَا مِنَ الْبَيْتِ") == ["البيت"]
    terms = highlights._topic_terms("إلى البيت")
    assert highlights._topic_score("هذا عن إِلَى الْبَيْتِ", terms) == 1.0
    assert highlights._topic_score("البيت", {"البيت"}) == 1.0
    assert highlights._words("مدرّس") == ["مدرّس"]
    assert highlights._words("مدرّس") != highlights._words("مدرس")


def test_silent_highlights_sample_distinct_parts_of_the_source():
    candidates = [
        {
            "id": index,
            "start": float(index * 10),
            "end": float((index + 1) * 10),
            "duration": 10.0,
            "target": 10.0,
            "text": "",
            "density": 0.0,
            "info": 0.0,
        }
        for index in range(10)
    ]

    selected = highlights._select(candidates, 3, "")

    assert len(selected) == 3
    assert selected[0]["start"] < 30
    assert 30 <= selected[1]["start"] < 70
    assert selected[2]["start"] >= 70


def test_model_rank_order_controls_overlap_and_clip_limit(monkeypatch):
    from backend import language_models

    candidates = [
        {"id": 0, "start": 0.0, "end": 5.0, "text": "lower model rank",
         "duration": 5.0, "target": 5.0, "density": 1.0, "info": 1.0},
        {"id": 1, "start": 8.0, "end": 13.0, "text": "preferred model rank",
         "duration": 5.0, "target": 5.0, "density": 0.1, "info": 0.1},
    ]
    monkeypatch.setattr(language_models, "generate_json", lambda *_args: {"ids": [1, 0]})

    selected = highlights._model_rank(candidates, "", 1, "openai", None)

    assert [candidate["id"] for candidate in selected] == [1]


def test_model_candidate_context_is_compact_and_spread_out():
    candidates = [
        {"id": index, "start": float(index * 3), "end": float(index * 3 + 2),
         "text": "x" * 1000, "duration": 2.0, "target": 2.0,
         "density": 1.0 if index < 40 else 0.1, "info": 1.0}
        for index in range(80)
    ]

    context = highlights._model_candidate_context(candidates, "")

    assert len(context) == 30
    assert all(len(candidate["text"]) == 1000 for candidate in context)
    assert all(highlights._overlap(left, right) <= 0.1
               for i, left in enumerate(context) for right in context[i + 1:])
    assert any(candidate["start"] > 180 for candidate in context)


def test_model_ranking_receives_the_passage_payoff(monkeypatch):
    from backend import language_models

    passage = "setup " + ("context " * 200) + "and the answer was forty two"
    received = {}

    def capture(_provider, _instruction, data):
        received.update(data)
        return {"ids": [0]}

    monkeypatch.setattr(language_models, "generate_json", capture)
    highlights._model_rank(
        [{"id": 0, "start": 0, "end": 20, "text": passage,
          "duration": 20, "target": 20, "density": 1.0, "info": 1.0}],
        "", 1, "openai", None,
    )

    excerpt = received["candidates"][0]["text"]
    assert len(excerpt) <= 1200
    assert excerpt.startswith("setup ")
    assert "middle omitted" in excerpt
    assert excerpt.endswith("and the answer was forty two")


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


def test_word_timings_trim_sentence_padding_without_truncating_it(monkeypatch, tmp_path):
    _local_media(monkeypatch, 20)
    source = tmp_path / "source.mp4"
    source.touch()
    rows = highlights._clean_transcript(
        [
            {
                "start": 1,
                "end": 5,
                "text": "A complete sentence.",
                "words": [
                    {"start": 1.2, "end": 1.5, "text": "A"},
                    {"start": 1.6, "end": 2.4, "text": "complete"},
                    {"start": 2.5, "end": 4.8, "text": "sentence."},
                ],
            }
        ]
    )
    candidates = highlights._candidate_windows(
        source, rows, 4, 3.2, 4.8, None, sentence_context="keep"
    )
    sentence = next(row for row in candidates if row["text"] == "A complete sentence.")
    assert sentence["start"] == 1.2
    assert sentence["end"] == 4.8
    assert sentence["text"] == "A complete sentence."


def test_candidate_that_cuts_a_long_turn_is_marked_for_review(monkeypatch, tmp_path):
    _local_media(monkeypatch, 10)
    source = tmp_path / "source.mp4"
    source.touch()
    rows = highlights._clean_transcript([
        {"start": 0, "end": 10, "text": "One long uninterrupted explanation."}
    ])

    candidates = highlights._candidate_windows(source, rows, 5, 4, 6, None)

    assert any(candidate["complete"] is False for candidate in candidates)
    partial = next(candidate for candidate in candidates if not candidate["complete"])
    assert "cut-off thought" in highlights._public(partial)["reason"]


def test_invalid_word_timings_do_not_affect_legacy_segments():
    rows = highlights._clean_transcript(
        [
            {
                "start": 0,
                "end": 2,
                "text": "Legacy segment",
                "words": [
                    {"start": 3, "end": 4, "text": "outside"},
                    {"start": float("nan"), "end": 1, "text": "invalid"},
                ],
            }
        ]
    )
    assert rows == [{"start": 0, "end": 2, "text": "Legacy segment"}]


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
