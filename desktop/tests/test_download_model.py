from pathlib import Path

import pytest

from desktop import download_model


def test_download_model_writes_provenance_after_validation(tmp_path):
    calls = []

    def downloader(**kwargs):
        calls.append(kwargs)
        output = Path(kwargs["local_dir"])
        for name in download_model.MODEL_FILES:
            (output / name).write_bytes(b"model")
        (output / "README.md").write_text("model card", encoding="utf-8")

    output = tmp_path / "small"
    download_model.download_model("small", output, downloader=downloader)

    assert calls[0]["repo_id"] == "Systran/faster-whisper-small"
    assert calls[0]["revision"] == download_model.MODEL_REVISION
    assert "Systran/faster-whisper-small" in (
        output / "MODEL-SOURCE.txt"
    ).read_text(encoding="utf-8")


def test_download_model_rejects_incomplete_snapshot(tmp_path):
    with pytest.raises(RuntimeError, match="model.bin"):
        download_model.download_model(
            "small", tmp_path / "small", downloader=lambda **_kwargs: None
        )
