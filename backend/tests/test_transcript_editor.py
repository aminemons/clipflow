import pytest
from fastapi.testclient import TestClient

from backend import app as api, media
from backend.store import Store


@pytest.fixture
def editor(monkeypatch, tmp_path):
    store = Store(tmp_path)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "jobs", {})
    automatic = api.clip_defaults(0, 8, 0)
    automatic.update(status="exported", download_url="old.mp4")
    manual = api.clip_defaults(0, 8, 1)
    manual.update(caption_text="Manual caption", status="exported")
    store.save(
        {
            "id": "edit",
            "duration": 8,
            "clips": [automatic, manual],
            "transcript": [
                {"start": 0.0, "end": 3.0, "text": "Misspelled"},
                {"start": 3.0, "end": 7.0, "text": "Useful conclusion"},
            ],
        }
    )
    return TestClient(api.app), store


def test_correction_updates_captions_and_invalidates_only_automatic_exports(editor):
    client, store = editor
    rows = store.get("edit")["transcript"]
    rows[0]["text"] = "Corrected name"
    response = client.put("/api/projects/edit/transcript", json={"segments": rows})
    assert response.status_code == 200
    saved = store.get("edit")
    assert "Corrected name" in media.srt_for_clip(
        saved["clips"][0], saved["transcript"]
    )
    assert saved["clips"][0]["revision"] == 2
    assert "download_url" not in saved["clips"][0]
    assert saved["clips"][1]["revision"] == 1
    # Saving unchanged text is idempotent.
    client.put("/api/projects/edit/transcript", json={"segments": rows})
    assert store.get("edit")["clips"][0]["revision"] == 2
    created = client.post(
        "/api/projects/edit/clips",
        json={
            "start": rows[1]["start"],
            "end": rows[1]["end"],
            "title": rows[1]["text"],
        },
    )
    assert created.status_code == 200
    assert (created.json()["start"], created.json()["end"]) == (3, 7)
    assert len(store.get("edit")["clips"]) == 3
    rows[0]["text"] = ""
    client.put("/api/projects/edit/transcript", json={"segments": rows})
    captions = media.srt_for_clip(saved["clips"][0], store.get("edit")["transcript"])
    assert "Corrected name" not in captions and "00:00:03,000" in captions


def test_correction_rejects_changed_timestamps_and_active_jobs(editor, monkeypatch):
    client, store = editor
    before = store.get("edit")
    rows = before["transcript"]
    rows[0]["end"] = 99
    assert (
        client.put("/api/projects/edit/transcript", json={"segments": rows}).status_code
        == 400
    )
    assert store.get("edit")["transcript"][0]["end"] == 3
    monkeypatch.setattr(
        api, "jobs", {"job": {"project_id": "edit", "status": "running"}}
    )
    assert (
        client.put(
            "/api/projects/edit/transcript",
            json={"segments": store.get("edit")["transcript"]},
        ).status_code
        == 409
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"playback_speed": 0},
        {"playback_speed": 3},
        {"audio_volume": -1},
        {"audio_volume": True},
        {"audio_fade": 3},
        {"audio_denoise": "yes"},
    ],
)
def test_invalid_sound_settings_leave_clip_unchanged(editor, patch):
    client, store = editor
    clip = store.get("edit")["clips"][0]
    response = client.patch(f"/api/projects/edit/clips/{clip['id']}", json=patch)
    assert response.status_code == 400
    assert store.get("edit")["clips"][0] == clip


def test_sound_settings_persist_and_invalidate_export(editor):
    client, store = editor
    clip = store.get("edit")["clips"][0]
    patch = {
        "playback_speed": 1.5,
        "audio_volume": 0,
        "audio_denoise": True,
        "audio_fade": 0.5,
    }
    response = client.patch(f"/api/projects/edit/clips/{clip['id']}", json=patch)
    assert response.status_code == 200
    assert all(response.json()[key] == value for key, value in patch.items())
    assert response.json()["status"] == "draft"
