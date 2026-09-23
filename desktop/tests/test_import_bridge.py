from __future__ import annotations

import pytest

from desktop import import_bridge as bridge


TOKEN = "a" * 32
LINK = f"clipflow://import?ticket={TOKEN}&server=https%3A%2F%2Fclipflow-aminemons.swedencentral.cloudapp.azure.com"


def test_link_parser_accepts_default_worker(monkeypatch):
    monkeypatch.delenv("CLIPFLOW_TRUSTED_WORKER_ORIGINS", raising=False)
    assert bridge._parse_link(LINK) == (TOKEN, bridge.DEFAULT_WORKER_ORIGINS[0])


@pytest.mark.parametrize("link", [
    f"clipflow://import?ticket={TOKEN}&server=https%3A%2F%2Fevil.example",
    f"clipflow://import?ticket={TOKEN}&server=http%3A%2F%2Fclipflow-aminemons.swedencentral.cloudapp.azure.com",
    f"clipflow://import?ticket={TOKEN}&server=https%3A%2F%2Fclipflow-aminemons.swedencentral.cloudapp.azure.com%2Fpath",
    f"clipflow://import?ticket=short&server=https%3A%2F%2Fclipflow-aminemons.swedencentral.cloudapp.azure.com",
])
def test_link_parser_rejects_untrusted_or_invalid_link_before_request(link):
    with pytest.raises(bridge.ImportBridgeError):
        bridge._parse_link(link)


def test_custom_worker_allowlist_is_supported(monkeypatch):
    monkeypatch.setenv("CLIPFLOW_TRUSTED_WORKER_ORIGINS", "https://worker.example")
    link = f"clipflow://import?ticket={TOKEN}&server=https%3A%2F%2Fworker.example"
    assert bridge._parse_link(link) == (TOKEN, "https://worker.example")


def test_import_ticket_downloads_then_posts_to_same_trusted_origin(tmp_path, monkeypatch):
    video = tmp_path / "sample.mp4"
    video.write_bytes(b"mp4")
    monkeypatch.setattr(bridge, "_download", lambda _url, _target, _quality: video)
    requests = []

    class Response:
        def __init__(self, body):
            self.body = body

        def raise_for_status(self):
            pass

        def json(self):
            return self.body

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get(self, url, **kwargs):
            requests.append(("GET", url, kwargs))
            return Response({
                "url": "https://www.youtube.com/watch?v=abc123",
                "quality": 720, "web_origin": bridge.DEFAULT_WEB_ORIGINS[0],
            })

        def post(self, url, **kwargs):
            requests.append(("POST", url, kwargs))
            return Response({"project_id": "project_123"})

    monkeypatch.setattr(bridge.httpx, "Client", Client)
    editor = bridge.import_ticket(LINK)

    expected = bridge.DEFAULT_WORKER_ORIGINS[0]
    assert editor == f"{bridge.DEFAULT_WEB_ORIGINS[0]}/#/editor/project_123"
    assert [item[0] for item in requests] == ["GET", "POST"]
    assert all(item[1].startswith(expected) for item in requests)
    assert all(item[2]["headers"]["Authorization"] == f"Bearer {TOKEN}" for item in requests)
    assert requests[1][2]["data"] == {"quality": 720}
    assert "file" in requests[1][2]["files"]


def test_untrusted_web_origin_rejected_before_download(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "_download", lambda *_args: pytest.fail("must not download"))

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"url": "https://youtu.be/abc123", "quality": 720, "web_origin": "https://evil.example"}

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(bridge.httpx, "Client", Client)
    with pytest.raises(bridge.ImportBridgeError, match="untrusted Clipflow website"):
        bridge.import_ticket(LINK)


@pytest.mark.parametrize("url", ["https://example.com/video", "not a URL", "https://youtube.com.evil.example/watch?v=x"])
def test_youtube_url_validation_rejects_non_youtube_hosts(url):
    with pytest.raises(bridge.ImportBridgeError):
        bridge._valid_youtube_url(url)


@pytest.mark.parametrize("quality", [360, 720, 1080])
def test_download_format_applies_requested_height_cap(quality, tmp_path, monkeypatch):
    import sys
    import types

    observed = {}
    target = tmp_path / "video.mp4"

    class YDL:
        def __init__(self, options):
            observed.update(options)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def extract_info(self, _url, download):
            assert download is True
            target.write_bytes(b"mp4")
            return {"id": "clip"}

        def prepare_filename(self, _info):
            return str(target)

    monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=YDL))
    assert bridge._download("https://youtube.com/watch?v=abc", tmp_path, quality) == target
    assert f"height<={quality}" in observed["format"]
