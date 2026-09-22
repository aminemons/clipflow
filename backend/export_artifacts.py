"""Immutable export snapshots and download routes.

Rendered clip paths remain convenient legacy paths under ``files/<project>``.
This module copies each completed render into a job-specific directory so a
later export cannot change an earlier download URL.
"""

from __future__ import annotations

import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, Iterable


_IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_RESERVE_BYTES = 32 * 1024 * 1024


def _ensure_space(store: Any, required: int = 0) -> None:
    """Keep export snapshots from consuming the last usable workspace bytes."""
    try:
        free = shutil.disk_usage(Path(store.files)).free
    except OSError as exc:
        raise RuntimeError("Could not inspect workspace storage.") from exc
    if free < max(0, int(required)) + _RESERVE_BYTES:
        raise RuntimeError(
            "Not enough storage for this export. Free disk space or change CLIPFLOW_DATA."
        )


def _identifier(value: str, label: str) -> str:
    value = str(value)
    if not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"invalid {label}")
    return value


def _files_root(store: Any) -> Path:
    root = Path(store.files).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def export_root(store: Any, project_id: str, job_id: str) -> Path:
    project = _identifier(project_id, "project identifier")
    job = _identifier(job_id, "job identifier")
    return _files_root(store) / project / "exports" / job


def export_location(store: Any, project_id: str, job_id: str, clip_id: str) -> Path:
    job = _identifier(job_id, "job identifier")
    clip = _identifier(clip_id, "clip identifier")
    return export_root(store, project_id, job) / f"{clip}.mp4"


def export_url(project_id: str, job_id: str, clip_id: str) -> str:
    return f"/api/projects/{_identifier(project_id, 'project identifier')}/exports/{_identifier(job_id, 'job identifier')}/{_identifier(clip_id, 'clip identifier')}/download"


def archive_location(store: Any, project_id: str, job_id: str) -> Path:
    return export_root(store, project_id, job_id) / "clips.zip"


def archive_url(project_id: str, job_id: str) -> str:
    return f"/api/projects/{_identifier(project_id, 'project identifier')}/exports/{_identifier(job_id, 'job identifier')}/download"


def record_export(
    store: Any, project_id: str, job_id: str, files: Iterable[tuple[dict, str | Path]]
) -> dict[str, Path]:
    """Copy rendered files into immutable job/clip paths and return snapshots."""
    destination_root = export_root(store, project_id, job_id)
    destination_root.mkdir(parents=True, exist_ok=True)
    snapshots: dict[str, Path] = {}
    try:
        for clip, rendered in files:
            if not isinstance(clip, dict):
                raise ValueError("export clip metadata must be an object")
            clip_id = _identifier(clip.get("id", ""), "clip identifier")
            if clip_id in snapshots:
                raise ValueError("duplicate clip identifier in export")
            source = Path(rendered)
            if not source.is_file():
                raise FileNotFoundError(str(source))
            destination = export_location(store, project_id, job_id, clip_id)
            if source.resolve() != destination.resolve():
                _ensure_space(store, source.stat().st_size)
                shutil.copy2(source, destination)
            snapshots[clip_id] = destination
    except BaseException:
        shutil.rmtree(destination_root, ignore_errors=True)
        raise
    return snapshots


def _zip_name(clip: dict, clip_id: str, used: set[str]) -> str:
    title = str(clip.get("title") or clip_id).strip()
    safe = re.sub(r"[^A-Za-z0-9._ -]+", "_", title).strip(" .") or clip_id
    candidate = f"{safe}.mp4"
    stem = Path(candidate).stem
    index = 2
    while candidate.lower() in used:
        candidate = f"{stem}-{index}.mp4"
        index += 1
    used.add(candidate.lower())
    return candidate


def finalize_exports(
    store: Any, project_id: str, job_id: str, files: Iterable[tuple[dict, str | Path]]
) -> dict[str, Any]:
    """Snapshot files and return stable per-clip URLs plus a batch URL."""
    entries = list(files)
    snapshots = record_export(store, project_id, job_id, entries)
    artifacts = {
        clip_id: export_url(project_id, job_id, clip_id) for clip_id in snapshots
    }
    result: dict[str, Any] = {"artifact_urls": artifacts, "artifacts": artifacts}
    if len(snapshots) == 1:
        result["download_url"] = next(iter(artifacts.values()))
        return result
    archive = archive_location(store, project_id, job_id)
    used: set[str] = set()
    temp_archive = archive.with_suffix(".zip.tmp")
    try:
        _ensure_space(store, sum(path.stat().st_size for path in snapshots.values()))
        with zipfile.ZipFile(temp_archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for clip, _ in entries:
                clip_id = _identifier(clip.get("id", ""), "clip identifier")
                snapshot = snapshots[clip_id]
                bundle.write(snapshot, _zip_name(clip, clip_id, used))
        temp_archive.replace(archive)
    except BaseException:
        temp_archive.unlink(missing_ok=True)
        shutil.rmtree(export_root(store, project_id, job_id), ignore_errors=True)
        raise
    result["download_url"] = archive_url(project_id, job_id)
    result["archive_url"] = result["download_url"]
    return result


def register_routes(app: Any, store_or_accessor: Any) -> None:
    """Register immutable artifact and batch download routes on a FastAPI app."""
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    def store_value():
        return store_or_accessor() if callable(store_or_accessor) else store_or_accessor

    def existing(path: Path) -> Path:
        root = _files_root(store_value())
        try:
            relative = path.relative_to(root)
        except ValueError:
            raise HTTPException(404, "export not found")
        # MSIX can redirect a newly written child into LocalCache even when its
        # parent resolves to AppData. IDs were validated when path was built;
        # check its lexical components instead of comparing resolved strings.
        cursor = root
        for part in relative.parts[:-1]:
            cursor = cursor / part
            if cursor.is_symlink():
                raise HTTPException(404, "export not found")
        if path.is_symlink():
            raise HTTPException(404, "export not found")
        if not path.is_file():
            raise HTTPException(404, "export not found")
        return path

    @app.get("/api/projects/{project_id}/exports/{job_id}/download")
    def immutable_archive_download(project_id: str, job_id: str):
        try:
            path = archive_location(store_value(), project_id, job_id)
        except ValueError:
            raise HTTPException(404, "export not found")
        return FileResponse(
            existing(path),
            media_type="application/zip",
            filename=f"{project_id}-{job_id}.zip",
        )

    @app.get("/api/projects/{project_id}/exports/{job_id}/{clip_id}/download")
    def immutable_clip_download(project_id: str, job_id: str, clip_id: str):
        try:
            path = export_location(store_value(), project_id, job_id, clip_id)
        except ValueError:
            raise HTTPException(404, "export not found")
        return FileResponse(
            existing(path), media_type="video/mp4", filename=f"{clip_id}.mp4"
        )
