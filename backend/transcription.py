"""Timestamped speech recognition, with bounded audio chunks for hosted uploads."""

from __future__ import annotations

import gc
import math
import importlib.util
import os
import shutil
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

import httpx

from . import media
from .config import public_capabilities, value

Progress = Callable[[str, int], None]
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
LOCAL_MODELS = ("tiny", "base", "small", "medium", "large-v3", "large-v3-turbo")
GROQ_MODELS = ("whisper-large-v3", "whisper-large-v3-turbo")
QUALITY_MODELS = {"fast": "tiny", "balanced": "small", "accurate": "large-v3"}
GROQ_QUALITY_MODELS = {
    "fast": "whisper-large-v3-turbo",
    "balanced": "whisper-large-v3",
    "accurate": "whisper-large-v3",
}
_MODEL_CACHE: OrderedDict[tuple[str, str, str, str], Any] = OrderedDict()
_MODEL_LOCK = threading.Lock()
_MODEL_CACHE_LIMIT = 1

# Conservative compressed download estimates.  These are used only to decide
# whether it is safe to start a download; a cached model is always preferred.
MODEL_REQUIREMENTS_MB = {
    # Leave room for extraction, CTranslate2 buffers, and an interrupted
    # download; the model itself is smaller than this safety allowance.
    "tiny": 400,
    "base": 500,
    "small": 1_000,
    "medium": 2_000,
    "large-v3": 4_000,
    "large-v3-turbo": 1_500,
}


def _emit(progress: Progress, message: str, percent: int) -> None:
    """Report progress and honor both callback cancellation and job cancellation."""
    media._check_cancel()
    if progress(message, max(0, min(99, int(percent)))) is False:
        raise RuntimeError("job cancelled")


def effective_options(options: dict | None = None) -> dict:
    """Normalize UI/provider options into the stable contract used by both paths.

    Returned keys are ``language`` (``auto`` or an ISO code), ``dialect``,
    ``quality``, ``model``, ``initial_prompt``, and ``provider``. The helper is
    intentionally side-effect free so the job layer can fingerprint it before
    starting transcription.
    """
    raw = options if isinstance(options, dict) else {}
    language = (
        str(
            raw.get(
                "language",
                raw.get("transcription_language", value("CLIPFLOW_LANGUAGE", "auto")),
            )
            or "auto"
        )
        .lower()
        .strip()
    )
    if language not in {"auto", "ar", "fr", "en"}:
        raise ValueError("language must be auto, ar, fr, or en")
    dialect = (
        str(
            raw.get(
                "dialect",
                raw.get("transcription_dialect", value("CLIPFLOW_DIALECT", "none")),
            )
            or "none"
        )
        .lower()
        .strip()
    )
    if dialect not in {"none", "algerian"}:
        raise ValueError("dialect must be none or algerian")
    quality_raw = raw.get("quality", raw.get("transcription_quality"))
    configured_quality = value("CLIPFLOW_TRANSCRIPTION_QUALITY", "")
    quality_default = (
        "accurate" if dialect == "algerian" and not configured_quality else "balanced"
    )
    quality = (
        str(
            quality_raw
            if quality_raw is not None
            else configured_quality or quality_default
        )
        .lower()
        .strip()
    )
    automatic_quality = quality == "auto"
    if automatic_quality:
        quality = "balanced"
    if quality not in QUALITY_MODELS:
        raise ValueError("quality must be fast, balanced, or accurate")
    if dialect == "algerian" and language == "auto":
        language = "ar"
    explicit_model = raw.get("model")
    if explicit_model is None:
        # A caller-selected quality must win over a legacy explicit tiny model
        # left in .env; the env model is only a fallback when quality is absent.
        explicit_model = (
            "" if quality_raw is not None else value("CLIPFLOW_WHISPER_MODEL", "")
        )
    model = str(explicit_model or QUALITY_MODELS[quality]).strip()
    if model not in LOCAL_MODELS:
        raise ValueError("unsupported local Whisper model")
    prompt = raw.get(
        "initial_prompt",
        raw.get("transcription_prompt", value("CLIPFLOW_TRANSCRIPTION_PROMPT", "")),
    )
    if prompt is None:
        prompt = ""
    if (
        not isinstance(prompt, str)
        or len(prompt) > 500
        or any(ord(c) < 32 and c not in "\t" for c in prompt)
    ):
        raise ValueError("initial_prompt must be at most 500 characters")
    if dialect == "algerian":
        hint = "Algerian Darija in Arabic script or Latin transliteration. Keep words as spoken; do not translate."
        if hint not in prompt:
            prompt = (f"{prompt.strip()} {hint}").strip()[:500]
    provider = str(raw.get("provider", "") or "").lower().strip()
    if not provider:
        provider = public_capabilities()["transcription"]["provider"]
    if provider not in {"local", "groq"}:
        raise ValueError("provider must be local or groq")
    groq_raw = raw.get("groq_model", raw.get("groq_whisper_model"))
    if groq_raw is None:
        groq_raw = (
            GROQ_QUALITY_MODELS[quality]
            if quality_raw is not None
            else value("GROQ_WHISPER_MODEL", "")
        )
    groq_model = str(groq_raw or GROQ_QUALITY_MODELS[quality]).strip()
    if groq_model not in GROQ_MODELS:
        raise ValueError("unsupported Groq Whisper model")
    try:
        cpu_threads = max(
            1,
            min(8, int(raw.get("cpu_threads", value("CLIPFLOW_WHISPER_THREADS", "2")))),
        )
    except (TypeError, ValueError):
        cpu_threads = 2
    return {
        "language": language,
        "dialect": dialect,
        "quality": quality,
        "model": model,
        "initial_prompt": prompt,
        "provider": provider,
        "groq_model": groq_model,
        "cpu_threads": cpu_threads,
        "_automatic_quality": automatic_quality,
    }


