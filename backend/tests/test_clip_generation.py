from pathlib import Path
import threading

import pytest

from backend import app, highlights
from backend.clip_generation import generate_clips
from backend.store import Store


def _project(store, project_id="generate-test"):
    existing = app.clip_defaults(0, 4, 0)
    existing["title"] = "Edited clip"
    return store.save(
        {
            "id": project_id,
            "duration": 20,
            "clips": [existing],
            "transcript": [],
            "edit_revision": 0,
        }
    )


def _runtime(monkeypatch, tmp_path, project_id="generate-test"):
    store = Store(tmp_path)
    project = _project(store, project_id)
    source = tmp_path / "source.mp4"
    source.touch()
    monkeypatch.setattr(app, "store", store)
    monkeypatch.setattr(app, "source_path", lambda _project_id: source)
    monkeypatch.setattr(app, "update", lambda *_args: None)
    monkeypatch.setattr(app, "check_cancelled", lambda *_args: None)
    monkeypatch.setattr(app, "projects_lock", threading.RLock())
    return store, project


def _suggestion(monkeypatch, *, expected_transcript=None):
    def suggest(source, transcript, target, count, tolerance, topic, provider, progress):
        assert Path(source).exists()
        assert target == 5 and count == 1 and tolerance == 0.3
        if expected_transcript is not None:
            assert transcript == expected_transcript
        return [{
            "start": 10,
            "end": 15,
            "title": "Generated moment",
            "reason": "contains sustained speech",
            "score": 0.7,
        }]

    monkeypatch.setattr(highlights, "suggest_highlights", suggest)


def test_generation_appends_new_clips_and_uses_cached_speech(monkeypatch, tmp_path):
    store, project = _runtime(monkeypatch, tmp_path)
    cached = [{"start": 10, "end": 15, "text": "Cached camera advice"}]
    project = store.get(project["id"])
    project["generation_speech"] = {
        "options": {"language": "auto", "quality": "balanced", "dialect": "none"},
        "segments": cached,
    }
    store.save(project)
    _suggestion(monkeypatch, expected_transcript=cached)

    result = generate_clips(
        app,
        {"id": "job-1"},
        project["id"],
        {"mode": "smart", "target_duration": 5, "max_clips": 1,
         "use_transcript": True, "provider": "local", "captions": {"mode": "auto"}},
    )

    saved = store.get(project["id"])
    assert result["clip_titles"] == ["Generated moment"]
    assert len(saved["clips"]) == 2
    assert saved["clips"][0]["title"] == "Edited clip"
    assert saved["clips"][1]["transcript"] == cached
    assert saved["edit_revision"] == 1


def test_generation_cancellation_does_not_commit_a_partial_batch(monkeypatch, tmp_path):
    store, project = _runtime(monkeypatch, tmp_path)
    _suggestion(monkeypatch)
    calls = {"count": 0}

    def cancel_after_prepare(item):
        calls["count"] += 1
        if calls["count"] >= 2:
            raise RuntimeError("job cancelled")

    monkeypatch.setattr(app, "check_cancelled", cancel_after_prepare)
    before = store.get(project["id"])
    with pytest.raises(RuntimeError, match="cancelled"):
        generate_clips(
            app, {"id": "job-2"}, project["id"],
            {"mode": "smart", "target_duration": 5, "max_clips": 1,
             "provider": "local"},
        )
    after = store.get(project["id"])
    assert after["clips"] == before["clips"]
    assert after["edit_revision"] == before["edit_revision"]


def test_generation_rejects_stale_revision_without_overwriting_edits(monkeypatch, tmp_path):
    store, project = _runtime(monkeypatch, tmp_path)
    _suggestion(monkeypatch)

    def mutate_before_commit(item):
        latest = store.get(project["id"])
        latest["clips"][0]["title"] = "Edited during generation"
        latest["edit_revision"] = 1
        store.save(latest)

    monkeypatch.setattr(app, "check_cancelled", mutate_before_commit)
    with pytest.raises(RuntimeError, match="changed during generation"):
        generate_clips(
            app, {"id": "job-3"}, project["id"],
            {"mode": "smart", "target_duration": 5, "max_clips": 1,
             "provider": "local"},
        )
    saved = store.get(project["id"])
    assert len(saved["clips"]) == 1
    assert saved["clips"][0]["title"] == "Edited during generation"


def test_automatic_silent_source_produces_visual_clips_without_captions(monkeypatch, tmp_path):
    store, project = _runtime(monkeypatch, tmp_path)
    _suggestion(monkeypatch, expected_transcript=[])
    monkeypatch.setattr(app.media, "probe", lambda _: {"streams": [{"codec_type": "video"}]})
    def unexpected_speech(*args, **kwargs):
        pytest.fail("Silent sources must not load a speech model")
    monkeypatch.setattr(app.speech, "transcribe", unexpected_speech)
    job = {"id": "silent-auto"}
    generate_clips(app, job, project["id"], {
        "automatic": True, "mode": "smart", "target_duration": 5,
        "max_clips": 1, "use_transcript": True,
        "captions": {"mode": "auto", "quality": "auto"},
    })
    clip = store.get(project["id"])["clips"][-1]
    assert clip["caption_enabled"] is False
    assert clip["transcript"] == []
    assert "No audio" in job["warning"]
