from __future__ import annotations

import io
import json
import time
import zipfile
from pathlib import Path

import cv2
import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from backend import app as api
    from backend.store import Store

    monkeypatch.setattr(api, "DATA", tmp_path)
    monkeypatch.setattr(api, "store", Store(tmp_path))
    api.jobs.clear()
    yield TestClient(api.app), api
    api.jobs.clear()


def wait_job(client: TestClient, response, timeout: float = 90):
    assert response.status_code == 200, response.text
    job = response.json()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = client.get(f"/api/jobs/{job['id']}").json()
        if current["status"] in {"done", "error"}:
            assert current["status"] == "done", current
            return current
        time.sleep(0.1)
    pytest.fail(f"job did not finish: {job['id']}")


def make_five_second_video(api, path: Path) -> None:
    api.media.run(
        [
            api.media.FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x223344:s=640x360:r=30:d=5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=5",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ]
    )


def green_centers(path: Path, times: list[float]) -> list[float]:
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    centers = []
    for seconds in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(seconds * fps))
        ok, frame = cap.read()
        assert ok
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, (35, 50, 100), (95, 255, 255))
        moments = cv2.moments(mask)
        assert moments["m00"]
        centers.append(moments["m10"] / moments["m00"])
    cap.release()
    return centers


def create_demo(client: TestClient):
    job = wait_job(
        client, client.post("/api/projects/demo", json={"target_duration": 5})
    )
    wait_job(
        client,
        client.post(
            f"/api/projects/{job['project_id']}/analyze", json={"target_duration": 5}
        ),
    )
    project = client.get(f"/api/projects/{job['project_id']}").json()
    assert project["duration"] == pytest.approx(12, abs=0.2)
    return job["project_id"], project


def test_demo_analysis_covers_source_without_out_of_range_clips(client):
    project_id, project = create_demo(client[0])
    clips = project["clips"]
    assert len(clips) > 1
    assert clips[0]["start"] == pytest.approx(0, abs=0.01)
    assert clips[-1]["end"] == pytest.approx(project["duration"], abs=0.05)
    assert all(0 <= c["start"] < c["end"] <= project["duration"] + 0.01 for c in clips)
    assert all(a["end"] <= b["start"] + 0.01 for a, b in zip(clips, clips[1:]))


def test_upload_multipart_respects_actual_five_second_duration(client, tmp_path):
    c, api = client
    source = tmp_path / "five.mp4"
    make_five_second_video(api, source)
    with source.open("rb") as f:
        result = wait_job(
            c,
            c.post(
                "/api/projects/upload",
                files={"file": ("five.mp4", f, "video/mp4")},
                data={"target_duration": "5"},
            ),
        )
    project = c.get(f"/api/projects/{result['project_id']}").json()
    assert project["duration"] == pytest.approx(5, abs=0.2)
    wait_job(
        c,
        c.post(
            f"/api/projects/{result['project_id']}/analyze", json={"target_duration": 5}
        ),
    )
    project = c.get(f"/api/projects/{result['project_id']}").json()
    assert project["clips"][-1]["end"] <= project["duration"] + 0.02


def test_upload_non_30fps_preserves_duration(client, tmp_path):
    c, api = client
    source = tmp_path / "twentyfour.mp4"
    api.media.run(
        [
            api.media.FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x360:r=24:d=5.25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=330:sample_rate=48000:duration=5.25",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(source),
        ]
    )
    with source.open("rb") as f:
        result = wait_job(
            c,
            c.post(
                "/api/projects/upload",
                files={"file": ("twentyfour.mp4", f, "video/mp4")},
                data={"target_duration": "5"},
            ),
        )
    project = c.get(f"/api/projects/{result['project_id']}").json()
    assert project["fps"] == pytest.approx(24, abs=0.2)
    assert project["duration"] == pytest.approx(5.25, abs=0.12)


