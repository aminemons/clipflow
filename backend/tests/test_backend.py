import time
from pathlib import Path

import cv2
from fastapi.testclient import TestClient

from backend import app as api
from backend.app import app
from backend.media import make_demo, render_clip
from backend.store import Store


client = TestClient(app)


def wait_job(job_id: str, timeout: float = 45):
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        assert response.status_code == 200
        value = response.json()
        if value["status"] in {"done", "error"}:
            return value
        time.sleep(0.15)
    raise AssertionError("job timeout")


def test_health_contract():
    value = client.get("/api/health").json()
    assert {"ffmpeg", "ffprobe", "transcription"} <= value.keys()


def test_demo_analyze_and_srt():
    job = client.post("/api/projects/demo", json={"target_duration": 6}).json()
    result = wait_job(job["id"])
    assert result["status"] == "done", result
    analysis = client.post(
        f"/api/projects/{result['project_id']}/analyze", json={"target_duration": 6}
    ).json()
    analyzed = wait_job(analysis["id"])
    assert analyzed["status"] == "done", analyzed
    project = client.get(f"/api/projects/{result['project_id']}").json()
    assert project["duration"] >= 11
    assert project["clips"]
    clip = project["clips"][0]
    srt = client.get(f"/api/projects/{project['id']}/clips/{clip['id']}/captions")
    assert srt.status_code == 200


def test_youtube_host_allowlist():
    response = client.post(
        "/api/projects/youtube", json={"url": "https://example.com/video"}
    )
    assert response.status_code == 400


def test_job_summaries_persist_across_store_instances(tmp_path: Path):
    first = Store(tmp_path)
    value = {
        "id": "job1",
        "kind": "analyze_job",
        "status": "error",
        "stage": "error",
        "progress": 35,
        "args": ["project1", 30],
        "error": "server restarted",
    }
    first.save_jobs({"job1": value})
    second = Store(tmp_path)
    assert second.load_jobs()["job1"]["args"] == ["project1", 30]


def test_caption_burn_in_renders_visible_pixels(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "caption.mp4"
    make_demo(source)
    render_clip(
        source,
        {
            "start": 0,
            "end": 2,
            "framing": "fit",
            "resolution": 180,
            "caption_text": "CAPTION TEST",
            "caption_style": "bold",
            "caption_color": "#d6fb78",
        },
        output,
    )
    capture = cv2.VideoCapture(str(output))
    capture.set(cv2.CAP_PROP_POS_MSEC, 1000)
    ok, frame = capture.read()
    capture.release()
    assert ok
    roi = frame[int(frame.shape[0] * 0.65) :]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    bright_caption_pixels = cv2.inRange(hsv, (20, 40, 120), (100, 255, 255))
    assert int((bright_caption_pixels > 0).sum()) > 50


def test_caption_export_job_is_downloadable():
    created = client.post("/api/projects/demo", json={"target_duration": 6}).json()
    analyzed = wait_job(created["id"])
    analysis = client.post(
        f"/api/projects/{analyzed['project_id']}/analyze", json={"target_duration": 6}
    ).json()
    analyzed = wait_job(analysis["id"])
    project = client.get(f"/api/projects/{analyzed['project_id']}").json()
    clip = project["clips"][0]
    edited = client.patch(
        f"/api/projects/{project['id']}/clips/{clip['id']}",
        json={"caption_text": "API CAPTION", "resolution": 180},
    ).json()
    export_response = client.post(
        f"/api/projects/{project['id']}/export", json={"clip_ids": [edited["id"]]}
    )
    exported = wait_job(export_response.json()["id"])
    assert exported["status"] == "done", exported
    assert exported["download_url"].endswith("/download")
    output = Path(api.store.files) / project["id"] / f"{edited['id']}.mp4"
    assert output.exists()
    capture = cv2.VideoCapture(str(output))
    capture.set(cv2.CAP_PROP_POS_MSEC, 1000)
    ok, frame = capture.read()
    capture.release()
    assert ok
    roi = frame[int(frame.shape[0] * 0.65) :]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    assert int((cv2.inRange(hsv, (20, 40, 120), (100, 255, 255)) > 0).sum()) > 50
