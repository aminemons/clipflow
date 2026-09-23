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


def test_groq_word_timestamps_are_attached_to_the_matching_segment(monkeypatch, tmp_path):
    def handler(request):
        body = request.content.decode("utf-8", errors="replace")
        assert 'name="timestamp_granularities[]"' in body
        assert "word" in body and "segment" in body
        return httpx.Response(
            200,
            json={
                "segments": [
                    {"start": 0, "end": 1.4, "text": "First thought."},
                    {"start": 1.4, "end": 3, "text": "Second thought."},
                ],
                "words": [
                    {"start": 0.2, "end": 0.6, "word": "First"},
                    {"start": 0.7, "end": 1.1, "word": "thought."},
                    {"start": 1.6, "end": 2, "word": "Second"},
                    {"start": 2.1, "end": 2.6, "word": "thought."},
                ],
            },
        )

    source = setup_groq(monkeypatch, tmp_path, handler)
    rows = transcription.transcribe(source, 3, lambda *_: None)
    assert [word["text"] for word in rows[0]["words"]] == ["First", "thought."]
    assert [word["text"] for word in rows[1]["words"]] == ["Second", "thought."]
    assert rows[1]["words"][0]["start"] == 1.6


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


def test_local_transcription_preserves_word_timestamps(monkeypatch, tmp_path):
    monkeypatch.setattr(transcription, "_MODEL_CACHE", transcription.OrderedDict())

    class Model:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, *args, **kwargs):
            assert kwargs["word_timestamps"] is True
            segment = SimpleNamespace(
                start=0.2,
                end=1.8,
                text=" hello world ",
                words=[
                    SimpleNamespace(start=0.3, end=0.7, word=" hello"),
                    SimpleNamespace(start=0.8, end=1.2, word=" world"),
                    SimpleNamespace(start=float("nan"), end=1.4, word=" invalid"),
                ],
            )
            return iter([segment]), None

    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model)
    )
    rows = transcription._local(tmp_path / "source.mp4", 2, lambda *_: None)
    assert rows == [
        {
            "start": 0.2,
            "end": 1.8,
            "text": "hello world",
            "words": [
                {"start": 0.3, "end": 0.7, "text": "hello"},
                {"start": 0.8, "end": 1.2, "text": "world"},
            ],
        }
    ]


def test_quick_local_draft_skips_word_alignment(monkeypatch, tmp_path):
    monkeypatch.setattr(transcription, "_MODEL_CACHE", transcription.OrderedDict())

    class Model:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, *args, **kwargs):
            assert kwargs["word_timestamps"] is False
            return iter([SimpleNamespace(start=0, end=1, text=" draft ")]), None

    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model)
    )
    rows = transcription._local(
        tmp_path / "source.mp4", 1, lambda *_: None,
        transcription.effective_options({"quality": "fast", "provider": "local"}),
    )
    assert rows == [{"start": 0, "end": 1, "text": "draft"}]
