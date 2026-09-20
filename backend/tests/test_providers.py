"""Provider contracts without paid requests or downloaded models."""

from pathlib import Path
from types import SimpleNamespace
import sys

import httpx
import pytest

from backend import config, transcription


def test_capabilities_never_expose_secrets(monkeypatch):
    # Keep the contract independent of a user's saved provider toggle.
    monkeypatch.setenv("CLIPFLOW_HIGGSFIELD_ENABLED", "true")
    monkeypatch.setenv("CLIPFLOW_TRANSCRIPTION_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_API_KEY", "test-secret-groq")
    monkeypatch.setenv("HF_API_KEY", "test-secret-hf")
    monkeypatch.setenv("HF_API_SECRET", "test-secret-signature")
    result = config.public_capabilities()
    assert result["transcription"]["available"]
    assert result["higgsfield"]["configured"]
    assert "test-secret" not in str(result)


def setup_groq(monkeypatch, tmp_path, handler):
    monkeypatch.setenv("CLIPFLOW_TRANSCRIPTION_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_API_KEY", "private-key")
    source = tmp_path / "source.mp4"
    source.touch()
    monkeypatch.setattr(
        transcription.media, "probe", lambda _: {"streams": [{"codec_type": "audio"}]}
    )
    monkeypatch.setattr(
        transcription.media,
        "run",
        lambda args, *_: Path(args[-1]).write_bytes(b"RIFFtest"),
    )
    client_class = httpx.Client
    monkeypatch.setattr(
        transcription.httpx,
        "Client",
        lambda **kw: client_class(transport=httpx.MockTransport(handler), **kw),
    )
    return source


def test_hosted_chunks_shift_timestamps_and_remove_audio(monkeypatch, tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.headers["authorization"] == "Bearer private-key"
        assert request.url == transcription.GROQ_URL
        return httpx.Response(
            200, json={"segments": [{"start": 1, "end": 4, "text": "Hello"}]}
        )

    source = setup_groq(monkeypatch, tmp_path, handler)
    rows = transcription.transcribe(source, 610, lambda *_: None)
    assert [row["start"] for row in rows] == [1, 601]
    assert len(requests) == 2
    assert list(tmp_path.iterdir()) == [source]


def test_bad_key_is_actionable_without_leaking_it(monkeypatch, tmp_path):
    source = setup_groq(monkeypatch, tmp_path, lambda _: httpx.Response(401))
    with pytest.raises(RuntimeError, match="GROQ_API_KEY") as error:
        transcription.transcribe(source, 5, lambda *_: None)
    assert "private-key" not in str(error.value)
    assert list(tmp_path.iterdir()) == [source]


def test_local_transcription_returns_timestamped_segments(monkeypatch, tmp_path):
    class Model:
        def __init__(self, *args, **kwargs):
            assert kwargs["device"] == "cpu"

        def transcribe(self, *args, **kwargs):
            return iter([SimpleNamespace(start=0.2, end=1.8, text=" hello ")]), None

    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model)
    )
    rows = transcription._local(tmp_path / "source.mp4", 2, lambda *_: None)
    assert rows == [{"start": 0.2, "end": 1.8, "text": "hello"}]
