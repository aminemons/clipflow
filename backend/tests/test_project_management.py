from fastapi.testclient import TestClient

from backend import app as api
from backend.store import Store


def _project(store, project_id="managed"):
    return store.save(
        {
            "id": project_id,
            "title": "Original title",
            "duration": 10,
            "clips": [],
            "created_at": "2026-01-01T00:00:00+00:00",
        }
    )


def test_project_metadata_patch_is_trimmed_persisted_and_listed(monkeypatch, tmp_path):
    store = Store(tmp_path)
    _project(store)
    monkeypatch.setattr(api, "store", store)
    client = TestClient(api.app)

    response = client.patch(
        "/api/projects/managed",
        json={"title": "  Renamed project  ", "favorite": True, "tags": ["  work "]},
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Renamed project"
    saved = store.get("managed")
    assert saved["title"] == "Renamed project"
    assert saved["favorite"] is True
    assert saved["tags"] == ["work"]
    assert response.json()["updated_at"]

    listed = client.get("/api/projects").json()
    assert listed[0]["favorite"] is True
    assert listed[0]["tags"] == ["work"]
    assert listed[0]["archived"] is False


def test_archive_restore_and_busy_guard(monkeypatch, tmp_path):
    store = Store(tmp_path)
    _project(store)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(
        api,
        "jobs",
        {"job1": {"id": "job1", "project_id": "managed", "status": "queued"}},
    )
    client = TestClient(api.app)
    busy = client.patch("/api/projects/managed", json={"archived": True})
    assert busy.status_code == 409
    api.jobs.clear()

    archived = client.patch("/api/projects/managed", json={"archived": True})
    assert archived.status_code == 200
    assert store.get("managed")["archived"] is True
    restored = client.patch("/api/projects/managed", json={"archived": False})
    assert restored.status_code == 200
    assert store.get("managed")["archived"] is False


def test_cleanup_removes_previews_only_and_rejects_unsafe_ids(monkeypatch, tmp_path):
    store = Store(tmp_path)
    _project(store)
    monkeypatch.setattr(api, "store", store)
    project_dir = store.files / "managed"
    project_dir.mkdir()
    preview = project_dir / "preview-clip-job.mp4"
    preview.write_bytes(b"preview")
    source = store.files / "managed.mp4"
    source.write_bytes(b"source")
    export = project_dir / "exports" / "job1" / "clip.mp4"
    export.parent.mkdir(parents=True)
    export.write_bytes(b"export")
    client = TestClient(api.app)

    result = client.post("/api/projects/managed/cleanup")
    assert result.status_code == 200
    assert result.json()["freed_bytes"] == len(b"preview")
    assert not preview.exists()
    assert source.read_bytes() == b"source"
    assert export.read_bytes() == b"export"
    assert client.post("/api/projects/..%5Coutside/cleanup").status_code == 400


def test_permanent_project_delete_removes_record_media_and_jobs(monkeypatch, tmp_path):
    store = Store(tmp_path)
    _project(store)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(
        api, "jobs", {"finished": {"id": "finished", "project_id": "managed", "status": "done"}}
    )
    (store.files / "managed.mp4").write_bytes(b"source")
    project_dir = store.files / "managed" / "exports" / "job1"
    project_dir.mkdir(parents=True)
    (project_dir / "clip.mp4").write_bytes(b"render")
    response = TestClient(api.app).delete("/api/projects/managed")
    assert response.status_code == 200
    assert store.get("managed") is None
    assert not (store.files / "managed.mp4").exists()
    assert not (store.files / "managed").exists()
    assert "finished" not in api.jobs


def test_permanent_project_delete_rejects_active_job(monkeypatch, tmp_path):
    store = Store(tmp_path)
    _project(store)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "jobs", {"run": {"project_id": "managed", "status": "running"}})
    response = TestClient(api.app).delete("/api/projects/managed")
    assert response.status_code == 409
    assert store.get("managed") is not None


def test_storage_summary_reports_source_and_export_bytes(monkeypatch, tmp_path):
    store = Store(tmp_path)
    _project(store)
    monkeypatch.setattr(api, "store", store)
    (store.files / "managed.mp4").write_bytes(b"source")
    exported = store.files / "managed" / "exports" / "job1" / "clip.mp4"
    exported.parent.mkdir(parents=True)
    exported.write_bytes(b"export")
    summary = TestClient(api.app).get("/api/storage")
    assert summary.status_code == 200
    used = summary.json()["used"]
    assert used["source_bytes"] >= len(b"source")
    assert used["export_bytes"] >= len(b"export")


def test_transcript_import_replaces_rows_and_obeys_active_job_guard(monkeypatch, tmp_path):
    store = Store(tmp_path)
    project = _project(store)
    project["duration"] = 12
    project["transcript"] = [{"start": 0, "end": 1, "text": "old"}]
    store.save(project)
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(
        api,
        "jobs",
        {"job1": {"id": "job1", "project_id": "managed", "status": "running"}},
    )
    client = TestClient(api.app)
    body = {"segments": [{"start": 2, "end": 3, "text": "new"}]}
    assert client.post("/api/projects/managed/transcript/import", json=body).status_code == 409
    api.jobs.clear()
    imported = client.post("/api/projects/managed/transcript/import", json=body)
    assert imported.status_code == 200
    assert store.get("managed")["transcript"] == body["segments"]
    assert client.post(
        "/api/projects/managed/transcript/import",
        json={"segments": [{"start": 3, "end": 2, "text": "bad"}]},
    ).status_code == 422


def test_transcript_import_invalidates_target_or_source_dependent_clips(monkeypatch, tmp_path):
    store = Store(tmp_path)
    project = _project(store)
    project["duration"] = 10
    first = api.clip_defaults(0, 2, 0)
    second = api.clip_defaults(2, 4, 1)
    second["caption_text"] = "manual"
    third = api.clip_defaults(4, 6, 2)
    third["transcript"] = [{"start": 4, "end": 5, "text": "own"}]
    project["clips"] = [first, second, third]
    store.save(project)
    monkeypatch.setattr(api, "store", store)
    client = TestClient(api.app)

    response = client.post(
        "/api/projects/managed/transcript/import",
        json={"clip_id": second["id"], "segments": [{"start": 2, "end": 3, "text": "clip"}]},
    )
    assert response.status_code == 200
    saved = store.get("managed")
    assert saved["clips"][1]["revision"] == second["revision"] + 1
    assert saved["clips"][0]["revision"] == first["revision"]

    response = client.post(
        "/api/projects/managed/transcript/import",
        json={"segments": [{"start": 0, "end": 1, "text": "source"}]},
    )
    assert response.status_code == 200
    saved = store.get("managed")
    assert saved["clips"][0]["revision"] == first["revision"] + 1
    assert saved["clips"][1]["revision"] == second["revision"] + 1
    assert saved["clips"][2]["revision"] == third["revision"]


def test_transcript_import_rejects_positive_rows_for_zero_duration(monkeypatch, tmp_path):
    store = Store(tmp_path)
    project = _project(store)
    project["duration"] = 0
    store.save(project)
    monkeypatch.setattr(api, "store", store)
    response = TestClient(api.app).post(
        "/api/projects/managed/transcript/import",
        json={"segments": [{"start": 0, "end": 1, "text": "source"}]},
    )
    assert response.status_code == 422
