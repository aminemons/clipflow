import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend import app as api
from backend.store import Store


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(api, "store", Store(tmp_path))
    monkeypatch.setattr(api, "jobs", {})
    monkeypatch.setattr(api, "cancel_events", {})
    monkeypatch.setattr(api, "executor", executor)
    yield api.store
    for event in api.cancel_events.values():
        event.set()
    executor.shutdown(wait=True)


def test_cancel_releases_worker_and_identical_submissions_are_deduplicated(workspace):
    started = threading.Event()

    def waiting_job(item, value):
        started.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            api.check_cancelled(item)
            time.sleep(0.01)

    first = api.submit(None, waiting_job, "first")
    assert started.wait(1)
    duplicate = api.submit(None, waiting_job, "first")
    assert first["id"] == duplicate["id"]
    second = api.submit(None, waiting_job, "second")
    assert second["id"] != first["id"]
    api.cancel_job(first["id"])
    assert api.get_job(first["id"])["stage"] in {"cancelling", "cancelled"}
    deadline = time.monotonic() + 2
    while api.jobs[second["id"]]["status"] == "queued" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert api.jobs[second["id"]]["status"] == "running"
    api.cancel_job(second["id"])
    deadline = time.monotonic() + 2
    while api.jobs[first["id"]]["status"] != "cancelled" and time.monotonic() < deadline:
        time.sleep(0.01)
    saved = json.loads(workspace.jobs_path.read_text())
    assert saved[first["id"]]["status"] == "cancelled"
    assert "args" not in api.get_job(first["id"])


def test_persist_job_publishes_an_immutable_snapshot(workspace):
    item = {
        "id": "snapshot",
        "kind": "waiting_job",
        "args": ["one"],
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "created_at": "now",
        "updated_at": "now",
    }
    api.persist_job(item)
    item["status"] = "error"
    assert api.jobs["snapshot"]["status"] == "queued"


def test_clip_review_and_subject_fields_are_validated_and_persisted(workspace):
    clip = api.clip_defaults(0, 5, 0)
    workspace.save({"id": "review", "duration": 10, "clips": [clip]})
    client = TestClient(api.app)
    url = f"/api/projects/review/clips/{clip['id']}"
    changed = client.patch(
        url,
        json={"subject": "left", "suggestion_status": "kept", "reviewed": True},
    )
    assert changed.status_code == 200
    value = changed.json()
    assert value["subject"] == "left"
    assert value["suggestion_status"] == "kept"
    assert value["reviewed"] is True


def test_preview_artifact_is_revision_bound(workspace, monkeypatch, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    clip = api.clip_defaults(0, 5, 0)
    workspace.save({"id": "proof", "duration": 10, "clips": [clip]})
    monkeypatch.setattr(api, "source_path", lambda _: source)
    monkeypatch.setattr(
        api,
        "render_clip",
        lambda _source, _clip, out, *_args, **_kwargs: Path(out).write_bytes(b"proof"),
    )
    result = api.preview_job({"id": "proof-job"}, "proof", clip["id"], 1)
    assert result["preview_revision"] == 1
    artifact = workspace.files / "proof" / f"preview-{clip['id']}-proof-job.mp4"
    assert artifact.read_bytes() == b"proof"
    latest = workspace.get("proof")
    latest["clips"][0]["revision"] = 2
    workspace.save(latest)
    with pytest.raises(RuntimeError, match="changed before preview"):
        api.preview_job({"id": "proof-job-2"}, "proof", clip["id"], 1)


def test_edits_invalidate_export_and_reject_invalid_settings(workspace):
    clip = api.clip_defaults(0, 5, 0)
    clip.update(status="exported", download_url="/old.mp4")
    workspace.save({"id": "sample", "duration": 10, "clips": [clip]})
    client = TestClient(api.app)
    url = f"/api/projects/sample/clips/{clip['id']}"
    assert client.patch(url, json={"framing": "invalid"}).status_code == 400
    assert client.patch(url, json={"end": 11}).status_code == 400
    changed = client.patch(url, json={"caption_text": "A new caption"}).json()
    assert changed["revision"] == 2
    assert changed["status"] == "draft" and "download_url" not in changed
    copied = client.post(
        "/api/projects/sample/clips", json={"id": "../../outside", "start": 1, "end": 3}
    ).json()
    assert copied["id"] != "../../outside"


def test_invalid_and_suffix_http_ranges(workspace, monkeypatch, tmp_path):
    video = tmp_path / "source.mp4"
    video.write_bytes(b"0123456789")
    monkeypatch.setattr(api, "source_path", lambda _: video)
    client = TestClient(api.app)
    assert (
        client.get(
            "/api/projects/sample/source", headers={"Range": "bytes=20-30"}
        ).status_code
        == 416
    )
    suffix = client.get("/api/projects/sample/source", headers={"Range": "bytes=-3"})
    assert suffix.status_code == 206 and suffix.content == b"789"


def test_resource_paths_cannot_escape_workspace(workspace):
    client = TestClient(api.app)
    assert workspace.get("..\\outside") is None
    with pytest.raises(ValueError):
        workspace.save({"id": "..\\outside"})
    assert (
        client.get("/api/projects/sample/clips/..%5Coutside/download").status_code
        == 400
    )
    assert client.get("/api/projects/..%5Coutside/source").status_code == 400
