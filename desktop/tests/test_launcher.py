from __future__ import annotations

import pytest

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
