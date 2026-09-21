from pathlib import Path
from types import SimpleNamespace
import sys

import httpx
import pytest

from backend import config, settings, transcription


def test_effective_options_map_quality_and_algerian_context(monkeypatch):
    monkeypatch.delenv("CLIPFLOW_WHISPER_MODEL", raising=False)
    monkeypatch.delenv("CLIPFLOW_TRANSCRIPTION_QUALITY", raising=False)
    options = transcription.effective_options(
        {
            "provider": "local",
            "language": "auto",
            "dialect": "algerian",
            "quality": "accurate",
            "initial_prompt": "Names and places",
        }
    )
    assert options["language"] == "ar"
    assert options["model"] == "large-v3"
    assert "Algerian Darija" in options["initial_prompt"]
    assert len(options["initial_prompt"]) <= 500


def test_local_model_is_reused_and_receives_quality_options(monkeypatch, tmp_path):
    calls = []

    class Model:
        def __init__(self, *args, **kwargs):
            calls.append((args, kwargs))

        def transcribe(self, *_args, **kwargs):
            calls.append(kwargs)
            return iter([SimpleNamespace(start=0.2, end=1.0, text=" سلام ")]), None

    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model)
    )
    monkeypatch.setattr(transcription.importlib.util, "find_spec", lambda _: object())
    monkeypatch.setattr(transcription, "_MODEL_CACHE", transcription.OrderedDict())
    monkeypatch.setenv("CLIPFLOW_WHISPER_MODEL", "tiny")
    monkeypatch.setattr(
        config,
        "public_capabilities",
        lambda: {
            "transcription": {"provider": "local", "available": True, "message": ""}
        },
    )
    monkeypatch.setattr(
        transcription.media, "probe", lambda _: {"streams": [{"codec_type": "audio"}]}
    )
    source = tmp_path / "audio.wav"
    source.touch()
    options = {
        "provider": "local",
        "language": "ar",
        "dialect": "algerian",
        "quality": "balanced",
        "model": "tiny",
    }
    first = transcription.transcribe(source, 2, lambda *_: None, options)
    second = transcription.transcribe(source, 2, lambda *_: None, options)
    assert first == second == [{"start": 0.2, "end": 1.0, "text": "سلام"}]
    constructors = [
        item
        for item in calls
        if isinstance(item, tuple)
        and len(item) == 2
        and isinstance(item[1], dict)
        and "device" in item[1]
    ]
    assert len(constructors) == 1
    transcribe_kwargs = [item for item in calls if isinstance(item, dict)][0]
    assert transcribe_kwargs["language"] == "ar"
    assert transcribe_kwargs["task"] == "transcribe"
    assert transcribe_kwargs["condition_on_previous_text"] is False
    assert transcribe_kwargs["beam_size"] == 3
    assert constructors[0][1]["cpu_threads"] == 2
    assert "Algerian Darija" in transcribe_kwargs["initial_prompt"]


def test_missing_large_model_fails_before_download(monkeypatch, tmp_path):
    monkeypatch.setattr(transcription, "_model_is_cached", lambda *_: False)
    monkeypatch.setattr(
        transcription.shutil,
        "disk_usage",
        lambda *_: SimpleNamespace(free=100 * 1024 * 1024),
    )
    with pytest.raises(RuntimeError, match="larger drive|Groq"):
        transcription._local(
            tmp_path / "audio.wav",
            2,
            lambda *_: None,
            {
                "provider": "local",
                "model": "large-v3",
                "language": "ar",
                "quality": "accurate",
                "initial_prompt": "",
                "dialect": "none",
                "groq_model": "whisper-large-v3",
            },
        )


def test_model_readiness_reports_cached_models_and_free_space(monkeypatch, tmp_path):
    cache = tmp_path / "models"
    (cache / "faster-whisper-tiny").mkdir(parents=True)
    (cache / "faster-whisper-tiny" / "model.bin").write_bytes(b"cached")
    monkeypatch.setenv("CLIPFLOW_MODEL_CACHE", str(cache))
    monkeypatch.setattr(
        transcription.shutil,
        "disk_usage",
        lambda *_: SimpleNamespace(free=200 * 1024 * 1024, total=1, used=1),
    )
    readiness = transcription.model_readiness(
        tmp_path / "audio.wav", {"provider": "local", "quality": "auto"}
    )
    assert readiness["cached_models"] == ["tiny"]
    assert readiness["selected_model"] == "tiny"
    assert readiness["ready"] is True
    assert "quality may be lower" in readiness["warning"]
    assert readiness["free_bytes"] == 200 * 1024 * 1024


def test_model_readiness_never_downgrades_explicit_accurate(monkeypatch, tmp_path):
    monkeypatch.setenv("CLIPFLOW_MODEL_CACHE", str(tmp_path / "models"))
    monkeypatch.setattr(
        transcription.shutil,
        "disk_usage",
        lambda *_: SimpleNamespace(free=300 * 1024 * 1024, total=1, used=1),
    )
    readiness = transcription.model_readiness(
        tmp_path / "audio.wav", {"provider": "local", "quality": "accurate"}
    )
    assert readiness["requested_model"] == "large-v3"
    assert readiness["selected_model"] is None
    assert readiness["automatic"] is False