def _memory_failure(exc: BaseException) -> bool:
    message = str(exc).lower()
    return (
        isinstance(exc, MemoryError)
        or "mkl_malloc" in message
        or "cannot allocate memory" in message
    )


def _clear_model_cache() -> None:
    with _MODEL_LOCK:
        _MODEL_CACHE.clear()
    gc.collect()


_MEMORY_MESSAGE = (
    "Local Whisper ran out of memory. Close other apps and retry, choose the Fast/Quick draft option, "
    "or use Groq transcription. The model was not silently changed."
)


def transcribe(
    source: Path, duration: float, progress: Progress, options: dict | None = None
) -> list[dict]:
    effective = effective_options(options)
    capability = public_capabilities()["transcription"]
    provider = (
        effective["provider"]
        if options and "provider" in options
        else capability["provider"]
    )
    if provider == "groq":
        if not value("GROQ_API_KEY"):
            raise RuntimeError("Add GROQ_API_KEY to .env and restart Clipflow.")
    elif not importlib.util.find_spec("faster_whisper"):
        raise RuntimeError(
            "Install backend/requirements.txt to enable on-device transcription."
        )
    if not any(
        s.get("codec_type") == "audio" for s in media.probe(source).get("streams", [])
    ):
        raise RuntimeError(
            "This video has no audio track. You can still add captions manually."
        )
    if provider == "groq":
        rows = _groq(source, duration, progress, effective)
    else:
        rows = _local(source, duration, progress, effective)
    if not rows:
        raise RuntimeError(
            "No speech was detected in this video. Add captions manually, or set CLIPFLOW_LANGUAGE in .env and retry."
        )
    return rows


def _cache_root(source: Path) -> Path:
    configured = value("CLIPFLOW_MODEL_CACHE", "") or value("HF_HOME", "")
    # Prefer an explicit persistent model cache: clip-scoped source paths can
    # move between jobs and must never determine where multi-GB models land.
    return Path(configured or str(source.parent.parent / "models"))


