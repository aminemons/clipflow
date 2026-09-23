import sys
import shutil
import time
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app as api
from backend.media import make_demo
from backend.source_probe import (
    YTDLP_FAQ_URL,
    YouTubeSourceError,
    classify_youtube_error,
    format_selector,
    probe_youtube,
)
from backend.store import Store


def _wait(client: TestClient, job_id: str):
    deadline = time.time() + 10
    while time.time() < deadline:
        value = client.get(f"/api/jobs/{job_id}").json()
        if value["status"] in {"done", "error"}:
            return value
        time.sleep(0.02)
    raise AssertionError("job timeout")


def test_probe_extracts_metadata_and_caps_quality_choices(monkeypatch):
    class FakeYoutubeDL:
        options = None

        def __init__(self, options):
            FakeYoutubeDL.options = options

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, url, download=False):
            assert url == "https://youtu.be/abc123"
            assert download is False
            return {
                "title": "Sample",
                "duration": 42,
                "width": 1920,
                "height": 1080,
                "formats": [
                    {"height": 360, "vcodec": "avc1"},
                    {"height": 720, "vcodec": "vp9"},
                ],
            }

    monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))
    result = probe_youtube("https://youtu.be/abc123")
    assert result["title"] == "Sample"
    assert result["duration"] == 42
    assert result["qualities"] == [360, 720]
    assert FakeYoutubeDL.options["noplaylist"] is True
    assert FakeYoutubeDL.options["skip_download"] is True
    assert "height<=720" in format_selector(720)


def test_probe_keeps_low_resolution_actual_height(monkeypatch):
    class FakeYoutubeDL:
        def __init__(self, _options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _url, download=False):
            assert download is False
            return {"title": "Low", "formats": [{"height": 144, "vcodec": "vp9"}]}

    monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))
    assert probe_youtube("https://youtu.be/low")['qualities'] == [144]


def test_probe_classifies_antibot_error_without_leaking_provider_text(monkeypatch):
    class FakeYoutubeDL:
        def __init__(self, _options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _url, download=False):
            raise RuntimeError("[youtube] Sign in to confirm you're not a bot: https://secret.example/token")

    monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))
    try:
        probe_youtube("https://youtu.be/blocked")
    except YouTubeSourceError as exc:
        assert exc.code == "youtube_anti_bot"
        assert exc.help_url == YTDLP_FAQ_URL
        assert "secret.example" not in str(exc)
        assert exc.as_dict()["operation"] == "inspect"
    else:
        raise AssertionError("anti-bot error was not classified")


def test_probe_retries_antibot_with_browser_transport(monkeypatch):
    attempts = []

    class FakeYoutubeDL:
        def __init__(self, options):
            self.options = options
            attempts.append(options)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _url, download=False):
            assert download is False
            if len(attempts) == 1:
                raise RuntimeError("Sign in to confirm you're not a bot")
            return {
                "title": "Recovered",
                "duration": 12,
                "height": 720,
                "formats": [{"height": 720, "vcodec": "avc1"}],
            }

    monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))

    result = probe_youtube("https://youtu.be/retry")

    assert result["title"] == "Recovered"
    assert len(attempts) == 2
    if "impersonate" in attempts[1]:
        assert str(attempts[1]["impersonate"]) == "chrome"
    assert attempts[1]["extractor_args"]["youtube"]["player_client"] == [
        "web_safari"
    ]


def test_classify_download_error_has_stable_actionable_shape():
    error = classify_youtube_error(
        RuntimeError("ERROR: Sign in to confirm you're not a bot"), "download"
    )
    assert error.code == "youtube_anti_bot"
    assert error.operation == "download"
    assert error.retryable is True
    assert set(error.as_dict()) == {
        "code", "message", "operation", "help_url", "retryable"
    }
    refused = classify_youtube_error(ConnectionRefusedError("Connection refused"))
    assert refused.code == "youtube_network"
    assert refused.retryable is True


