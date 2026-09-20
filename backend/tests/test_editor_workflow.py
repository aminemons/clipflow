from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app as api
from backend.store import Store


@pytest.fixture
def editor(monkeypatch, tmp_path):
    store = Store(tmp_path)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "jobs", {})
    monkeypatch.setattr(api, "update", lambda *_: None)
    monkeypatch.setattr(api, "check_cancelled", lambda *_: None)
    clips = [api.clip_defaults(10, 20, 0), api.clip_defaults(25, 35, 1)]
    clips[1].update(status="exported", download_url="/retained.mp4")
    store.save(
        {
            "id": "test",
            "duration": 100,
            "clips": clips,
            "transcript": [{"start": 0, "end": 2, "text": "Full source text"}],
        }
    )
    source = store.files / "test.mp4"
    source.write_bytes(b"test video")
    monkeypatch.setattr(api, "source_path", lambda _: source)
    return TestClient(api.app), store, clips


def test_remove_all_restore_keeps_ids_edits_and_export_status(editor):
    client, store, clips = editor
    removed = client.post(
        "/api/projects/test/clips/bulk",
        json={"action": "delete", "clip_ids": [clip["id"] for clip in clips]},
    )
    assert removed.status_code == 200 and removed.json()["clips"] == []
    assert removed.json()["can_restore_clips"] and "clip_trash" not in removed.json()
    restored = client.post(
        "/api/projects/test/clips/bulk", json={"action": "restore"}
    ).json()
    assert restored["clips"] == clips
    assert not restored["can_restore_clips"]
    client.post("/api/projects/test/clips/bulk", json={"action": "restore"})
    assert len(store.get("test")["clips"]) == 2


def test_bulk_remove_is_atomic_and_busy_safe(editor, monkeypatch):
    client, store, clips = editor
    assert (
        client.post(
            "/api/projects/test/clips/bulk",
            json={"action": "delete", "clip_ids": [clips[0]["id"], "missing"]},
        ).status_code
        == 400
    )
    assert store.get("test")["clips"] == clips
    monkeypatch.setattr(
        api, "jobs", {"run": {"project_id": "test", "status": "running"}}
    )
    assert (
        client.post(
            "/api/projects/test/clips/bulk",
            json={"action": "delete", "clip_ids": [clips[0]["id"]]},
        ).status_code
        == 409
    )


def test_clip_speech_offsets_cache_and_corrections_are_independent(editor, monkeypatch):
    client, store, clips = editor
    calls = []

    def recognize(source, duration, progress, options):
        assert duration == 10 and Path(source).suffix == ".wav"
        calls.append(options)
        return [{"start": 1, "end": 4, "text": "Clip speech"}]

    monkeypatch.setattr(api.speech, "transcribe", recognize)
    monkeypatch.setattr(
        api.media, "run", lambda args, *_: Path(args[-1]).write_bytes(b"audio")
    )
    options = {"clip_id": clips[0]["id"], "quality": "balanced", "language": "ar"}
    api.transcribe_job({}, "test", options)
    saved = store.get("test")
    assert saved["transcript"][0]["text"] == "Full source text"
    assert saved["clips"][1] == clips[1]
    rows = saved["clips"][0]["transcript"]
    assert rows == [{"start": 11, "end": 14, "text": "Clip speech"}]
    rows[0]["text"] = "Corrected clip speech"
    response = client.put(
        "/api/projects/test/transcript",
        json={"clip_id": clips[0]["id"], "segments": rows},
    )
    assert response.status_code == 200
    assert "speech_cache" not in response.json()
    assert api.transcribe_job({}, "test", options)["cached"]
    assert len(calls) == 1
    assert (
        "Corrected clip speech"
        in client.get(f"/api/projects/test/clips/{clips[0]['id']}/captions").text
    )
    assert list(store.files.iterdir()) == [store.files / "test.mp4"]
    api.transcribe_job({}, "test", {**options, "force": True})
    assert len(calls) == 2


def test_trim_invalidates_scoped_caption_coverage(editor, monkeypatch):
    client, store, clips = editor
    project = store.get("test")
    project["clips"][0].update(
        transcript=[{"start": 11, "end": 13, "text": "Old range"}],
        transcription_key="old",
    )
    store.save(project)
    response = client.patch(
        f"/api/projects/test/clips/{clips[0]['id']}", json={"end": 22}
    )
    assert response.status_code == 200
    assert (
        "transcript" not in response.json()
        and "transcription_key" not in response.json()
    )


def test_passage_clip_inherits_corrected_scoped_transcript(editor):
    client, store, clips = editor
    project = store.get("test")
    project["clips"][0]["transcript"] = [
        {"start": 11, "end": 15, "text": "Corrected passage"},
        {"start": 17, "end": 19, "text": "Outside selection"},
    ]
    store.save(project)
    result = client.post(
        "/api/projects/test/clips",
        json={
            "start": 12,
            "end": 16,
            "source_clip_id": clips[0]["id"],
        },
    )
    assert result.status_code == 200
    assert result.json()["transcript"] == [
        {"start": 12, "end": 15, "text": "Corrected passage"},
    ]
    assert store.get("test")["transcript"][0]["text"] == "Full source text"
