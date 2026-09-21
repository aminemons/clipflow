"""Server-only environment configuration. Never return credentials to the browser."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

from dotenv import load_dotenv

from .speech_assets import BUNDLED_MODEL_FILES, BUNDLED_MODEL_NAME

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=False)
# Containers persist UI preferences beside their media volume. Explicit UI
# settings override compose defaults after a container recreation.
if os.getenv("CLIPFLOW_SETTINGS_FILE"):
    load_dotenv(os.environ["CLIPFLOW_SETTINGS_FILE"], override=True)


def value(name: str, default: str = "") -> str:
    return os.getenv(name, "").strip() or default


def public_capabilities() -> dict:
    from .language_models import available, PROVIDERS
    provider = value("CLIPFLOW_TRANSCRIPTION_PROVIDER", "local").lower()
    local = importlib.util.find_spec("faster_whisper") is not None
    configured = (
        bool(value("GROQ_API_KEY"))
        if provider == "groq"
        else local if provider == "local" else False
    )
    bundled_root = value("CLIPFLOW_BUNDLED_MODEL_DIR")
    bundled_model = Path(bundled_root) / BUNDLED_MODEL_NAME if bundled_root else None
    bundled_model_ready = bool(
        bundled_model
        and all((bundled_model / name).is_file() for name in BUNDLED_MODEL_FILES)
    )
    local_message = (
        "Audio is transcribed on this computer. The multilingual speech model is included."
        if bundled_model_ready
        else "Audio is transcribed on this computer. The speech model downloads once."
    )
    message = (
        local_message
        if provider == "local" and local
        else (
            "Install backend/requirements.txt to enable on-device transcription."
            if provider == "local"
            else (
                "Audio is sent to Groq when you choose Generate captions."
                if provider == "groq" and configured
                else (
                    "Add GROQ_API_KEY to .env and restart Clipflow."
                    if provider == "groq"
                    else "Set CLIPFLOW_TRANSCRIPTION_PROVIDER to local or groq in .env."
                )
            )
        )
    )
    higgsfield = (
        bool(value("HF_API_KEY") and value("HF_API_SECRET"))
        and value("CLIPFLOW_HIGGSFIELD_ENABLED", "true") == "true"
    )
    return {
        "transcription": {
            "provider": provider,
            "available": configured,
            "configured": configured,
            "model": (
                value("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")
                if provider == "groq"
                else value("CLIPFLOW_WHISPER_MODEL", "")
                or {"fast": "tiny", "balanced": "small", "accurate": "large-v3"}.get(
                    value("CLIPFLOW_TRANSCRIPTION_QUALITY", "balanced"), "small"
                )
            ),
            "language": value("CLIPFLOW_LANGUAGE", "auto") or "auto",
            "dialect": value("CLIPFLOW_DIALECT", "none") or "none",
            "quality": value("CLIPFLOW_TRANSCRIPTION_QUALITY", "balanced")
            or "balanced",
            "prompt_configured": bool(value("CLIPFLOW_TRANSCRIPTION_PROMPT")),
            "message": message,
        },
        "higgsfield": {
            "configured": higgsfield,
            "message": (
                "Credentials configured"
                if higgsfield
                else "Enable Higgsfield and add its key and secret in Settings."
            ),
        },
        "highlights": {
            "provider": value("CLIPFLOW_HIGHLIGHT_PROVIDER", "local"),
            "groq_available": bool(value("GROQ_API_KEY")),
            "available_providers": [name for name in ("local", "groq", *PROVIDERS) if available(name)],
        },
    }
