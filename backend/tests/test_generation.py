import httpx
import pytest

from backend import generation


def test_generation_download_does_not_forward_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_API_KEY", "test-key")
    monkeypatch.setenv("HF_API_SECRET", "test-secret")
    monkeypatch.setattr(generation, "public_output_url", lambda url: url)
    visited = []

    def handler(request):
        visited.append(str(request.url))
        if request.url.host == "api.higgsfield.ai":
            assert request.headers["authorization"] == "Key test-key:test-secret"
            if request.method == "POST":
                return httpx.Response(
                    200, json={"status": "queued", "request_id": "test-request"}
                )
            return httpx.Response(
                200,
                json={
                    "status": "completed",
                    "video": {"url": "https://cdn.example.com/result.mp4"},
                },
            )
        assert "authorization" not in request.headers
        return httpx.Response(200, content=b"test-video")

    client_class = httpx.Client
    monkeypatch.setattr(
        generation.httpx,
        "Client",
        lambda **kw: client_class(transport=httpx.MockTransport(handler), **kw),
    )
    output = tmp_path / "result.mp4"
    generation.generate_source(
        {"prompt": "A quiet sea", "duration": 5}, output, lambda *_: None
    )
    assert output.read_bytes() == b"test-video"
    assert len(visited) == 3


def test_private_output_url_is_rejected(monkeypatch):
    monkeypatch.setattr(
        generation.socket,
        "getaddrinfo",
        lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 443))],
    )
    with pytest.raises(RuntimeError, match="non-public"):
        generation.public_output_url("https://cdn.example.com/video.mp4")


def test_provider_credit_error_is_readable():
    with pytest.raises(RuntimeError, match="credits"):
        generation._json(httpx.Response(402))
