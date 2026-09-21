"""Download the speech model included in the portable Windows package."""

from __future__ import annotations

import argparse
from collections.abc import Callable
from pathlib import Path

from backend.speech_assets import (
    BUNDLED_MODEL_FILES,
    BUNDLED_MODEL_NAME,
    BUNDLED_MODEL_PROVENANCE,
)

MODEL_REPOS = {BUNDLED_MODEL_NAME: "Systran/faster-whisper-small"}
MODEL_REVISION = "536b0662742c02347bc0e980a01041f333bce120"
MODEL_FILES = BUNDLED_MODEL_FILES


def model_errors(output: Path) -> list[str]:
    """List files missing from a downloaded CTranslate2 model."""
    return [name for name in MODEL_FILES if not (output / name).is_file()]


def download_model(
    model: str,
    output: Path,
    *,
    revision: str = MODEL_REVISION,
    downloader: Callable[..., object] | None = None,
) -> None:
    """Download and validate one pinned model snapshot."""
    repo = MODEL_REPOS.get(model)
    if repo is None:
        raise ValueError(f"Unsupported bundled model: {model}")
    if downloader is None:
        from huggingface_hub import snapshot_download

        downloader = snapshot_download

    output.mkdir(parents=True, exist_ok=True)
    downloader(
        repo_id=repo,
        revision=revision,
        local_dir=str(output),
        allow_patterns=[*MODEL_FILES, "README.md"],
    )
    missing = model_errors(output)
    if missing:
        raise RuntimeError(f"Downloaded model is incomplete: {', '.join(missing)}")

    source = (
        f"Model: {repo}\n"
        f"Revision: {revision}\n"
        f"Source: https://huggingface.co/{repo}\n"
        "License: MIT (see the included model card)\n"
    )
    (output / BUNDLED_MODEL_PROVENANCE).write_text(source, encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model", choices=tuple(MODEL_REPOS), default=BUNDLED_MODEL_NAME
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--revision", default=MODEL_REVISION)
    args = parser.parse_args(argv)
    download_model(args.model, args.output, revision=args.revision)
    print(f"Bundled speech model ready at {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
