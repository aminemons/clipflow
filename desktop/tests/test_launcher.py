from __future__ import annotations

import pytest

from backend.speech_assets import BUNDLED_MODEL_FILES
from desktop import launcher


class _StoppedServer:
    def is_alive(self) -> bool:
        return False


def _reset_logger() -> None:
    while launcher.LOGGER.handlers:
        handler = launcher.LOGGER.handlers[0]
        handler.close()
        launcher.LOGGER.removeHandler(handler)


def test_configure_logging_creates_rotating_log(tmp_path, monkeypatch):
    _reset_logger()
    monkeypatch.setenv("CLIPFLOW_LOG_DIR", str(tmp_path / "logs"))

    path = launcher._configure_logging(tmp_path / "app")
    launcher.LOGGER.info("startup test")

    assert path == tmp_path / "logs" / "desktop.log"
    assert "startup test" in path.read_text(encoding="utf-8")


def test_configure_environment_exposes_bundled_models(tmp_path, monkeypatch):
    resources = tmp_path / "package" / "resources"
    (resources / "models").mkdir(parents=True)
    monkeypatch.setattr(launcher, "_app_data", lambda: tmp_path / "app-data")
    monkeypatch.setattr(launcher, "_resource_dir", lambda name: resources / name)
    monkeypatch.delenv("CLIPFLOW_BUNDLED_MODEL_DIR", raising=False)

    launcher._configure_environment()

    assert launcher.os.environ["CLIPFLOW_BUNDLED_MODEL_DIR"] == str(
        resources / "models"
    )


def test_browser_fallback_opens_url_and_reports_log(monkeypatch, tmp_path):
    _reset_logger()
    monkeypatch.setenv("CLIPFLOW_LOG_DIR", str(tmp_path / "logs"))
    launcher._configure_logging(tmp_path / "app")
    opened: list[str] = []
    messages: list[str] = []
    monkeypatch.setattr(
        launcher.webbrowser,
        "open",
        lambda url, new=0: opened.append(url) or True,
    )
    monkeypatch.setattr(
        launcher,
        "_show_startup_message",
        lambda message, **_kwargs: messages.append(message),
    )

    with pytest.raises(RuntimeError, match="API stopped"):
        launcher._browser_fallback(
            "http://127.0.0.1:43123",
            _StoppedServer(),
            RuntimeError("WebView2 unavailable"),
        )

    assert opened == ["http://127.0.0.1:43123"]
    assert "running in your web browser" in messages[0]
    assert str(tmp_path / "logs" / "desktop.log") in messages[0]
    for handler in launcher.LOGGER.handlers:
        handler.flush()
    assert "WebView2 unavailable" in (
        tmp_path / "logs" / "desktop.log"
    ).read_text(encoding="utf-8")


def test_wait_for_health_fails_fast_when_server_thread_reports_error():
    with pytest.raises(RuntimeError, match="API server failed"):
        launcher._wait_for_health(
            "http://127.0.0.1:43124",
            timeout=10,
            server_holder={"error": RuntimeError("backend import failed")},
        )


def test_frozen_runtime_requires_silero_model(tmp_path, monkeypatch):
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(launcher.sys, "_MEIPASS", str(tmp_path), raising=False)

    with pytest.raises(RuntimeError, match="local speech files are missing"):
        launcher._assert_frozen_speech_assets()


def test_frozen_runtime_accepts_current_silero_model(tmp_path, monkeypatch):
    assets = tmp_path / "faster_whisper" / "assets"
    assets.mkdir(parents=True)
    (assets / "silero_vad_v6.onnx").write_bytes(b"model")
    model = tmp_path / "resources" / "models" / "small"
    model.mkdir(parents=True)
    for name in BUNDLED_MODEL_FILES:
        (model / name).write_bytes(b"model")
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(launcher.sys, "_MEIPASS", str(tmp_path), raising=False)

    launcher._assert_frozen_speech_assets()


def test_frozen_runtime_requires_bundled_whisper_model(tmp_path, monkeypatch):
    assets = tmp_path / "faster_whisper" / "assets"
    assets.mkdir(parents=True)
    (assets / "silero_vad_v6.onnx").write_bytes(b"model")
    monkeypatch.setattr(launcher.sys, "frozen", True, raising=False)
    monkeypatch.setattr(launcher.sys, "_MEIPASS", str(tmp_path), raising=False)

    with pytest.raises(RuntimeError, match="local speech files are missing"):
        launcher._assert_frozen_speech_assets()
