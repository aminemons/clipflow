from pathlib import Path

import pytest

from backend import app as api, highlights
from backend.store import Store


def test_smart_analysis_preserves_edits_and_selects_only_suggestions(
    monkeypatch, tmp_path
):
    store = Store(tmp_path)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "update", lambda *_: None)
    monkeypatch.setattr(api, "check_cancelled", lambda *_: None)
    first = api.clip_defaults(0, 10, 0)
    first.update(title="My edited title", caption_text="Keep my edit")
    project = store.save(
        {
            "id": "test",
            "duration": 60,
            "clips": [first],
            "transcript": [{"start": 20, "end": 30, "text": "Practical camera advice"}],
        }
    )

    def suggest(
        source, transcript, target, count, tolerance, topic, provider, progress
    ):
        assert tolerance == 0.3 and provider == "local" and transcript
        return [
            {
                "start": 20,
                "end": 30,
                "title": "Camera advice",
                "reason": "matches the requested topic",
                "score": 0.8,
            }
        ]

    monkeypatch.setattr(highlights, "suggest_highlights", suggest)
    options = {
        "use_transcript": True,
        "provider": "local",
        "tolerance": 0.3,
        "topic": "camera",
    }
    api.smart_highlights_job({}, project, Path("sample.mp4"), 10, options)
    saved = store.get("test")
    assert len(saved["clips"]) == 2
    assert saved["clips"][0]["caption_text"] == "Keep my edit"
    assert saved["clips"][0]["title"] == "My edited title"
    assert not saved["clips"][0]["selected"] and saved["clips"][1]["selected"]
    api.smart_highlights_job({}, saved, Path("sample.mp4"), 10, options)
    assert len(store.get("test")["clips"]) == 2


def test_full_analysis_rejects_stale_commit_and_keeps_edit(monkeypatch, tmp_path):
    store = Store(tmp_path)
    source = tmp_path / "sample.mp4"
    source.touch()
    original = api.clip_defaults(0, 10, 0)
    project = store.save(
        {"id": "stale", "duration": 20, "clips": [original], "edit_revision": 0}
    )
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "source_path", lambda _: source)
    monkeypatch.setattr(api, "metadata", lambda _: (20, 1280, 720, 30))
    monkeypatch.setattr(api, "check_cancelled", lambda *_: None)
    monkeypatch.setattr(api, "update", lambda *_: None)

    def analyze_and_edit(*_args, **_kwargs):
        latest = store.get("stale")
        latest["clips"][0]["title"] = "Edited during analysis"
        latest["edit_revision"] = 1
        store.save(latest)
        return [(0, 10)]

    monkeypatch.setattr(api, "analyze_segments", analyze_and_edit)
    with pytest.raises(RuntimeError, match="changed while analysis"):
        api.analyze_job({}, "stale", 10)
    assert store.get("stale")["clips"][0]["title"] == "Edited during analysis"


def test_local_smart_analysis_records_structural_fallback_warning(
    monkeypatch, tmp_path
):
    store = Store(tmp_path)
    source = tmp_path / "sample.mp4"
    source.touch()
    project = store.save(
        {
            "id": "fallback",
            "duration": 20,
            "clips": [],
            "transcript": [],
            "edit_revision": 0,
        }
    )
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api.media, "probe", lambda _: {"streams": [{"codec_type": "audio"}]})
    monkeypatch.setattr(
        api.speech,
        "transcribe",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("model is unavailable")),
    )
    monkeypatch.setattr(api, "update", lambda *_: None)
    monkeypatch.setattr(api, "check_cancelled", lambda *_: None)
    monkeypatch.setattr(
        highlights,
        "suggest_highlights",
        lambda *_args, **_kwargs: [],
    )
    result = api.smart_highlights_job(
        {},
        project,
        source,
        10,
        {"use_transcript": True, "provider": "local"},
    )
    assert result["warning"]
    assert "fallback" in store.get("fallback")["last_analysis"]["warning"]