def test_upload_job_only_prepares_source_and_keeps_clips_empty(monkeypatch, tmp_path: Path):
    old_store, old_data = api.store, api.DATA
    old_jobs = api.jobs
    try:
        api.store = Store(tmp_path)
        api.DATA = tmp_path
        api.jobs = {}
        monkeypatch.setattr(api, "analyze_job", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("upload analyzed")))
        source = tmp_path / "sample.mp4"
        make_demo(source)
        client = TestClient(api.app)
        with source.open("rb") as stream:
            response = client.post(
                "/api/projects/upload",
                files={"file": ("sample.mp4", stream, "video/mp4")},
            )
        assert response.status_code == 200
        job = _wait(client, response.json()["id"])
        assert job["status"] == "done", job
        project = client.get(f"/api/projects/{job['project_id']}").json()
        assert project["clips"] == []
    finally:
        api.store, api.DATA, api.jobs = old_store, old_data, old_jobs


def test_source_serving_survives_windows_virtualized_resolve(monkeypatch, tmp_path: Path):
    old_store = api.store
    try:
        api.store = Store(tmp_path)
        project_id = "project-source"
        source = api.store.files / f"{project_id}.mp4"
        source.write_bytes(b"video")
        api.store.save({"id": project_id, "title": "Source", "clips": []})

        original_resolve = Path.resolve

        def virtualized_resolve(path, *args, **kwargs):
            if path == source:
                return Path("C:/Users/test/AppData/Local/Packages/Clipflow/LocalCache") / source.name
            return original_resolve(path, *args, **kwargs)

        monkeypatch.setattr(Path, "resolve", virtualized_resolve)
        assert api.source_path(project_id) == source.absolute()
    finally:
        api.store = old_store


def test_youtube_project_passes_selected_quality_without_analyzing(monkeypatch, tmp_path: Path):
    old_store = api.store
    try:
        api.store = Store(tmp_path)
        captured = {}

        def submit(*args):
            captured["args"] = args
            return {"id": "job", "project_id": args[0]}

        monkeypatch.setattr(api, "submit", submit)
        client = TestClient(api.app)
        response = client.post(
            "/api/projects/youtube",
            json={"url": "https://www.youtube.com/watch?v=abc123", "quality": 360},
        )
        assert response.status_code == 200
        project = api.store.get(captured["args"][0])
        assert project["clips"] == []
        assert captured["args"][-1] == 360
    finally:
        api.store = old_store


def test_youtube_job_downloads_selected_low_height_without_analysis(monkeypatch, tmp_path: Path):
    old_store, old_data, old_jobs = api.store, api.DATA, api.jobs
    try:
        api.store = Store(tmp_path)
        api.DATA = tmp_path
        api.jobs = {}
        source_fixture = tmp_path / "fixture.mp4"
        make_demo(source_fixture)
        pid = api.store.create_id()
        (api.store.files / f"{pid}.mp4").touch()
        api.store.save({"id": pid, "title": "YouTube import", "clips": []})
        observed = {}

        class FakeYoutubeDL:
            def __init__(self, options):
                observed.update(options)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download=True):
                assert download is True
                output = Path(observed["outtmpl"].replace("%(ext)s", "mp4"))
                shutil.copy2(source_fixture, output)
                return {"title": "Imported"}

        monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))
        monkeypatch.setattr(api, "analyze_job", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("YouTube analyzed")))
        item = {"id": "youtube-job", "project_id": pid}
        result = api.youtube_job(item, pid, "https://youtu.be/abc", 30, 144)
        assert result == {}
        assert "height<=144" in observed["format"]
        assert api.store.get(pid)["clips"] == []
    finally:
        api.store, api.DATA, api.jobs = old_store, old_data, old_jobs


