from pathlib import Path

from backend.speech_assets import BUNDLED_MODEL_FILES, BUNDLED_MODEL_PROVENANCE
from desktop.verify_bundle import bundle_errors


def _file(root: Path, relative: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"test")


def _model(root: Path) -> None:
    for name in (*BUNDLED_MODEL_FILES, BUNDLED_MODEL_PROVENANCE):
        _file(root, f"resources/models/small/{name}")


def test_bundle_errors_reports_missing_speech_runtime(tmp_path):
    _file(tmp_path, "_internal/frontend/dist/index.html")
    _file(tmp_path, "resources/node/node.exe")
    _file(tmp_path, "resources/ffmpeg/ffmpeg.exe")
    _file(tmp_path, "resources/ffmpeg/ffprobe.exe")
    _file(tmp_path, "_internal/onnxruntime/capi/onnxruntime.dll")
    _file(tmp_path, "_internal/curl_cffi/__init__.py")
    _model(tmp_path)

    errors = bundle_errors(tmp_path)

    assert errors == [
        "speech VAD model: _internal/faster_whisper/assets/silero*.onnx"
    ]


def test_bundle_errors_accepts_complete_bundle(tmp_path):
    for relative in (
        "_internal/frontend/dist/index.html",
        "resources/node/node.exe",
        "resources/ffmpeg/ffmpeg.exe",
        "resources/ffmpeg/ffprobe.exe",
        "_internal/faster_whisper/assets/silero_vad_v6.onnx",
        "_internal/runtime/onnxruntime.dll",
        "_internal/curl_cffi/__init__.py",
    ):
        _file(tmp_path, relative)
    _model(tmp_path)

    assert bundle_errors(tmp_path) == []
