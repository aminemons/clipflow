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
            "5",
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
    assert 4.8 <= project["duration"] <= 5.2

    generated = client.post(
        f"/api/projects/{project_id}/generate",
        json={
            "mode": "manual",
            "ranges": [{"start": 0, "end": 2}, {"start": 2, "end": 4}],
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


def test_auto_edit_previews_and_exports_same_cut(tmp_path, isolated_app, monkeypatch):
    source = tmp_path / "auto-edit.mp4"
    make_short_source(source)
    project = api.create_project(source, "Auto edit")

    response = client.post(
        f"/api/projects/{project['id']}/auto-edit",
        json={"style": "visual", "format": "4:5", "opening_text": "A first cut"},
    )
    assert response.status_code == 200, response.text
    job = wait_job(response.json()["id"])
    saved = client.get(f"/api/projects/{project['id']}").json()
    assert saved["auto_edit"]["job_id"] == job["id"]
    clip, = saved["clips"]
    assert clip["motion_graphic"]["text"] == "A first cut"
    assert clip["aspect_ratio"] == "4:5"
    assert clip["selected"] is False
    preview = client.get(f"/api/projects/{project['id']}/clips/{clip['id']}/previews/{job['id']}")
    assert preview.status_code == 200 and b"ftyp" in preview.content[:64]

    def unexpected_render(*_args):
        pytest.fail("The approved draft should be packaged without rendering again")

    monkeypatch.setattr(api, "render_clip", unexpected_render)
    exported = client.post(f"/api/projects/{project['id']}/export", json={"clip_ids": [clip["id"]]})
    assert exported.status_code == 200, exported.text
    download = client.get(wait_job(exported.json()["id"])["download_url"])
    assert download.status_code == 200 and download.content == preview.content


def test_social_auto_edit_uses_transcript_for_captions_and_opening(tmp_path, isolated_app, monkeypatch):
    source = tmp_path / "interview.mp4"
    make_short_source(source)
    project = api.create_project(source, "Interview")
    project["transcript"] = [{
        "start": .25,
        "end": 4.25,
        "text": "We finished the film on Friday. The team pulled it together.",
    }]
    api.store.save(project)
    monkeypatch.setattr(api.speech, "transcribe", lambda *_: pytest.fail("Reuse the saved transcript"))

    response = client.post(f"/api/projects/{project['id']}/auto-edit", json={"style": "social"})
    assert response.status_code == 200, response.text
    wait_job(response.json()["id"])
    clip, = api.store.get(project["id"])["clips"]
    assert clip["caption_style"] == "bold" and clip["caption_enabled"]
    assert clip["transcript"] == project["transcript"]
    assert clip["motion_graphic"]["preset"] == "callout"
    assert project["transcript"][0]["text"].startswith(clip["motion_graphic"]["text"])


def test_auto_edit_assembles_pause_cuts_and_retimes_captions(tmp_path, isolated_app):
    source = tmp_path / "long-pause.mp4"
    subprocess.run(
        [api.media.FFMPEG, "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30",
         "-f", "lavfi", "-i", r"aevalsrc=if(between(t\,2\,4)\,0\,0.2*sin(880*PI*t)):s=16000",
         "-t", "8", "-c:v", "libx264", "-c:a", "aac", str(source)],
        check=True, capture_output=True,
    )
    quiet, = api.media.detect_silence(source, 1, 7)
    assert quiet == pytest.approx((2, 4), abs=.08)
    project = api.create_project(source, "Pacing demo")
    project["transcript"] = [
        {"start": .1, "end": 2, "text": "Here is the setup."},
        {"start": 4, "end": 7.8, "text": "Here is the payoff."},
    ]
    api.store.save(project)
    root = f"/api/projects/{project['id']}"
    started = client.post(f"{root}/auto-edit", json={"style": "social", "format": "16:9"})
    assert started.status_code == 200, started.text
    job = wait_job(started.json()["id"])
    clip, = api.store.get(project["id"])["clips"]
    gap, = clip["pause_cuts"]
    removed = gap["end"] - gap["start"]
    assert 2 < gap["start"] < gap["end"] < 4 and removed > 1.5
    path = api.store.files / project["id"] / f"preview-{clip['id']}-{job['id']}.mp4"
    assert api.media.metadata(path)[0] == pytest.approx(clip["end"] - clip["start"] - removed, abs=.15)
    streams = api.media.probe(path)["streams"]
    audio = next(stream for stream in streams if stream["codec_type"] == "audio")
    video = next(stream for stream in streams if stream["codec_type"] == "video")
    assert float(audio["duration"]) == pytest.approx(float(video["duration"]), abs=.1)
    captions = client.get(f"{root}/clips/{clip['id']}/captions").text
    assert f"{api.media._safe_time(4 - clip['start'] - removed)} -->" in captions
    assert "Here is the payoff." in captions

    edited = client.patch(f"{root}/clips/{clip['id']}", json={"end": gap["end"] - .1})
    assert edited.status_code == 200
    assert len(api.media.retained_ranges(edited.json())) == 1
    assert edited.json()["pause_cuts"] == clip["pause_cuts"]


def test_silent_source_smart_skips_moments_while_full_covers_every_second(tmp_path, isolated_app):
    source = tmp_path / "silent-source.mp4"
    subprocess.run(
        [api.media.FFMPEG, "-y", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=24",
         "-t", "12.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)],
        check=True, capture_output=True, timeout=30,
    )
    with source.open("rb") as stream:
        upload = client.post("/api/projects/upload", files={
            "file": (source.name, stream, "video/mp4")})
    assert upload.status_code == 200, upload.text
    project_id = wait_job(upload.json()["id"])["project_id"]

    smart = client.post(f"/api/projects/{project_id}/generate", json={
        "mode": "smart", "target_duration": 5, "max_clips": 1,
        "camera": {"framing": "fit", "resolution": 360},
    })
    assert smart.status_code == 200, smart.text
    smart_job = wait_job(smart.json()["id"])
    assert "No audio track" in smart_job["warning"]
    smart_clips = client.get(f"/api/projects/{project_id}").json()["clips"]
    assert len(smart_clips) == 1

    full = client.post(f"/api/projects/{project_id}/generate", json={
        "mode": "full", "target_duration": 5, "max_clips": 1,
        "camera": {"framing": "fit", "resolution": 360},
    })
    assert full.status_code == 200, full.text
    wait_job(full.json()["id"])
    clips = client.get(f"/api/projects/{project_id}").json()["clips"]
    segments = [(clip["start"], clip["end"]) for clip in clips[1:]]
    assert len(segments) == 3
    assert segments[0][0] == 0
    assert segments[-1][1] == pytest.approx(12.6, abs=0.1)
    assert all(left[1] == right[0] for left, right in zip(segments, segments[1:]))