def test_youtube_job_classifies_antibot_download_failure(monkeypatch, tmp_path: Path):
    old_store, old_data, old_jobs = api.store, api.DATA, api.jobs
    try:
        api.store = Store(tmp_path)
        api.DATA = tmp_path
        api.jobs = {}
        pid = api.store.create_id()
        (api.store.files / f"{pid}.mp4").touch()
        api.store.save({"id": pid, "title": "YouTube import", "clips": []})

        class FakeYoutubeDL:
            def __init__(self, _options):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download=True):
                raise RuntimeError("Sign in to confirm you're not a bot")

        monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))
        with pytest.raises(YouTubeSourceError) as raised:
            api.youtube_job({"id": "youtube-job", "project_id": pid}, pid, "https://youtu.be/abc", 30, 360)
        assert raised.value.code == "youtube_anti_bot"
        assert raised.value.operation == "download"
        assert list(api.store.files.glob(f"{pid}.download.*")) == []
    finally:
        api.store, api.DATA, api.jobs = old_store, old_data, old_jobs


def test_source_inspect_rejects_host_and_reports_probe_failure(monkeypatch):
    client = TestClient(api.app)
    invalid = client.post("/api/sources/youtube/inspect", json={"url": "https://example.com/video"})
    assert invalid.status_code == 400
    monkeypatch.setattr(
        api,
        "probe_youtube",
        lambda _url: (_ for _ in ()).throw(
            RuntimeError("HTTP Error 403: https://signed.example/private-token")
        ),
    )
    failed = client.post("/api/sources/youtube/inspect", json={"url": "https://youtu.be/abc"})
    assert failed.status_code == 502
    assert failed.json()["detail"]["code"] == "youtube_provider_error"
    assert "signed.example" not in str(failed.json()["detail"])
    assert "private-token" not in str(failed.json()["detail"])


def test_failed_youtube_job_discards_only_its_unready_project(monkeypatch, tmp_path: Path):
    old_store, old_data = api.store, api.DATA
    old_jobs, old_cancel_events = api.jobs, api.cancel_events
    try:
        api.store = Store(tmp_path)
        api.DATA = tmp_path
        api.jobs = {}
        api.cancel_events = {}
        pid = api.store.create_id()
        source = api.store.files / f"{pid}.mp4"
        source.touch()
        api.store.save(
            {
                "id": pid,
                "title": "YouTube import",
                "duration": 0,
                "width": 0,
                "height": 0,
                "fps": 0,
                "source_origin_url": "https://youtu.be/abc",
                "source_quality": 360,
                "clips": [],
            }
        )

        class FakeYoutubeDL:
            def __init__(self, _options):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download=True):
                raise RuntimeError("HTTP Error 500: https://signed.example/private-token")

        monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))
        item = {"id": "youtube-job", "kind": "youtube_job", "project_id": pid}
        api._run_job(item, api.youtube_job, pid, "https://youtu.be/abc", 30, 360)

        assert item["status"] == "error"
        assert api.store.get(pid) is None
        assert not source.exists()
        assert "youtube-job" in api.jobs  # Keep the terminal failure visible to polling.
    finally:
        api.store, api.DATA = old_store, old_data
        api.jobs, api.cancel_events = old_jobs, old_cancel_events


