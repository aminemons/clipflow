"""First-run installer and local launcher. Python 3.11+, Node 20+, FFmpeg required."""

from pathlib import Path
import argparse
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
import venv
import webbrowser

ROOT = Path(__file__).resolve().parent


def run(*args, cwd=ROOT):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def open_when_ready(url):
    import time

    for _ in range(60):
        try:
            with urllib.request.urlopen(url + "/api/health", timeout=1):
                webbrowser.open(url)
                return
        except Exception:
            time.sleep(0.5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()
    if not (ROOT / ".env").exists():
        shutil.copyfile(ROOT / ".env.example", ROOT / ".env")
    if sys.version_info < (3, 11):
        raise RuntimeError("Please install Python 3.11 or newer.")
    missing = [
        name for name in ("ffmpeg", "ffprobe", "node", "npm") if not shutil.which(name)
    ]
    if missing:
        raise RuntimeError(
            "Please install " + ", ".join(missing) + ". See README.md for setup."
        )
    env = ROOT / ".venv"
    python = env / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    marker = env / ".clipflow-ready"
    requirements = ROOT / "backend/requirements.txt"
    if not python.exists():
        print("Preparing your local workspace…", flush=True)
        venv.create(env, with_pip=True)
    if not marker.exists() or marker.read_text() != requirements.read_text():
        print(
            "Installing free, open-source video tools (first run needs internet)…",
            flush=True,
        )
        run(python, "-m", "pip", "install", "--no-cache-dir", "-r", requirements)
        marker.write_text(requirements.read_text())
    frontend = ROOT / "frontend"
    if args.rebuild or not (frontend / "dist/index.html").exists():
        print("Preparing the editor…", flush=True)
        npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
        run(npm, "ci", cwd=frontend)
        run(npm, "run", "build", cwd=frontend)
    url = f"http://127.0.0.1:{args.port}"
    print(
        f"\nClipflow is opening at {url}. Keep this window open; Ctrl+C stops it.\n",
        flush=True,
    )
    if not args.no_browser:
        threading.Thread(target=open_when_ready, args=(url,), daemon=True).start()
    run(
        python,
        "-m",
        "uvicorn",
        "backend.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        args.port,
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"\nCould not start Clipflow: {exc}", file=sys.stderr)
        sys.exit(1)
