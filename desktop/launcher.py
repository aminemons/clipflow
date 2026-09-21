"""Run Clipflow's local API inside a small Windows WebView2 application.

The desktop process owns the API server and chooses a random loopback port. It
stores projects and provider settings below the user's local application data
directory, so a packaged install never needs to write beside its executable.
"""

from __future__ import annotations

import argparse
import importlib
import logging
from logging.handlers import RotatingFileHandler
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


APP_NAME = "Clipflow"
LOGGER = logging.getLogger("clipflow.desktop")
LOG_PATH: Path | None = None


def _bundle_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[1]


def _app_data() -> Path:
    # LOCALAPPDATA is the standard Windows per-user, non-roaming location.
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if base:
        return Path(base) / APP_NAME
    return Path.home() / f".{APP_NAME.lower()}"


def _configure_environment() -> tuple[Path, Path]:
    app_data = _app_data()
    data_dir = app_data / "data"
    settings_file = app_data / "settings.env"
    data_dir.mkdir(parents=True, exist_ok=True)
    app_data.mkdir(parents=True, exist_ok=True)
    # These must be present before backend.config/backend.app are imported.
    os.environ.setdefault("CLIPFLOW_MODE", "local")
    os.environ["CLIPFLOW_DATA"] = str(data_dir)
    os.environ["CLIPFLOW_SETTINGS_FILE"] = str(settings_file)
    os.environ["CLIPFLOW_DESKTOP"] = "1"

    bundle_ffmpeg = _bundle_root() / "resources" / "ffmpeg"
    if not bundle_ffmpeg.is_dir() and getattr(sys, "frozen", False):
        # PyInstaller's onedir bootloader puts Python data below _internal,
        # while build.ps1 keeps large redistributables beside the executable.
        bundle_ffmpeg = Path(sys.executable).resolve().parent / "resources" / "ffmpeg"
    ffmpeg_dir = os.environ.get("CLIPFLOW_FFMPEG_DIR")
    if not ffmpeg_dir and bundle_ffmpeg.is_dir():
        ffmpeg_dir = str(bundle_ffmpeg)
    if ffmpeg_dir:
        os.environ["CLIPFLOW_FFMPEG_DIR"] = ffmpeg_dir
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    bundle_node = _bundle_root() / "resources" / "node"
    if not bundle_node.is_dir() and getattr(sys, "frozen", False):
        bundle_node = Path(sys.executable).resolve().parent / "resources" / "node"
    if bundle_node.is_dir() and (bundle_node / "node.exe").is_file():
        os.environ["PATH"] = str(bundle_node) + os.pathsep + os.environ.get("PATH", "")
    return data_dir, settings_file


def _configure_logging(app_data: Path) -> Path:
    """Write startup diagnostics somewhere a packaged app can always reach."""
    global LOG_PATH
    log_dir = Path(os.environ.get("CLIPFLOW_LOG_DIR", app_data / "logs"))
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "desktop.log"
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False
    if not LOGGER.handlers:
        handler = RotatingFileHandler(
            log_path,
            maxBytes=1_000_000,
            backupCount=2,
            encoding="utf-8",
        )
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        )
        LOGGER.addHandler(handler)
    LOG_PATH = log_path
    return log_path


def _show_startup_message(message: str, *, error: bool = False) -> None:
    """Make a startup problem visible when the executable has no console."""
    print(message, file=sys.stderr if error else sys.stdout, flush=True)
    if os.name != "nt" or os.environ.get("CLIPFLOW_NO_DIALOG") == "1":
        return
    try:
        import ctypes

        flags = 0x00000010 if error else 0x00000040  # MB_ICONERROR / MB_ICONINFORMATION
        ctypes.windll.user32.MessageBoxW(0, message, APP_NAME, flags | 0x00000000)
    except Exception:
        # Logging has already captured the actionable details. A broken dialog
        # API must never hide the original startup failure.
        LOGGER.debug("Could not show the startup dialog", exc_info=True)


