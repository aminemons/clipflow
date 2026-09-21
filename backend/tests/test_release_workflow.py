"""Small, local-only release workflow regression.

This module sets CLIPFLOW_DATA before importing the app so the test never
touches a developer's or a running desktop instance's data directory.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

DATA_ROOT = Path(tempfile.mkdtemp(prefix="clipflow-release-"))
_PREVIOUS_DATA = os.environ.get("CLIPFLOW_DATA")
_PREVIOUS_PROVIDER = os.environ.get("CLIPFLOW_TRANSCRIPTION_PROVIDER")
os.environ["CLIPFLOW_DATA"] = str(DATA_ROOT)
os.environ["CLIPFLOW_TRANSCRIPTION_PROVIDER"] = "local"

from fastapi.testclient import TestClient  # noqa: E402

from backend import app as api  # noqa: E402
from backend.store import Store  # noqa: E402

if _PREVIOUS_DATA is None:
    os.environ.pop("CLIPFLOW_DATA", None)
else:
    os.environ["CLIPFLOW_DATA"] = _PREVIOUS_DATA
if _PREVIOUS_PROVIDER is None:
    os.environ.pop("CLIPFLOW_TRANSCRIPTION_PROVIDER", None)
else:
    os.environ["CLIPFLOW_TRANSCRIPTION_PROVIDER"] = _PREVIOUS_PROVIDER


client = TestClient(api.app)


@pytest.fixture
def isolated_app():
    """Swap app state for this test and restore it for the surrounding suite."""
    old_store, old_data, old_jobs = api.store, api.DATA, api.jobs
    api.store = Store(DATA_ROOT)
    api.DATA = DATA_ROOT
    api.jobs = {}
    try:
        yield
    finally:
        api.store, api.DATA, api.jobs = old_store, old_data, old_jobs


def wait_job(job_id: str, timeout: float = 45) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in {"done", "error", "cancelled"}:
            assert job["status"] == "done", job
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


def make_short_source(path: Path) -> None:
    subprocess.run(
        [
            api.media.FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x18324a:s=640x360:r=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=16000",
            "-t",
            "3",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def test_local_release_workflow_upload_edit_proof_export_restore_persistence(tmp_path, isolated_app):
    source = tmp_path / "release-source.mp4"
    make_short_source(source)
    assert source.stat().st_size < 2_000_000

    with source.open("rb") as stream:
        uploaded = client.post(
            "/api/projects/upload",
            files={"file": (source.name, stream, "video/mp4")},
            data={"target_duration": "5"},
        )
    assert uploaded.status_code == 200, uploaded.text
    project_id = wait_job(uploaded.json()["id"])["project_id"]
    project = client.get(f"/api/projects/{project_id}").json()
    assert 2.8 <= project["duration"] <= 3.2

    generated = client.post(
        f"/api/projects/{project_id}/generate",
        json={
            "mode": "manual",
            "ranges": [{"start": 0, "end": 1}, {"start": 1, "end": 2}],
            "camera": {"framing": "fit", "resolution": 360},
            "captions": {"mode": "manual", "text": "release test", "style": "bold"},
            "audio": {"volume": 1},
        },
    )
    assert generated.status_code == 200, generated.text
    generation_job = wait_job(generated.json()["id"])
    assert generation_job["clip_titles"] == ["Clip 1", "Clip 2"]
    project = client.get(f"/api/projects/{project_id}").json()
    assert len(project["clips"]) == 2
    first, second = project["clips"]

    renamed = client.patch(
        f"/api/projects/{project_id}/clips/{first['id']}",
        json={"title": "Renamed release clip", "end": 0.8, "caption_text": "Edited caption"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["title"] == "Renamed release clip"
    assert renamed.json()["end"] == 0.8
    assert "Edited caption" in client.get(
        f"/api/projects/{project_id}/clips/{first['id']}/captions"
    ).text

    pending = client.patch(
        f"/api/projects/{project_id}/clips/{first['id']}",
        json={"suggestion_status": "pending"},
    ).json()
    assert pending["reviewed"] is False and pending["selected"] is False
    kept = client.patch(
        f"/api/projects/{project_id}/clips/{first['id']}",
        json={"suggestion_status": "kept"},
    ).json()
    assert kept["reviewed"] is True and kept["selected"] is True
    discarded = client.patch(
        f"/api/projects/{project_id}/clips/{second['id']}",
        json={"suggestion_status": "discarded"},
    ).json()
    assert discarded["reviewed"] is True and discarded["selected"] is False

    proof = client.post(
        f"/api/projects/{project_id}/preview", json={"clip_id": first["id"]}
    )
    assert proof.status_code == 200, proof.text
    proof_job = wait_job(proof.json()["id"])
    proof_download = client.get(
        f"/api/projects/{project_id}/clips/{first['id']}/previews/{proof_job['id']}"
    )
    assert proof_download.status_code == 200
    assert proof_download.content[:4] == b"\x00\x00\x00\x18" or b"ftyp" in proof_download.content[:64]

    exported = client.post(
        f"/api/projects/{project_id}/export",
        json={"clip_ids": [first["id"], second["id"]]},
    )
    assert exported.status_code == 200, exported.text
    export_job = wait_job(exported.json()["id"])
    zip_url = export_job["download_url"]
    archive = client.get(zip_url)
    assert archive.status_code == 200
    assert archive.content[:2] == b"PK"
    exported_project = client.get(f"/api/projects/{project_id}").json()
    exported_first = next(c for c in exported_project["clips"] if c["id"] == first["id"])
    clip_mp4_url = exported_first["download_url"]
    clip_mp4 = client.get(clip_mp4_url)
    assert clip_mp4.status_code == 200
    assert b"ftyp" in clip_mp4.content[:64]
    immutable_bytes = clip_mp4.content

    removed = client.post(
        f"/api/projects/{project_id}/clips/bulk",
        json={"action": "delete", "clip_ids": [first["id"], second["id"]]},
    )
    assert removed.status_code == 200 and removed.json()["clips"] == []
    restored = client.post(
        f"/api/projects/{project_id}/clips/bulk", json={"action": "restore"}
    )
    assert restored.status_code == 200
    restored_clips = restored.json()["clips"]
    assert [clip["id"] for clip in restored_clips] == [first["id"], second["id"]]
    assert next(c for c in restored_clips if c["id"] == second["id"])["selected"] is False

    reopened = Store(DATA_ROOT).get(project_id)
    assert [clip["id"] for clip in reopened["clips"]] == [first["id"], second["id"]]
    assert client.get(clip_mp4_url).content == immutable_bytes
