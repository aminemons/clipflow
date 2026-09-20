"""Local provider preferences. Credentials are write-only and never sent back."""

from __future__ import annotations

import os
import re
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import set_key
from fastapi import HTTPException, Request

from .config import ROOT, value

ENV_PATH = Path(value("CLIPFLOW_SETTINGS_FILE", str(ROOT / ".env")))
KEYS = {"GROQ_API_KEY", "HF_API_KEY", "HF_API_SECRET"}
FIELDS = {
    "transcription_provider": "CLIPFLOW_TRANSCRIPTION_PROVIDER",
    "whisper_model": "CLIPFLOW_WHISPER_MODEL",
    "transcription_language": "CLIPFLOW_LANGUAGE",
    "transcription_dialect": "CLIPFLOW_DIALECT",
    "transcription_quality": "CLIPFLOW_TRANSCRIPTION_QUALITY",
    "transcription_prompt": "CLIPFLOW_TRANSCRIPTION_PROMPT",
    "groq_whisper_model": "GROQ_WHISPER_MODEL",
    "highlight_provider": "CLIPFLOW_HIGHLIGHT_PROVIDER",
    "groq_highlight_model": "GROQ_HIGHLIGHT_MODEL",
    "higgsfield_enabled": "CLIPFLOW_HIGGSFIELD_ENABLED",
}
_lock = threading.Lock()


def public_settings() -> dict:
    return {
        "transcription_provider": value("CLIPFLOW_TRANSCRIPTION_PROVIDER", "local"),
        "whisper_model": value("CLIPFLOW_WHISPER_MODEL", ""),
        "transcription_language": value("CLIPFLOW_LANGUAGE", "auto") or "auto",
        "transcription_dialect": value("CLIPFLOW_DIALECT", "none") or "none",
        "transcription_quality": value("CLIPFLOW_TRANSCRIPTION_QUALITY", "balanced")
        or "balanced",
        "transcription_prompt": value("CLIPFLOW_TRANSCRIPTION_PROMPT", ""),
        "groq_whisper_model": value("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo"),
        "highlight_provider": value("CLIPFLOW_HIGHLIGHT_PROVIDER", "local"),
        "groq_highlight_model": value(
            "GROQ_HIGHLIGHT_MODEL", "llama-3.3-70b-versatile"
        ),
        "higgsfield_enabled": value("CLIPFLOW_HIGGSFIELD_ENABLED", "true") == "true",
        "keys": {key: bool(value(key)) for key in sorted(KEYS)},
    }


def save_settings(body: dict) -> dict:
    """Validate first; atomically persist, then update the running process."""
    if body.keys() - (FIELDS.keys() | {"credentials", "clear_keys"}):
        raise ValueError("Unknown settings field.")
    changes = {}
    for field, env_name in FIELDS.items():
        if field not in body:
            continue
        setting = body[field]
        if field.endswith("_provider") and setting not in ("local", "groq"):
            raise ValueError("Choose local or Groq as the provider.")
        if field == "whisper_model" and setting not in (
            "",
            "tiny",
            "base",
            "small",
            "medium",
            "large-v3",
            "large-v3-turbo",
        ):
            raise ValueError("Choose a supported Whisper model.")
        if field == "transcription_language" and setting not in (
            "auto",
            "ar",
            "fr",
            "en",
        ):
            raise ValueError("Choose auto, Arabic, French, or English.")
        if field == "transcription_dialect" and setting not in ("none", "algerian"):
            raise ValueError("Choose no dialect hint or Algerian Darija.")
        if field == "transcription_quality" and setting not in (
            "fast",
            "balanced",
            "accurate",
        ):
            raise ValueError("Choose fast, balanced, or accurate transcription.")
        if field == "transcription_prompt" and (
            not isinstance(setting, str)
            or len(setting) > 500
            or any(ord(char) < 32 and char not in "\t" for char in setting)
        ):
            raise ValueError("Transcription prompt must be at most 500 characters.")
        if field == "groq_whisper_model" and setting not in (
            "whisper-large-v3",
            "whisper-large-v3-turbo",
        ):
            raise ValueError("Choose a supported Groq Whisper model.")
        if field == "groq_highlight_model" and (
            not isinstance(setting, str)
            or not re.fullmatch(r"[A-Za-z0-9._/-]{1,150}", setting)
        ):
            raise ValueError("Enter a valid Groq model identifier.")
        if field == "higgsfield_enabled":
            if not isinstance(setting, bool):
                raise ValueError("Higgsfield enabled must be true or false.")
            setting = "true" if setting else "false"
        changes[env_name] = setting
    credentials = body.get("credentials", {})
    clear = body.get("clear_keys", [])
    if not isinstance(credentials, dict) or credentials.keys() - KEYS:
        raise ValueError("Unsupported credential field.")
    if not isinstance(clear, list) or any(key not in KEYS for key in clear):
        raise ValueError("Unsupported credential to remove.")
    for key, secret in credentials.items():
        if (
            not isinstance(secret, str)
            or len(secret) > 4096
            or any(c in secret for c in "\r\n\0")
        ):
            raise ValueError("API keys must be single-line text.")
        if secret.strip():  # Empty password inputs preserve saved credentials.
            changes[key] = secret.strip()
    changes.update({key: "" for key in clear})
    with _lock:
        # Keep comments and unrelated .env values; failed writes never change
        # the live configuration. The temporary file inherits private mode.
        descriptor, name = tempfile.mkstemp(prefix=".settings-", dir=ENV_PATH.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(
                    ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
                )
            for key, setting in changes.items():
                set_key(temporary, key, setting, quote_mode="always")
            os.replace(temporary, ENV_PATH)
            os.environ.update(changes)
        finally:
            temporary.unlink(missing_ok=True)
    return public_settings()


def register(app, busy):
    def check_origin(request: Request):
        """Reject browser requests from other sites, including DNS rebinding."""
        if value("CLIPFLOW_MODE", "local") == "hosted":
            # The hosted middleware validates both the owner session and the
            # exact public Origin before a settings mutation can reach here.
            from .hosting import require_hosted_owner
            require_hosted_owner(request)
            return
        local_hosts = {"127.0.0.1", "localhost", "::1"}
        if request.url.hostname not in local_hosts:
            raise HTTPException(403, "Settings are available from this computer only.")
        origin = request.headers.get("origin")
        if origin:
            parsed = urlsplit(origin)
            if (
                parsed.hostname not in local_hosts
                or parsed.scheme not in {"http", "https"}
                or parsed.port not in {request.url.port, 5173}
            ):
                raise HTTPException(403, "Open settings from the Clipflow editor.")

    @app.get("/api/settings")
    def read_settings(request: Request):
        check_origin(request)
        return public_settings()

    @app.put("/api/settings")
    def update_settings(request: Request, body: dict):
        check_origin(request)
        if busy():
            raise HTTPException(
                409, "Wait for the current job to finish before changing providers."
            )
        try:
            return save_settings(body)
        except (ValueError, TypeError):
            raise HTTPException(400, "Check provider, model, and API key settings.")
        except OSError:
            raise HTTPException(
                500, "Could not save settings. Check that the app folder is writable."
            )