def _model_is_cached(cache_root: Path, model: str) -> bool:
    names = (
        f"faster-whisper-{model}",
        f"models--Systran--faster-whisper-{model}",
        model,
    )
    for root in (cache_root, cache_root / "hub"):
        for name in names:
            candidate = root / name
            if (candidate / "model.bin").exists():
                return True
            if any(candidate.glob("snapshots/*/model.bin")):
                return True
    return False


def _free_bytes(path: Path) -> int:
    try:
        probe = path
        while not probe.exists() and probe.parent != probe:
            probe = probe.parent
        return int(shutil.disk_usage(probe).free)
    except OSError:
        return 0


def model_readiness(
    source: Path, options: dict | None = None
) -> dict[str, Any]:
    """Describe whether local speech can run without starting a download.

    ``automatic`` is true only when the caller did not select a model or
    quality.  This lets the one-click path pick a usable cached/downloadable
    model while preserving an explicit Accurate/large model request.
    """
    raw = options if isinstance(options, dict) else {}
    effective = effective_options(raw)
    cache_root = _cache_root(source)
    requested = effective["model"]
    explicit = any(key in raw for key in ("model", "quality", "transcription_quality"))
    automatic_request = bool(raw.get("_automatic_quality"))
    if str(raw.get("quality", raw.get("transcription_quality", ""))).lower().strip() == "auto":
        explicit = False
        automatic_request = True
    if automatic_request:
        explicit = False
    if not explicit and not automatic_request and (value("CLIPFLOW_WHISPER_MODEL", "") or value("CLIPFLOW_TRANSCRIPTION_QUALITY", "")):
        explicit = True
    cached = {model: _model_is_cached(cache_root, model) for model in LOCAL_MODELS}
    free_bytes = _free_bytes(cache_root)
    fits = {
        model: cached[model]
        or free_bytes >= MODEL_REQUIREMENTS_MB[model] * 1024 * 1024
        for model in LOCAL_MODELS
    }
    if explicit:
        selected = requested if fits.get(requested, False) else None
    else:
        # Automatic mode prefers a cached model, avoiding needless downloads.
        # Among cached models, use the best one no larger than requested.
        requested_rank = LOCAL_MODELS.index(requested)
        cached_usable = [
            model for model in LOCAL_MODELS[: requested_rank + 1] if cached[model]
        ]
        selected = cached_usable[-1] if cached_usable else (
            requested if fits.get(requested, False) else next(
                (model for model in LOCAL_MODELS if fits[model]), None
            )
        )
    warning = ""
    if selected and selected != requested:
        warning = (
            f"Automatic mode selected {selected} for this draft. "
            "Recognition quality may be lower; choose Balanced or Accurate for a larger model."
        )
    return {
        "provider": "local",
        "cache_root": str(cache_root),
        "requested_model": requested,
        "selected_model": selected,
        "requested_quality": effective["quality"],
        "cached_models": [model for model in LOCAL_MODELS if cached[model]],
        "free_bytes": free_bytes,
        "ready": selected is not None,
        "automatic": not explicit,
        "warning": warning,
        "required_bytes": MODEL_REQUIREMENTS_MB[requested] * 1024 * 1024,
    }


def resolve_local_options(source: Path, options: dict) -> tuple[dict, str]:
    """Return effective options and a truthful quality warning, if any."""
    readiness = model_readiness(source, options)
    if not readiness["ready"]:
        requested = readiness["requested_model"]
        required_mb = MODEL_REQUIREMENTS_MB[requested]
        if readiness["automatic"]:
            raise RuntimeError(
                f"No local Whisper model is cached and there is not enough free space to download one. "
                f"The smallest model needs about {MODEL_REQUIREMENTS_MB['tiny']} MB; free space is "
                f"{readiness['free_bytes'] // (1024 * 1024)} MB. Set CLIPFLOW_MODEL_CACHE to a larger drive or choose Groq."
            )
        raise RuntimeError(
            f"Whisper {requested} is not cached and needs about {max(1, required_mb // 1000)} GB free. "
            "Set CLIPFLOW_MODEL_CACHE to a larger drive or choose Fast local transcription or Groq."
        )
    resolved = dict(options)
    resolved["model"] = readiness["selected_model"]
    resolved["_automatic_quality"] = readiness["automatic"]
    return resolved, readiness["warning"]


