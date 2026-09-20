from pathlib import Path
import zipfile

import pytest

from backend.export_artifacts import (
    archive_location,
    export_location,
    finalize_exports,
    record_export,
)


class Store:
    def __init__(self, root):
        self.files = Path(root) / "files"


def test_snapshot_survives_later_clip_overwrite(tmp_path):
    store = Store(tmp_path)
    rendered = tmp_path / "clip.mp4"
    rendered.write_bytes(b"first export")
    clip = {"id": "clip-a", "title": "First"}
    result = finalize_exports(store, "project-a", "job-one", [(clip, rendered)])
    snapshot = export_location(store, "project-a", "job-one", "clip-a")
    assert result["download_url"].endswith("/exports/job-one/clip-a/download")
    assert snapshot.read_bytes() == b"first export"
    rendered.write_bytes(b"newer export")
    assert snapshot.read_bytes() == b"first export"


def test_batch_snapshot_returns_archive_and_safe_provenance_names(tmp_path):
    store = Store(tmp_path)
    first, second = tmp_path / "one.mp4", tmp_path / "two.mp4"
    first.write_bytes(b"one")
    second.write_bytes(b"two")
    result = finalize_exports(
        store,
        "project-a",
        "job-two",
        [
            ({"id": "clip-a", "title": "Kitchen / take"}, first),
            ({"id": "clip-b", "title": "Kitchen / take"}, second),
        ],
    )
    archive = archive_location(store, "project-a", "job-two")
    assert result["download_url"].endswith("/exports/job-two/download")
    with zipfile.ZipFile(archive) as bundle:
        assert set(bundle.namelist()) == {"Kitchen _ take.mp4", "Kitchen _ take-2.mp4"}
        assert bundle.read("Kitchen _ take.mp4") == b"one"
        assert bundle.read("Kitchen _ take-2.mp4") == b"two"


def test_record_export_rejects_missing_or_traversal_paths(tmp_path):
    store = Store(tmp_path)
    with pytest.raises(ValueError):
        export_location(store, "../project", "job", "clip")
    with pytest.raises(FileNotFoundError):
        record_export(
            store, "project", "job", [({"id": "clip"}, tmp_path / "missing.mp4")]
        )


def test_download_route_survives_edit_and_clip_removal(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.export_artifacts import register_routes

    store = Store(tmp_path)
    rendered = tmp_path / "render.mp4"
    rendered.write_bytes(b"original render")
    saved = finalize_exports(store, "project", "job", [({"id": "clip"}, rendered)])
    rendered.write_bytes(b"later edit")
    app = FastAPI()
    register_routes(app, store)
    client = TestClient(app)
    response = client.get(saved["download_url"])
    assert response.status_code == 200
    assert response.content == b"original render"
    assert (
        client.get("/api/projects/project/exports/job/missing/download").status_code
        == 404
    )