def test_youtube_metadata_validation_failure_removes_download_and_project(monkeypatch, tmp_path: Path):
    old_store, old_data = api.store, api.DATA
    old_jobs, old_cancel_events = api.jobs, api.cancel_events
    try:
        api.store = Store(tmp_path)
        api.DATA = tmp_path
        api.jobs = {}
        api.cancel_events = {}
        pid = api.store.create_id()
        source = api.store.files / f"{pid}.mp4"
        source.touch()
        api.store.save(
            {
                "id": pid,
                "title": "YouTube import",
                "duration": 0,
                "width": 0,
                "height": 0,
                "fps": 0,
                "source_origin_url": "https://youtu.be/abc",
                "source_quality": 360,
                "clips": [],
            }
        )

        class FakeYoutubeDL:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, download=True):
                assert download is True
                output = Path(self.options["outtmpl"].replace("%(ext)s", "mp4"))
                output.write_bytes(b"downloaded but invalid media")
                return {"title": "Downloaded title"}

        monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYoutubeDL))
        monkeypatch.setattr(api, "metadata", lambda _path: (0, 0, 0, 0))
        item = {"id": "youtube-metadata-job", "kind": "youtube_job", "project_id": pid}
        api._run_job(item, api.youtube_job, pid, "https://youtu.be/abc", 30, 360)

        assert item["status"] == "error"
        assert api.store.get(pid) is None
        assert not source.exists()
        assert list(api.store.files.glob(f"{pid}.download.*")) == []
    finally:
        api.store, api.DATA = old_store, old_data
        api.jobs, api.cancel_events = old_jobs, old_cancel_events


def test_retry_youtube_recreates_deleted_import_but_reuses_existing_project(monkeypatch, tmp_path: Path):
    old_store, old_data = api.store, api.DATA
    old_jobs, old_cancel_events = api.jobs, api.cancel_events
    try:
        api.store = Store(tmp_path)
        api.DATA = tmp_path
        missing_id = "missing123"
        existing_id = "existing123"
        api.store.save({"id": existing_id, "title": "Existing", "clips": []})
        api.jobs = {
            "failed-missing": {
                "id": "failed-missing",
                "kind": "youtube_job",
                "status": "error",
                "project_id": missing_id,
                "args": [missing_id, "https://youtu.be/abc", 45, 360],
            },
            "failed-existing": {
                "id": "failed-existing",
                "kind": "youtube_job",
                "status": "error",
                "project_id": existing_id,
                "args": [existing_id, "https://youtu.be/def", 60, 720],
            },
        }
        api.cancel_events = {}

        class CapturingExecutor:
            def __init__(self):
                self.calls = []

            def submit(self, fn, *args):
                self.calls.append((fn, args))

        executor = CapturingExecutor()
        monkeypatch.setattr(api, "executor", executor)
        client = TestClient(api.app)

        recreated = client.post("/api/jobs/failed-missing/retry")
        assert recreated.status_code == 200
        new_id = recreated.json()["project_id"]
        assert new_id != missing_id
        assert api.store.get(new_id)["source_origin_url"] == "https://youtu.be/abc"
        assert api.store.get(new_id)["source_quality"] == 360
        assert executor.calls[0][1][1:] == (
            api.youtube_job,
            new_id,
            "https://youtu.be/abc",
            45,
            360,
        )

        retried = client.post("/api/jobs/failed-existing/retry")
        assert retried.status_code == 200
        assert retried.json()["project_id"] == existing_id
        assert executor.calls[1][1][1:] == (
            api.youtube_job,
            existing_id,
            "https://youtu.be/def",
            60,
            720,
        )
    finally:
        api.store, api.DATA = old_store, old_data
        api.jobs, api.cancel_events = old_jobs, old_cancel_events


def test_source_inspect_returns_structured_classified_failure(monkeypatch):
    client = TestClient(api.app)
    monkeypatch.setattr(
        api,
        "probe_youtube",
        lambda _url: (_ for _ in ()).throw(
            YouTubeSourceError(
                "youtube_anti_bot",
                "YouTube blocked this request.",
                operation="inspect",
                help_url=YTDLP_FAQ_URL,
                retryable=True,
            )
        ),
    )
    response = client.post(
        "/api/sources/youtube/inspect", json={"url": "https://youtu.be/abc"}
    )
    assert response.status_code == 502
    assert response.json()["detail"] == {
        "code": "youtube_anti_bot",
        "message": "YouTube blocked this request.",
        "operation": "inspect",
        "help_url": YTDLP_FAQ_URL,
        "retryable": True,
    }