def _browser_fallback(url: str, server_thread: threading.Thread, reason: BaseException) -> int:
    """Open the local app in a regular browser when WebView2 cannot start."""
    LOGGER.error(
        "Embedded browser startup failed; using browser fallback",
        exc_info=(type(reason), reason, reason.__traceback__),
    )
    log_path = LOG_PATH or "the Clipflow desktop log"
    try:
        opened = webbrowser.open(url, new=1)
    except Exception:
        opened = False
        LOGGER.exception("Could not open the browser fallback")

    if opened:
        message = (
            "Clipflow is running in your web browser because its embedded window "
            "could not start.\n\n"
            f"URL: {url}\n\n"
            f"Keep this process running while using Clipflow. Startup details are in:\n{log_path}"
        )
    else:
        message = (
            "Clipflow could not start its embedded window or open a browser.\n\n"
            f"Open this URL manually: {url}\n\n"
            f"Startup details are in:\n{log_path}"
        )
    _show_startup_message(message, error=not opened)

    # The API is owned by this process. Keep it alive for the browser fallback;
    # otherwise the browser would open successfully and immediately lose its API.
    try:
        while server_thread.is_alive():
            time.sleep(1)
    except KeyboardInterrupt:
        return 0
    raise RuntimeError("Clipflow API stopped while browser fallback was active")


def _pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_health(
    url: str,
    timeout: float = 30.0,
    server_holder: dict[str, object] | None = None,
) -> dict:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if server_holder and (server_error := server_holder.get("error")) is not None:
            raise RuntimeError(f"Clipflow API server failed: {server_error}") from server_error
        try:
            with urllib.request.urlopen(url + "/api/health", timeout=1.5) as response:
                import json

                return json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, ValueError) as exc:
            last_error = exc
            time.sleep(0.15)
    raise RuntimeError(f"Clipflow API did not become ready: {last_error}")


def _run_server(port: int, holder: dict[str, object]):
    # Imports are intentionally delayed until environment and FFmpeg discovery
    # are configured. backend.media resolves its tools at import time.
    try:
        import uvicorn

        module = importlib.import_module("backend.app")
        config = uvicorn.Config(
            module.app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            access_log=False,
            loop="asyncio",
        )
        server = uvicorn.Server(config)
        server.install_signal_handlers = lambda: None
        holder["server"] = server
        server.run()
    except BaseException as exc:
        holder["error"] = exc
        LOGGER.exception("Clipflow API server failed")


def run(*, headless: bool = False, port: int | None = None) -> int:
    data_dir, _settings_file = _configure_environment()
    _configure_logging(data_dir.parent)
    LOGGER.info("Starting Clipflow desktop (frozen=%s)", getattr(sys, "frozen", False))
    chosen_port = port or _pick_port()
    server_holder: dict[str, object] = {}
    server_thread = threading.Thread(
        target=_run_server,
        args=(chosen_port, server_holder),
        name="clipflow-api",
        daemon=True,
    )
    server_thread.start()
    url = f"http://127.0.0.1:{chosen_port}"
    try:
        health = _wait_for_health(url, server_holder=server_holder)
        LOGGER.info("Clipflow API ready at %s (%s)", url, health.get("status", "ok"))
        if headless:
            print("Clipflow desktop self-test: API ready")
            print(f"Clipflow desktop self-test: {health.get('status', 'ok')}")
            return 0

        try:
            import webview
        except Exception as exc:
            # Source checkouts can still be used without the optional native
            # window dependency. Packaged builds include pywebview, but native
            # WebView2/.NET initialization can still fail at runtime.
            return _browser_fallback(url, server_thread, exc)

        def stop_server(*_args):
            server = server_holder.get("server")
            if server is not None:
                server.should_exit = True

        try:
            window = webview.create_window(
                "Clipflow",
                url,
                width=1440,
                height=940,
                min_size=(960, 640),
                resizable=True,
                confirm_close=True,
            )
            window.events.closed += stop_server
            webview.start(gui="edgechromium", debug=False)
            LOGGER.info("Embedded Clipflow window closed normally")
            return 0
        except Exception as exc:
            return _browser_fallback(url, server_thread, exc)
    finally:
        # A daemon thread exits with the desktop process. Waiting briefly lets
        # in-flight writes finish while avoiding a shutdown hang on bad media.
        server = server_holder.get("server")
        if server is not None:
            server.should_exit = True
        server_thread.join(timeout=5)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headless", "--self-test", action="store_true", help="start the local API, verify health, then exit")
    parser.add_argument("--port", type=int, help="development port (default: random loopback port)")
    args = parser.parse_args(argv)
    try:
        return run(headless=args.headless, port=args.port)
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        LOGGER.exception("Could not start Clipflow desktop")
        message = f"Could not start Clipflow desktop: {exc}"
        log_path = LOG_PATH or "the Clipflow desktop log"
        _show_startup_message(f"{message}\n\nDetails: {log_path}", error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