def _preflight_model(cache_root: Path, model: str) -> None:
    if _model_is_cached(cache_root, model):
        return
    # Approximate compressed model footprints; this avoids starting a multi-GB
    # download on the small system disk while still allowing an explicitly
    # configured larger cache drive to fetch a missing model.
    required = MODEL_REQUIREMENTS_MB.get(model, 1_000)
    try:
        probe = cache_root
        while not probe.exists() and probe.parent != probe:
            probe = probe.parent
        free_mb = shutil.disk_usage(probe).free / (1024 * 1024)
    except OSError:
        free_mb = 0
    if free_mb < required:
        raise RuntimeError(
            f"Whisper {model} is not cached and needs about {required // 1000 or 1} GB free. Set CLIPFLOW_MODEL_CACHE to a larger drive or choose Groq/fast local transcription."
        )


def _load_local_model(source: Path, options: dict, progress: Progress):
    model_name = options["model"]
    device = value("CLIPFLOW_WHISPER_DEVICE", "cpu")
    compute = value("CLIPFLOW_WHISPER_COMPUTE", "int8")
    cache_root = _cache_root(source)
    _preflight_model(cache_root, model_name)
    from faster_whisper import WhisperModel

    key = (model_name, device, compute, str(cache_root.resolve()))
    with _MODEL_LOCK:
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            _MODEL_CACHE.move_to_end(key)
            return cached
        _emit(
            progress, f"Preparing speech model {model_name} ({options['language']})", 3
        )
        media._check_cancel()
        try:
            model = WhisperModel(
                model_name,
                device=device,
                compute_type=compute,
                download_root=str(cache_root),
                cpu_threads=options.get("cpu_threads", 2),
            )
        except (MemoryError, RuntimeError) as exc:
            if not _memory_failure(exc):
                raise
            _MODEL_CACHE.clear()
            gc.collect()
            raise RuntimeError(_MEMORY_MESSAGE) from exc
        media._check_cancel()
        _MODEL_CACHE[key] = model
        _MODEL_CACHE.move_to_end(key)
        while len(_MODEL_CACHE) > _MODEL_CACHE_LIMIT:
            _MODEL_CACHE.popitem(last=False)
        return model


def _local(
    source: Path, duration: float, progress: Progress, options: dict | None = None
) -> list[dict]:
    effective = options or effective_options({"provider": "local"})
    effective, warning = resolve_local_options(source, effective)
    if warning:
        _emit(progress, f"Draft transcription: {warning}", 2)
    model = _load_local_model(source, effective, progress)
    _emit(
        progress,
        f"Transcribing speech ({effective['model']}, {effective['language']})",
        8,
    )
    kwargs = {
        "vad_filter": True,
        "task": "transcribe",
        "beam_size": 5 if effective["quality"] == "accurate" else 3,
        "condition_on_previous_text": False,
        "language": None if effective["language"] == "auto" else effective["language"],
        "initial_prompt": effective["initial_prompt"] or None,
    }
    try:
        segments, _ = model.transcribe(str(source), **kwargs)
        rows = []
        for segment in segments:
            text = segment.text.strip()
            start = round(max(0, segment.start), 3)
            end = round(min(duration, segment.end), 3)
            if text and end > start:
                rows.append({"start": start, "end": end, "text": text})
            _emit(
                progress,
                f"Transcribing speech ({effective['model']}, {effective['language']})",
                min(98, 8 + int(segment.end / max(duration, 1) * 90)),
            )
        return rows
    except (MemoryError, RuntimeError) as exc:
        if not _memory_failure(exc):
            raise
        _clear_model_cache()
        raise RuntimeError(_MEMORY_MESSAGE) from exc


