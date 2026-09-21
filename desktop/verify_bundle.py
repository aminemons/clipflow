"""Verify files that PyInstaller cannot discover from Python imports alone."""

from __future__ import annotations

import argparse
from pathlib import Path

from backend.speech_assets import (
    BUNDLED_MODEL_FILES,
    BUNDLED_MODEL_NAME,
    BUNDLED_MODEL_PROVENANCE,
)

def _has_silero_model(assets: Path) -> bool:
    names = {path.name for path in assets.glob("silero*.onnx") if path.is_file()}
    return "silero_vad_v6.onnx" in names or {
        "silero_encoder_v5.onnx",
        "silero_decoder_v5.onnx",
    }.issubset(names)


def bundle_errors(root: Path, *, require_ffmpeg: bool = True) -> list[str]:
    """Return missing release components using paths relative to ``root``."""
    internal = root / "_internal"
    model = root / "resources" / "models" / BUNDLED_MODEL_NAME
    errors: list[str] = []
    required = {
        "frontend": internal / "frontend" / "dist" / "index.html",
        "Node.js": root / "resources" / "node" / "node.exe",
        "speech model source": model / BUNDLED_MODEL_PROVENANCE,
    }
    required.update(
        {f"speech model {name}": model / name for name in BUNDLED_MODEL_FILES}
    )
    if require_ffmpeg:
        required.update(
            {
                "FFmpeg": root / "resources" / "ffmpeg" / "ffmpeg.exe",
                "FFprobe": root / "resources" / "ffmpeg" / "ffprobe.exe",
            }
        )
    for label, path in required.items():
        if not path.is_file():
            errors.append(f"{label}: {path.relative_to(root)}")

    assets = internal / "faster_whisper" / "assets"
    if not _has_silero_model(assets):
        errors.append("speech VAD model: _internal/faster_whisper/assets/silero*.onnx")

    if not any(internal.rglob("onnxruntime*.dll")):
        errors.append("ONNX Runtime: _internal/**/onnxruntime*.dll")
    if not (internal / "curl_cffi").is_dir():
        errors.append("YouTube browser transport: _internal/curl_cffi")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--without-ffmpeg", action="store_true")
    args = parser.parse_args(argv)
    missing = bundle_errors(args.bundle, require_ffmpeg=not args.without_ffmpeg)
    if missing:
        print("Desktop bundle is incomplete:")
        for item in missing:
            print(f"- {item}")
        return 1
    print("Desktop bundle contains the frontend, offline speech model, and media runtimes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