def test_clip_edit_persists_and_rejects_invalid_bounds(client):
    c, _ = client
    project_id, project = create_demo(c)
    clip = project["clips"][0]
    edited = c.patch(
        f"/api/projects/{project_id}/clips/{clip['id']}",
        json={"start": 1.25, "end": 4.75, "title": "Edited range"},
    )
    assert edited.status_code == 200
    persisted = c.get(f"/api/projects/{project_id}").json()["clips"][0]
    assert persisted["start"] == pytest.approx(1.25)
    assert persisted["end"] == pytest.approx(4.75)
    invalid = c.patch(
        f"/api/projects/{project_id}/clips/{clip['id']}", json={"start": 0, "end": 99}
    )
    assert invalid.status_code in {400, 422}


def test_source_range_and_manual_caption_srt(client):
    c, api = client
    project_id, project = create_demo(c)
    source = c.get(
        f"/api/projects/{project_id}/source", headers={"Range": "bytes=0-31"}
    )
    assert source.status_code == 206
    assert source.headers["content-range"].startswith("bytes 0-31/")
    clip = project["clips"][0]
    saved = api.store.get(project_id)
    saved["transcript"] = [{"start": 0.2, "end": 1.4, "text": "Transcript text"}]
    api.store.save(saved)
    patched = c.patch(
        f"/api/projects/{project_id}/clips/{clip['id']}",
        json={"caption_text": "Manual caption"},
    )
    assert patched.status_code == 200
    srt = c.get(f"/api/projects/{project_id}/clips/{clip['id']}/captions")
    assert srt.status_code == 200
    assert "Manual caption" in srt.text
    assert "Transcript text" not in srt.text
    assert "00:00:00,000" in srt.text


def test_export_follow_and_fit_have_portrait_video_audio_and_zip(client):
    c, api = client
    project_id, project = create_demo(c)
    ids = [project["clips"][0]["id"], project["clips"][1]["id"]]
    first = c.patch(
        f"/api/projects/{project_id}/clips/{ids[0]}",
        json={"framing": "follow", "resolution": 180},
    ).json()
    second = c.patch(
        f"/api/projects/{project_id}/clips/{ids[1]}",
        json={"framing": "manual", "focus_x": 0.2, "resolution": 180},
    ).json()
    exported = wait_job(
        c, c.post(f"/api/projects/{project_id}/export", json={"clip_ids": ids})
    )
    for clip in (first, second):
        output = api.store.files / project_id / f"{clip['id']}.mp4"
        assert output.exists()
        metadata = api.media.probe(output)
        video = next(s for s in metadata["streams"] if s["codec_type"] == "video")
        assert int(video["width"]) == 180
        assert int(video["height"]) == 320
        assert any(s["codec_type"] == "audio" for s in metadata["streams"])
    archive = c.get(f"/api/projects/{project_id}/download")
    assert archive.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        assert sorted(z.namelist()) == sorted(
            [f"{first['title']}.mp4", f"{second['title']}.mp4"]
        )
    assert exported["download_url"].endswith("/download")


def test_demo_follow_render_moves_geometric_subject(client):
    c, api = client
    project_id, project = create_demo(c)
    source = api.store.files / f"{project_id}.mp4"
    source_centers = green_centers(source, [0, 2, 4])
    assert max(source_centers) - min(source_centers) > 0.15 * project["width"]
    clip = c.patch(
        f"/api/projects/{project_id}/clips/{project['clips'][0]['id']}",
        json={"framing": "follow", "resolution": 180},
    ).json()
    preview = wait_job(
        c, c.post(f"/api/projects/{project_id}/preview", json={"clip_id": clip["id"]})
    )
    response = c.get(preview["download_url"])
    assert response.status_code == 200
    assert response.headers["content-type"] == "video/mp4"
    output = api.store.files / project_id / f"preview-{clip['id']}-{preview['id']}.mp4"
    capture = cv2.VideoCapture(str(output))
    centers = []
    for _ in range(30):
        ok, frame = capture.read()
        if not ok:
            break
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, (35, 50, 100), (95, 255, 255))
        moments = cv2.moments(mask)
        assert moments["m00"]
        centers.append(moments["m10"] / moments["m00"] / frame.shape[1])
    capture.release()
    assert len(centers) >= 4
    assert all(0.15 <= center <= 0.85 for center in centers)


def test_youtube_rejects_non_youtube_host(client):
    response = client[0].post(
        "/api/projects/youtube", json={"url": "https://example.com/video"}
    )
    assert response.status_code == 400