def _groq(
    source: Path, duration: float, progress: Progress, options: dict | None = None
) -> list[dict]:
    effective = options or effective_options({"provider": "groq"})
    # Ten minutes of mono 16 kHz PCM is 19.2 MB, within Groq's 25 MB upload limit.
    chunk_seconds = 600
    count = max(1, math.ceil(duration / chunk_seconds))
    rows = []
    with tempfile.TemporaryDirectory(prefix="speech-", dir=source.parent) as temp:
        audio = Path(temp) / "audio.wav"
        with httpx.Client(timeout=httpx.Timeout(180, connect=20)) as client:
            for index in range(count):
                offset = index * chunk_seconds
                length = min(chunk_seconds, duration - offset)
                _emit(
                    progress,
                    f"Preparing audio {index + 1}/{count} ({effective['language']})",
                    3 + int(index / count * 90),
                )
                media.run(
                    [
                        media.FFMPEG,
                        "-y",
                        "-ss",
                        str(offset),
                        "-i",
                        str(source),
                        "-t",
                        str(length),
                        "-vn",
                        "-map",
                        "0:a:0",
                        "-ac",
                        "1",
                        "-ar",
                        "16000",
                        "-c:a",
                        "pcm_s16le",
                        str(audio),
                    ],
                    180,
                )
                data = {
                    "model": effective["groq_model"],
                    "response_format": "verbose_json",
                    "timestamp_granularities[]": "segment",
                }
                if effective["language"] != "auto":
                    data["language"] = effective["language"]
                if effective["initial_prompt"]:
                    data["prompt"] = effective["initial_prompt"]
                _emit(
                    progress,
                    f"Transcribing audio {index + 1}/{count} ({effective['groq_model']}, {effective['language']})",
                    6 + int(index / count * 90),
                )
                try:
                    with audio.open("rb") as stream:
                        response = client.post(
                            GROQ_URL,
                            headers={
                                "Authorization": f"Bearer {value('GROQ_API_KEY')}"
                            },
                            data=data,
                            files={"file": ("audio.wav", stream, "audio/wav")},
                        )
                except httpx.TimeoutException as exc:
                    raise RuntimeError(
                        "Groq timed out. Retry transcription or switch to the local provider in .env."
                    ) from exc
                except httpx.RequestError as exc:
                    raise RuntimeError(
                        "Could not reach Groq. Check your connection and retry."
                    ) from exc
                if response.status_code in (401, 403):
                    raise RuntimeError(
                        "Groq rejected the API key. Check GROQ_API_KEY in .env and restart."
                    )
                if response.status_code == 429:
                    raise RuntimeError(
                        "Groq's rate or account limit was reached. Wait and retry, or switch to local transcription."
                    )
                if not response.is_success:
                    raise RuntimeError(
                        f"Groq transcription failed (HTTP {response.status_code}). Check provider availability and your model setting."
                    )
                payload = response.json()
                segments = payload.get("segments", [])
                if not segments and payload.get("text", "").strip():
                    segments = [{"start": 0, "end": length, "text": payload["text"]}]
                for segment in segments:
                    start = max(offset, offset + float(segment["start"]))
                    end = min(duration, offset + length, offset + float(segment["end"]))
                    text = str(segment.get("text", "")).strip()
                    if text and end > start:
                        rows.append(
                            {
                                "start": round(start, 3),
                                "end": round(end, 3),
                                "text": text,
                            }
                        )
                audio.unlink(missing_ok=True)
    _emit(progress, "Captions ready", 99)
    return rows
