from __future__ import annotations

import pytest

from backend.speech_assets import BUNDLED_MODEL_FILES
from desktop import launcher


class _StoppedServer:
    def is_alive(self) -> bool:
        return False


class _ServingServer:
    should_exit = False


class _FakeThread:
    """Capture the serving wait without starting a real API thread."""

    instances: list["_FakeThread"] = []

    def __init__(self, *, target, args, **_kwargs):
        self.target = target
        self.args = args
        self.server = _ServingServer()
        self.args[1]["server"] = self.server
        self.join_calls: list[dict] = []
        self.instances.append(self)

    def start(self):
        pass

    def join(self, **kwargs):
        self.join_calls.append(kwargs)
        if not kwargs:
            raise LookupError("serve mode should remain attached to the API")


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


def test_self_test_still_exits_after_health_check(monkeypatch, tmp_path):
    monkeypatch.setattr(launcher, "_configure_environment", lambda: (tmp_path, tmp_path / "settings.env"))
    monkeypatch.setattr(launcher, "_configure_logging", lambda _path: tmp_path / "desktop.log")
    monkeypatch.setattr(launcher, "_assert_frozen_speech_assets", lambda: None)
    monkeypatch.setattr(launcher, "_run_server", lambda *_args: None)
    monkeypatch.setattr(launcher.threading, "Thread", _FakeThread)
    monkeypatch.setattr(launcher, "_wait_for_health", lambda *_args, **_kwargs: {"status": "ok"})
    _FakeThread.instances.clear()

    assert launcher.run(headless=True, port=43125) == 0
    assert _FakeThread.instances[0].join_calls == [{"timeout": 5}]
    assert _FakeThread.instances[0].server.should_exit is True


def test_serve_mode_remains_attached_until_api_thread_stops(monkeypatch, tmp_path):
    monkeypatch.setattr(launcher, "_configure_environment", lambda: (tmp_path, tmp_path / "settings.env"))
    monkeypatch.setattr(launcher, "_configure_logging", lambda _path: tmp_path / "desktop.log")
    monkeypatch.setattr(launcher, "_assert_frozen_speech_assets", lambda: None)
    monkeypatch.setattr(launcher, "_run_server", lambda *_args: None)
    monkeypatch.setattr(launcher.threading, "Thread", _FakeThread)
    monkeypatch.setattr(launcher, "_wait_for_health", lambda *_args, **_kwargs: {"status": "ok"})
    _FakeThread.instances.clear()

    with pytest.raises(LookupError, match="remain attached"):
        launcher.run(serve=True, port=43126)
    thread = _FakeThread.instances[0]
    assert thread.join_calls == [{}, {"timeout": 5}]
    assert thread.server.should_exit is True


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


def test_import_ticket_argument_runs_bridge_without_starting_local_ui(monkeypatch, tmp_path):
    from desktop import import_bridge

    opened = []
    monkeypatch.setattr(launcher, "_app_data", lambda: tmp_path / "app")
    monkeypatch.setattr(import_bridge, "import_ticket", lambda link: "https://clipflow-aminemons.vercel.app/#/editor/p1")
    monkeypatch.setattr(launcher.webbrowser, "open", lambda url, new=0: opened.append(url) or True)
    monkeypatch.setattr(launcher, "_show_startup_message", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher, "run", lambda **_kwargs: pytest.fail("normal UI must not start"))
    monkeypatch.setattr(launcher, "_register_protocol", lambda: pytest.fail("protocol registration is for normal startup"))

    assert launcher.main(["--import-ticket", "clipflow://import?ticket=secret&server=trusted"]) == 0
    assert opened == ["https://clipflow-aminemons.vercel.app/#/editor/p1"]


def test_import_ticket_error_is_reported_without_echoing_link(monkeypatch, tmp_path):
    from desktop import import_bridge

    messages = []
    secret_link = "clipflow://import?ticket=secret-token&server=trusted"
    monkeypatch.setattr(launcher, "_app_data", lambda: tmp_path / "app")

    def fail(_link):
        raise import_bridge.ImportBridgeError("The import ticket is invalid or expired.")

    monkeypatch.setattr(import_bridge, "import_ticket", fail)
    monkeypatch.setattr(launcher, "_show_startup_message", lambda message, **kwargs: messages.append((message, kwargs)))

    assert launcher.main(["--import-ticket", secret_link]) == 1
    assert "invalid or expired" in messages[0][0]
    assert secret_link not in messages[0][0]