def test_mkl_memory_error_clears_model_cache_and_is_actionable(monkeypatch, tmp_path):
    class Model:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("mkl_malloc: cannot allocate memory")

    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model)
    )
    monkeypatch.setattr(
        transcription,
        "_MODEL_CACHE",
        transcription.OrderedDict({("old", "cpu", "int8", "cache"): object()}),
    )
    source = tmp_path / "audio.wav"
    with pytest.raises(RuntimeError, match="Fast/Quick draft|Groq|Close other apps"):
        transcription._local(
            source,
            2,
            lambda *_: None,
            {
                "provider": "local",
                "model": "tiny",
                "language": "ar",
                "quality": "balanced",
                "initial_prompt": "",
                "dialect": "none",
                "groq_model": "whisper-large-v3",
                "cpu_threads": 2,
            },
        )
    assert not transcription._MODEL_CACHE


def test_missing_vad_asset_does_not_expose_packaging_path(monkeypatch, tmp_path):
    private_path = r"C:\\Users\\tester\\build\\_internal\\faster_whisper\\assets\\silero_vad_v6.onnx"

    class Model:
        def __init__(self, *args, **kwargs):
            raise RuntimeError(
                f"[ONNXRuntimeError] : 3 : NO_SUCHFILE : Load model from {private_path} failed. File doesn't exist"
            )

    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model)
    )
    monkeypatch.setattr(transcription, "_MODEL_CACHE", transcription.OrderedDict())
    source = tmp_path / "audio.wav"

    with pytest.raises(RuntimeError) as caught:
        transcription._local(
            source,
            2,
            lambda *_: None,
            {
                "provider": "local",
                "model": "tiny",
                "language": "en",
                "quality": "fast",
                "initial_prompt": "",
                "dialect": "none",
                "groq_model": "whisper-large-v3-turbo",
                "cpu_threads": 2,
            },
        )

    message = str(caught.value)
    assert "latest Clipflow desktop package" in message
    assert private_path not in message


def test_bundled_model_is_ready_without_cache_space(monkeypatch, tmp_path):
    bundled = tmp_path / "bundle" / "small"
    bundled.mkdir(parents=True)
    for name in transcription.BUNDLED_MODEL_FILES:
        (bundled / name).write_bytes(b"model")
    monkeypatch.setenv("CLIPFLOW_BUNDLED_MODEL_DIR", str(bundled.parent))
    monkeypatch.setenv("CLIPFLOW_MODEL_CACHE", str(tmp_path / "empty-cache"))
    monkeypatch.setattr(
        transcription.shutil,
        "disk_usage",
        lambda *_: SimpleNamespace(free=0, total=1, used=1),
    )

    readiness = transcription.model_readiness(
        tmp_path / "audio.wav", {"provider": "local", "quality": "balanced"}
    )

    assert readiness["selected_model"] == "small"
    assert readiness["cached_models"] == ["small"]
    assert readiness["ready"] is True


def test_bundled_model_loads_from_disk_only(monkeypatch, tmp_path):
    calls = []

    class Model:
        def __init__(self, *args, **kwargs):
            calls.append((args, kwargs))

    bundled = tmp_path / "bundle" / "small"
    bundled.mkdir(parents=True)
    for name in transcription.BUNDLED_MODEL_FILES:
        (bundled / name).write_bytes(b"model")
    monkeypatch.setenv("CLIPFLOW_BUNDLED_MODEL_DIR", str(bundled.parent))
    monkeypatch.setitem(
        sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model)
    )
    monkeypatch.setattr(transcription, "_MODEL_CACHE", transcription.OrderedDict())

    loaded = transcription._load_local_model(
        tmp_path / "audio.wav",
        {"model": "small", "language": "auto", "cpu_threads": 2},
        lambda *_: None,
    )

    assert isinstance(loaded, Model)
    assert calls[0][0] == (str(bundled),)
    assert calls[0][1]["local_files_only"] is True


def test_groq_payload_uses_effective_language_model_and_prompt(monkeypatch, tmp_path):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200, json={"segments": [{"start": 0, "end": 1, "text": "Salam"}]}
        )

    monkeypatch.setenv("CLIPFLOW_TRANSCRIPTION_PROVIDER", "groq")
    monkeypatch.setenv("GROQ_API_KEY", "secret")
    client_class = httpx.Client
    monkeypatch.setattr(
        transcription.httpx,
        "Client",
        lambda **kw: client_class(transport=httpx.MockTransport(handler), **kw),
    )
    monkeypatch.setattr(
        transcription.media, "probe", lambda _: {"streams": [{"codec_type": "audio"}]}
    )
    monkeypatch.setattr(
        transcription.media,
        "run",
        lambda args, *_: Path(args[-1]).write_bytes(b"RIFFtest"),
    )
    source = tmp_path / "source.mp4"
    source.touch()
    rows = transcription.transcribe(
        source,
        2,
        lambda *_: None,
        {
            "provider": "groq",
            "language": "auto",
            "dialect": "algerian",
            "quality": "fast",
        },
    )
    assert rows[0]["text"] == "Salam"
    request = requests[0]
    assert request.content  # multipart body exists without exposing the key in logs
    assert b"whisper-large-v3-turbo" in request.content
    assert b"language" in request.content and b"ar" in request.content
    assert b"Algerian Darija" in request.content


def test_settings_validate_speech_preferences():
    with pytest.raises(ValueError):
        settings.save_settings({"transcription_language": "es"})
    with pytest.raises(ValueError):
        settings.save_settings({"transcription_prompt": "x" * 501})
    with pytest.raises(ValueError):
        settings.save_settings({"groq_whisper_model": "whisper-large-v3-mini"})
