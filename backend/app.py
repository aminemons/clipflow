from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import math
import os
import re
import shutil
import threading
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from .config import public_capabilities, value
from .hosting import install_hosted_security
from . import media, transcription as speech
from .media import (
    analyze_segments,
    make_demo,
    make_zip,
    metadata,
    render_clip,
    srt_for_clip,
    track_focus,
)
from .store import Store, utc_now
from .export_artifacts import (
    finalize_exports,
    register_routes as register_export_routes,
)

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.getenv("CLIPFLOW_DATA", str(ROOT / "data")))
store = Store(DATA)
# Media jobs are intentionally serialized: ffmpeg can saturate a local CPU and
# serializing also prevents two exports from racing on the same project files.
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clipflow")
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.RLock()
submission_lock = threading.Lock()
projects_lock = threading.RLock()
cancel_events: dict[str, threading.Event] = {}
MAX_UPLOAD = 500 * 1024 * 1024
MIN_FREE_BYTES = 32 * 1024 * 1024


def ensure_workspace_space(required: int = 0) -> None:
    try:
        free = shutil.disk_usage(getattr(store, "root", DATA)).free
    except OSError as exc:
        raise RuntimeError("Could not inspect workspace storage.") from exc
    if free < max(0, int(required)) + MIN_FREE_BYTES:
        raise RuntimeError(
            "Not enough storage for this operation. Free disk space or change CLIPFLOW_DATA."
        )

# Job summaries survive process restarts. Work that was interrupted cannot be
# safely resumed without a serialized task payload, so it is surfaced as an
# actionable error instead of disappearing or remaining falsely queued.
_loaded_jobs = store.load_jobs()
for _job_id, _raw_job in _loaded_jobs.items():
    # jobs.json is user-owned local state. Ignore malformed rows instead of
    # making a damaged summary file prevent the server from starting.
    if not isinstance(_job_id, str) or not isinstance(_raw_job, dict):
        continue
    _job = dict(_raw_job)
    _job["id"] = _job_id
    _job.setdefault("kind", "job")
    _job.setdefault("status", "error")
    _job.setdefault("stage", "error")
    _job.setdefault("progress", 0)
    _job.setdefault("created_at", utc_now())
    _job.setdefault("updated_at", utc_now())
    if not isinstance(_job.get("args", []), list):
        _job["args"] = []
    jobs[_job_id] = _job
for _job in jobs.values():
    if _job.get("status") in {"queued", "running"}:
        _job.update(
            status="error",
            stage="error",
            error="server restarted before this job completed",
            updated_at=utc_now(),
        )
if jobs:
    store.save_jobs(jobs)
for _project in store.list():
    if isinstance(_project.get("active_job_id"), str) and jobs.get(_project["active_job_id"], {}).get(
        "status"
    ) in {"error", "done"}:
        _project.pop("active_job_id", None)
        store.save(_project)

app = FastAPI(title="Clipflow API", version="1.0")
hosted_config = install_hosted_security(app)
app.add_middleware(
    CORSMiddleware,
    allow_origins=([hosted_config.public_origin] if hosted_config.hosted else [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]),
    allow_credentials=hosted_config.hosted,
    allow_methods=["*"],
    allow_headers=["*"],
)


class JobCancelled(RuntimeError):
    pass


class YouTubeInput(BaseModel):
    url: str
    target_duration: float = Field(default=30, ge=5, le=300)


class AnalyzeInput(BaseModel):
    target_duration: float = Field(default=30, ge=5, le=300)
    mode: Literal["full", "smart"] = "full"
    max_clips: int = Field(default=5, ge=1, le=20)
    tolerance: float = Field(default=0.3, ge=0.1, le=0.5)
    topic: str = Field(default="", max_length=500)
    use_transcript: bool = True
    provider: Literal["local", "groq"] | None = None
    # Optional hard ceiling for smart clips. Omitted preserves the historical
    # target +/- tolerance behavior.
    strict_max: float | None = Field(default=None, ge=1, le=300)
    sentence_context: Literal["keep", "discard"] = "keep"


class ExportInput(BaseModel):
    clip_ids: list[str] = Field(default_factory=list)


class PreviewInput(BaseModel):
    clip_id: str


class DemoInput(BaseModel):
    target_duration: float = Field(default=30, ge=5, le=300)


class TranscriptSegment(BaseModel):
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)
    text: str = Field(max_length=4000)


class TranscriptInput(BaseModel):
    segments: list[TranscriptSegment] = Field(max_length=10000)
    clip_id: str | None = None


class TranscribeInput(BaseModel):
    clip_id: str | None = None
    quality: Literal["fast", "balanced", "accurate"] | None = None
    language: Literal["auto", "ar", "fr", "en"] | None = None
    dialect: Literal["none", "algerian"] | None = None
    initial_prompt: str | None = Field(default=None, max_length=500)
    force: bool = False


class BulkClipsInput(BaseModel):
    action: Literal["delete", "restore"]
    clip_ids: list[str] = Field(default_factory=list, max_length=2000)


def job_view(job: dict) -> dict:
    return {
        k: job[k]
        for k in (
            "id",
            "kind",
            "status",
            "stage",
            "progress",
            "error",
            "project_id",
            "download_url",
            "clip_titles",
            "created_at",
            "updated_at",
            "cancel_requested",
            "stale",
            "preview_revision",
            "warning",
        )
        if k in job
    }


def persist_job(item: dict) -> None:
    with jobs_lock:
        # Keep worker-local mutable state separate from the published summary.
        # A cancellation request and a progress callback can otherwise mutate
        # the same dict while json.dumps is traversing it.
        snapshot = copy.deepcopy(item)
        published = jobs.get(snapshot["id"])
        if (
            published
            and published.get("cancel_requested")
            and snapshot.get("status") in {"queued", "running"}
            and not snapshot.get("cancel_requested")
        ):
            snapshot["cancel_requested"] = True
            snapshot["stage"] = "cancelling"
            snapshot["error"] = "cancel requested"
        jobs[snapshot["id"]] = snapshot
        store.save_jobs(copy.deepcopy(jobs))


def submit(project_id: str | None, fn, *args) -> dict:
    with submission_lock:
        return _submit(project_id, fn, *args)


def _submit(project_id: str | None, fn, *args) -> dict:
    kind = getattr(fn, "__name__", "job")
    with jobs_lock:
        for existing in jobs.values():
            if (
                existing.get("project_id") == project_id
                and existing.get("kind") == kind
                and existing.get("args") == list(args)
                and existing.get("status") in {"queued", "running"}
            ):
                return job_view(existing)
    jid = uuid.uuid4().hex[:12]
    now = utc_now()
    item = {
        "id": jid,
        "kind": kind,
        "args": list(args),
        "status": "queued",
        "stage": "queued",
        "progress": 0,
        "created_at": now,
        "updated_at": now,
    }
    if project_id:
        item["project_id"] = project_id
    persist_job(item)
    cancel_events[jid] = threading.Event()
    if project_id:
        with projects_lock:
            project = store.get(project_id)
            if project:
                project["active_job_id"] = jid
                store.save(project)
    executor.submit(_run_job, item, fn, *args)
    return job_view(item)


def _run_job(item: dict, fn, *args):
    if cancel_events.get(item["id"], threading.Event()).is_set():
        item["status"] = "cancelled"
        item["stage"] = "cancelled"
        item["cancel_requested"] = False
        item["error"] = "job cancelled"
        item["updated_at"] = utc_now()
        persist_job(item)
        project_id = item.get("project_id")
        if project_id:
            with projects_lock:
                project = store.get(project_id)
                if project and project.get("active_job_id") == item["id"]:
                    project.pop("active_job_id", None)
                    store.save(project)
        with jobs_lock:
            cancel_events.pop(item["id"], None)
        return
    item["status"] = "running"
    item["stage"] = "starting"
    item["updated_at"] = utc_now()
    persist_job(item)
    try:
        if hasattr(media, "set_cancel_check"):
            media.set_cancel_check(lambda: check_cancelled(item))
        if cancel_events.get(item["id"], threading.Event()).is_set():
            raise JobCancelled("job cancelled")
        result = fn(item, *args)
        if cancel_events.get(item["id"], threading.Event()).is_set():
            raise JobCancelled("job cancelled")
        if isinstance(result, dict):
            item.update(result)
        item["status"] = "done"
        item["cancel_requested"] = False
        item["stage"] = "complete"
        item["progress"] = 100
        item["updated_at"] = utc_now()
        persist_job(item)
    except JobCancelled as e:
        item["status"] = "cancelled"
        item["cancel_requested"] = False
        item["stage"] = "cancelled"
        item["error"] = str(e)
        item["updated_at"] = utc_now()
        persist_job(item)
    except Exception as e:
        item["status"] = "error"
        item["cancel_requested"] = False
        item["stage"] = "error"
        item["error"] = str(e)[:2000]
        item["updated_at"] = utc_now()
        persist_job(item)
    finally:
        if hasattr(media, "set_cancel_check"):
            media.set_cancel_check(None)
        project_id = item.get("project_id")
        if project_id:
            with projects_lock:
                project = store.get(project_id)
                if project and project.get("active_job_id") == item["id"]:
                    project.pop("active_job_id", None)
                    store.save(project)
        with jobs_lock:
            cancel_events.pop(item["id"], None)


def check_cancelled(item: dict):
    if cancel_events.get(item["id"], threading.Event()).is_set():
        raise JobCancelled("job cancelled")


def update(item: dict, stage: str, progress: int):
    check_cancelled(item)
    item["stage"], item["progress"] = stage, max(0, min(100, int(progress)))
    item["updated_at"] = utc_now()
    persist_job(item)


def clip_defaults(start: float, end: float, index: int, focus=(0.5, 0.5)) -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "title": f"Clip {index + 1}",
        "start": round(start, 3),
        "end": round(end, 3),
        "selected": True,
        "framing": "follow",
        "focus_x": round(focus[0], 3),
        "smoothing": 0.15,
        "caption_text": "",
        "caption_style": "clean",
        "caption_color": "#d6fb78",
        "caption_position": "bottom",
        "caption_x": 0.5,
        "caption_y": 0.86,
        "caption_enabled": True,
        "playback_speed": 1.0,
        "audio_volume": 1.0,
        "audio_denoise": False,
        "audio_fade": 0.0,
        "resolution": 720,
        "subject": "auto",
        "reviewed": False,
        "status": "draft",
        "revision": 1,
    }


def create_project(
    source: Path, title: str, source_url: str = "", move_source: bool = False
) -> dict:
    duration, width, height, fps = metadata(source)
    if duration <= 0 or width <= 0 or height <= 0:
        raise HTTPException(400, "uploaded file is not a readable video")
    pid = store.create_id()
    ext = source.suffix.lower() or ".mp4"
    stored_source = store.files / f"{pid}{ext}"
    if source.resolve() != stored_source.resolve():
        if move_source:
            source.replace(stored_source)
        else:
            shutil.copy2(source, stored_source)
    return store.save(
        {
            "id": pid,
            "title": title,
            "duration": round(duration, 3),
            "width": width,
            "height": height,
            "fps": round(fps, 3),
            "source_url": f"/api/projects/{pid}/source",
            "thumbnail_url": f"/api/projects/{pid}/thumbnail",
            "clips": [],
            "transcript": [],
            "created_at": utc_now(),
            "edit_revision": 0,
        }
    )


def source_path(project_id: str) -> Path:
    safe_identifier(project_id)
    hits = [
        p
        for p in store.files.glob(f"{project_id}.*")
        if p.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
    ]
    if not hits:
        raise HTTPException(404, "source not found")
    root = store.files.resolve()
    try:
        resolved = hits[0].resolve()
        resolved.relative_to(root)
    except ValueError:
        raise HTTPException(404, "source not found")
    return resolved


def workspace_file(path: Path) -> Path:
    """Resolve a generated file without following a symlink outside DATA."""
    root = store.files.resolve()
    resolved = path.resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        raise HTTPException(404, "file not found")
    if not resolved.is_file():
        raise HTTPException(404, "file not found")
    return resolved


def safe_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise HTTPException(400, "Invalid resource identifier.")
    return value


def analyze_job(
    item: dict, project_id: str, target: float, options: dict | None = None
):
    project = store.get(project_id)
    if not project:
        raise RuntimeError("project not found")
    source = source_path(project_id)
    start_edit_revision = int(project.get("edit_revision", 0))
    if options and options.get("mode") == "smart":
        return smart_highlights_job(item, project, source, target, options)
    segments = analyze_segments(source, target, lambda s, p: update(item, s, p))
    # Tracking belongs to the selected preview/export. Seeking into every clip
    # before revealing any ranges made long imports unnecessarily slow.
    update(item, "Preparing editable clips", 90)
    clips = [clip_defaults(start, end, i) for i, (start, end) in enumerate(segments)]
    check_cancelled(item)
    with projects_lock:
        latest = store.get(project_id) or project
        if int(latest.get("edit_revision", 0)) != start_edit_revision:
            raise RuntimeError(
                "The project changed while analysis was running. Your edits were kept; retry analysis."
            )
        latest["clips"] = clips
        latest["duration"] = round(metadata(source)[0], 3)
        latest["edit_revision"] = start_edit_revision + 1
        store.save(latest)
    return {}


def smart_highlights_job(
    item: dict, project: dict, source: Path, target: float, options: dict
):
    """Rank a subset while retaining every original clip and the source file."""
    from .highlights import suggest_highlights

    transcript = (
        project.get("transcript", []) if options.get("use_transcript", True) else []
    )
    warning = None
    provider = options.get("provider") or value("CLIPFLOW_HIGHLIGHT_PROVIDER", "local")
    if provider == "groq" and not value("GROQ_API_KEY"):
        raise RuntimeError(
            "Add a Groq key in Settings, or choose free local highlights."
        )
    if not transcript and options.get("use_transcript", True):
        has_audio = any(
            stream.get("codec_type") == "audio"
            for stream in media.probe(source).get("streams", [])
        )
        if has_audio:
            try:
                transcript = speech.transcribe(
                    source,
                    project["duration"],
                    lambda stage, percent: update(item, stage, int(percent * 0.55)),
                )
            except (RuntimeError, MemoryError) as exc:
                message = str(exc)
                if exc.__class__.__name__ == "JobCancelled" or "cancel" in message.lower():
                    raise
                # Local highlights remain useful when Whisper is unavailable,
                # but expose the degraded path instead of claiming transcript
                # evidence was analyzed. Hosted ranking still requires text.
                if provider != "local":
                    raise
                warning = (
                    "Speech analysis was unavailable; structural scene/silence "
                    "fallback used."
                )
    if provider == "groq" and not transcript:
        raise RuntimeError(
            "Hosted highlights need a transcript. Enable speech analysis or choose local highlights for silent footage."
        )
    highlight_kwargs = {}
    if options.get("strict_max") is not None:
        highlight_kwargs["strict_max"] = options["strict_max"]
    if "sentence_context" in options:
        highlight_kwargs["sentence_context"] = options["sentence_context"]
    suggestions = suggest_highlights(
        source,
        transcript,
        target,
        options.get("max_clips", 5),
        options.get("tolerance", 0.3),
        options.get("topic", ""),
        provider,
        lambda stage, percent: update(item, stage, 55 + int(percent * 0.4)),
        **highlight_kwargs,
    )
    check_cancelled(item)
    with projects_lock:
        latest = store.get(project["id"]) or project
        if transcript and transcript != latest.get("transcript", []):
            latest["transcript"] = transcript
            for clip in latest["clips"]:
                if not clip.get("caption_text"):
                    clip.update(revision=clip.get("revision", 1) + 1, status="draft")
                    clip.pop("download_url", None)
        for clip in latest["clips"]:
            if clip.get("suggestion_status") != "kept":
                clip["selected"] = False
        for suggestion in suggestions:
            # Re-running with identical settings reuses ranges instead of
            # filling the workspace with duplicate suggestions.
            clip = next(
                (
                    c
                    for c in latest["clips"]
                    if abs(c["start"] - suggestion["start"]) < 0.1
                    and abs(c["end"] - suggestion["end"]) < 0.1
                ),
                None,
            )
            if clip is None:
                clip = clip_defaults(
                    suggestion["start"], suggestion["end"], len(latest["clips"])
                )
                clip["title"] = suggestion.get("title", "Suggested highlight")[:150]
                clip["suggestion_status"] = "pending"
                clip["reviewed"] = False
                latest["clips"].append(clip)
            if clip.get("suggestion_status") == "discarded":
                clip["selected"] = False
                continue
            clip.update(
                selected=True,
                reason=suggestion.get("reason", "Suggested highlight"),
                score=suggestion.get("score", 0),
            )
        latest["last_analysis"] = {
            "mode": "smart",
            "count": len(suggestions),
            "provider": provider,
            "target_duration": target,
            "strict_max": options.get("strict_max"),
            "sentence_context": options.get("sentence_context", "keep"),
        }
        if warning:
            latest["last_analysis"]["warning"] = warning
        latest["edit_revision"] = int(latest.get("edit_revision", 0)) + 1
        store.save(latest)
    update(item, f"Selected {len(suggestions)} highlights", 99)
    return {"warning": warning} if warning else {}


def upload_job(item: dict, project_id: str, target: float):
    return analyze_job(item, project_id, target)


def _cleanup_youtube_downloads(project_id: str) -> None:
    """Remove only downloader-owned partials for this generated project ID."""
    root = store.files.resolve()
    for path in store.files.glob(f"{project_id}.download.*"):
        try:
            if path.resolve().parent == root and path.is_file():
                path.unlink(missing_ok=True)
        except OSError:
            continue


def youtube_job(item: dict, project_id: str, url: str, target: float):
    project = store.get(project_id)
    out = source_path(project_id)
    update(item, "downloading", 8)
    try:
        import yt_dlp  # type: ignore

        def download_progress(state):
            check_cancelled(item)
            total = state.get("total_bytes") or state.get("total_bytes_estimate") or 1
            ensure_workspace_space(
                min(MAX_UPLOAD, int(state.get("downloaded_bytes", 0)))
            )
            update(
                item,
                "Downloading source",
                min(24, 5 + int(state.get("downloaded_bytes", 0) / total * 19)),
            )

        opts = {
            "format": "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080]/bestvideo[height<=1080]+bestaudio",
            "outtmpl": str(out.with_suffix(".download.%(ext)s")),
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "socket_timeout": 30,
            "retries": 2,
            "max_filesize": MAX_UPLOAD,
            "progress_hooks": [download_progress],
            "js_runtimes": {"node": {}},
        }
        with yt_dlp.YoutubeDL(opts) as dl:
            info = dl.extract_info(url, download=True)
            project["title"] = str(info.get("title") or "YouTube import")[:200]
        candidates = [
            p
            for p in store.files.glob(f"{project_id}.download.*")
            if p.suffix.lower() not in {".part", ".ytdl"}
        ]
        if not candidates:
            raise RuntimeError("yt-dlp produced no media")
        shutil.move(str(candidates[0]), str(out))
    except ImportError as e:
        raise RuntimeError("YouTube support requires yt-dlp") from e
    except BaseException:
        _cleanup_youtube_downloads(project_id)
        raise
    d, w, h, fps = metadata(out)
    if d <= 0 or w <= 0:
        raise RuntimeError("downloaded YouTube media is unreadable")
    project.update(duration=round(d, 3), width=w, height=h, fps=round(fps, 3))
    store.save(project)
    update(item, "analyzing", 25)
    return analyze_job(item, project_id, target)


def demo_job(item: dict, project_id: str, target: float):
    out = source_path(project_id)
    update(item, "generating", 10)
    make_demo(out)
    project = store.get(project_id)
    d, w, h, fps = metadata(out)
    project.update(duration=round(d, 3), width=w, height=h, fps=round(fps, 3))
    store.save(project)
    return analyze_job(item, project_id, min(target, 30))


def export_job(item: dict, project_id: str, clip_ids: list[str], expected_revisions: dict | None = None):
    project = store.get(project_id)
    source = source_path(project_id)
    selected = [
        c
        for c in project["clips"]
        if (c["id"] in clip_ids if clip_ids else c.get("selected", True))
    ]
    if not selected:
        raise RuntimeError("no clips selected")
    if expected_revisions is not None and (
        {clip["id"] for clip in selected} != set(expected_revisions)
        or any(clip.get("revision", 1) != expected_revisions[clip["id"]] for clip in selected)
    ):
        raise RuntimeError("Clips changed while export was queued. Export the current edits again.")
    out_dir = store.files / project_id
    out_dir.mkdir(exist_ok=True)
    outputs = []
    rendered = []
    temp_outputs: list[Path] = []
    try:
        for i, clip in enumerate(selected):
            update(item, "rendering", 10 + int(80 * i / max(1, len(selected))))
            ensure_workspace_space(max(MIN_FREE_BYTES, source.stat().st_size))
            outfile = out_dir / f"{clip['id']}.mp4"
            temporary = out_dir / f".{clip['id']}.{item['id']}.mp4"
            temp_outputs.append(temporary)
            subtitle = srt_for_clip(
                clip, clip.get("transcript", project.get("transcript", [])), for_render=True
            )
            render_clip(
                source,
                clip,
                temporary,
                subtitle or None,
                lambda stage, percent, index=i: update(
                    item,
                    f"Clip {index + 1}/{len(selected)}: {stage}",
                    5 + int((index + percent / 100) / len(selected) * 90),
                ),
            )
            os.replace(temporary, outfile)
            temp_outputs.remove(temporary)
            clip["status"] = "exported"
            clip["download_url"] = f"/api/projects/{project_id}/clips/{clip['id']}/download"
            outputs.append((str(outfile), f"{clip['title']}.mp4"))
            rendered.append((clip, outfile))
        artifacts = finalize_exports(store, project_id, item["id"], rendered)
    except BaseException:
        for temporary in temp_outputs:
            temporary.unlink(missing_ok=True)
        raise
    with projects_lock:
        latest = store.get(project_id) or project
        completed = {c["id"]: c for c in selected}
        for clip in latest.get("clips", []):
            if clip["id"] in completed and clip.get("revision", 1) == completed[
                clip["id"]
            ].get("revision", 1):
                clip["status"] = "exported"
                clip["download_url"] = artifacts["artifact_urls"][clip["id"]]
        store.save(latest)
    if len(outputs) == 1:
        return {
            "download_url": artifacts["download_url"],
            "clip_titles": [clip["title"] for clip in selected],
        }
    archive = out_dir / f"{project_id}-clips.zip"
    ensure_workspace_space(sum(Path(path).stat().st_size for path, _ in outputs))
    temporary_archive = out_dir / f".{project_id}-{item['id']}.zip"
    try:
        make_zip(outputs, temporary_archive)
        os.replace(temporary_archive, archive)
    finally:
        temporary_archive.unlink(missing_ok=True)
    return {
        "download_url": artifacts["download_url"],
        "clip_titles": [clip["title"] for clip in selected],
    }


def preview_job(
    item: dict, project_id: str, clip_id: str, expected_revision: int | None = None
):
    project = store.get(project_id)
    clip = next((c for c in project["clips"] if c["id"] == clip_id), None)
    if not clip:
        raise RuntimeError("clip not found")
    revision = int(clip.get("revision", 1))
    if expected_revision is not None and revision != int(expected_revision):
        raise RuntimeError(
            "The clip changed before preview started. Render proof again with the current edit."
        )
    clip = copy.deepcopy(clip)
    out_dir = store.files / project_id
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"preview-{clip_id}-{item['id']}.mp4"
    ensure_workspace_space(max(MIN_FREE_BYTES, source_path(project_id).stat().st_size))
    temporary = out_dir / f".{clip_id}.{item['id']}.preview.mp4"
    try:
        render_clip(
            source_path(project_id),
            clip,
            temporary,
            srt_for_clip(
                clip, clip.get("transcript", project.get("transcript", [])), for_render=True
            )
            or None,
            lambda stage, percent: update(item, stage, percent),
        )
        os.replace(temporary, out)
    finally:
        temporary.unlink(missing_ok=True)
    latest = store.get(project_id)
    current = next(
        (c for c in (latest or {}).get("clips", []) if c["id"] == clip_id), None
    )
    if current is None or int(current.get("revision", 1)) != revision:
        out.unlink(missing_ok=True)
        raise RuntimeError(
            "The clip changed while preview rendered. The stale proof was discarded; render again."
        )
    return {
        "download_url": f"/api/projects/{project_id}/clips/{clip_id}/previews/{item['id']}",
        "preview_revision": revision,
    }


def transcribe_job(item: dict, project_id: str, options: dict | None = None):
    """Recognize only the requested range, and keep clip captions independent."""
    project = store.get(project_id)
    request = options or {}
    clip_id = request.get("clip_id")
    target = (
        next((c for c in project["clips"] if c["id"] == clip_id), None)
        if clip_id
        else project
    )
    if target is None:
        raise RuntimeError("The selected clip no longer exists.")
    start, end = (
        (float(target["start"]), float(target["end"]))
        if clip_id
        else (0.0, float(project["duration"]))
    )
    settings = speech.effective_options(
        {k: v for k, v in request.items() if k not in {"clip_id", "force"}}
    )
    source = source_path(project_id)
    stat = source.stat()
    signature = {
        "source_size": stat.st_size,
        "source_modified": stat.st_mtime_ns,
        "start": start,
        "end": end,
        "settings": settings,
    }
    key = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
    if (
        not request.get("force")
        and target.get("transcription_key") == key
        and target.get("transcript")
    ):
        update(item, "Using saved captions", 99)
        return {"cached": True}
    cached = next(
        (entry for entry in project.get("speech_cache", []) if entry["key"] == key),
        None,
    )
    if cached and not request.get("force"):
        transcript = cached["segments"]
        update(item, "Using cached recognition", 95)
    else:
        progress = lambda stage, percent: update(item, stage, percent)
        if clip_id:
            # Extract before recognition: a short edit must not decode the full source.
            with tempfile.TemporaryDirectory(
                prefix="speech-clip-", dir=source.parent
            ) as temp:
                audio = Path(temp) / "clip.wav"
                update(item, "Preparing selected clip audio", 2)
                media.run(
                    [
                        media.FFMPEG,
                        "-y",
                        "-ss",
                        str(start),
                        "-i",
                        str(source),
                        "-t",
                        str(end - start),
                        "-vn",
                        "-map",
                        "0:a:0",
                        "-ac",
                        "1",
                        "-ar",
                        "16000",
                        str(audio),
                    ],
                    180,
                )
                rows = speech.transcribe(audio, end - start, progress, settings)
                transcript = [
                    {
                        **row,
                        "start": round(start + row["start"], 3),
                        "end": round(min(end, start + row["end"]), 3),
                    }
                    for row in rows
                ]
        else:
            transcript = speech.transcribe(source, end, progress, settings)
    check_cancelled(item)
    with projects_lock:
        latest = store.get(project_id) or project
        latest_target = (
            next((c for c in latest["clips"] if c["id"] == clip_id), None)
            if clip_id
            else latest
        )
        if latest_target is None or (
            clip_id and (latest_target["start"] != start or latest_target["end"] != end)
        ):
            raise RuntimeError(
                "The clip range changed during transcription. Transcribe it again with the new range."
            )
        latest_target.update(
            transcript=transcript,
            transcription_key=key,
            transcription_settings=settings,
        )
        affected = (
            [latest_target]
            if clip_id
            else [c for c in latest["clips"] if "transcript" not in c]
        )
        for clip in affected:
            if not clip.get("caption_text"):
                clip["revision"] = clip.get("revision", 1) + 1
                clip["status"] = "draft"
                clip.pop("download_url", None)
        latest["speech_cache"] = (
            [entry for entry in latest.get("speech_cache", []) if entry["key"] != key]
            + [{"key": key, "segments": transcript}]
        )[-6:]
        latest["edit_revision"] = int(latest.get("edit_revision", 0)) + 1
        store.save(latest)
    return {"cached": bool(cached and not request.get("force"))}


@app.get("/api/health")
def health():
    configuration = public_capabilities()
    configuration["storage"] = {"free_bytes": shutil.disk_usage(DATA).free}
    return {
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "ffprobe": bool(shutil.which("ffprobe")),
        "transcription": configuration["transcription"]["available"],
        "configuration": configuration,
    }


@app.get("/api/projects")
def list_projects():
    return [public_project(project) for project in store.list()]


@app.post("/api/projects/upload")
async def upload_project(
    file: UploadFile = File(...), target_duration: float = Form(30)
):
    if (
        not math.isfinite(target_duration)
        or target_duration < 5
        or target_duration > 300
    ):
        raise HTTPException(400, "target_duration must be 5..300")
    suffix = Path(file.filename or "source.mp4").suffix.lower() or ".mp4"
    if suffix not in {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}:
        raise HTTPException(400, "Choose an MP4, MOV, MKV, WebM, AVI, or M4V video.")
    temp = DATA / f"upload-{uuid.uuid4().hex}{suffix}"
    size = 0
    try:
        with temp.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, "upload exceeds 500 MB")
                if shutil.disk_usage(DATA).free < len(chunk) + 32 * 1024 * 1024:
                    raise HTTPException(
                        507,
                        "Not enough storage for this video. Free disk space or change CLIPFLOW_DATA in .env.",
                    )
                f.write(chunk)
        project = await asyncio.to_thread(
            create_project, temp, Path(file.filename or "Untitled").stem, "", True
        )
    finally:
        temp.unlink(missing_ok=True)
    return submit(project["id"], upload_job, project["id"], target_duration)


@app.post("/api/projects/youtube")
def youtube_project(body: YouTubeInput):
    from urllib.parse import urlparse

    parsed = urlparse(body.url)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme not in {"https", "http"}
        or parsed.username
        or parsed.password
        or host
        not in {
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "youtu.be",
            "www.youtu.be",
        }
    ):
        raise HTTPException(400, "Enter a valid YouTube video URL.")
    pid = store.create_id()
    project = store.save(
        {
            "id": pid,
            "title": "YouTube import",
            "duration": 0,
            "width": 0,
            "height": 0,
            "fps": 0,
            "source_url": f"/api/projects/{pid}/source",
            "thumbnail_url": f"/api/projects/{pid}/thumbnail",
            "clips": [],
            "transcript": [],
            "created_at": utc_now(),
        }
    )
    # Placeholder extension is replaced by the downloader; this file is not served until ready.
    (store.files / f"{pid}.mp4").touch()
    return submit(pid, youtube_job, pid, body.url, body.target_duration)


@app.post("/api/projects/demo")
def demo_project(body: DemoInput | None = None):
    pid = store.create_id()
    (store.files / f"{pid}.mp4").touch()
    project = store.save(
        {
            "id": pid,
            "title": "Moving shapes demo",
            "duration": 12,
            "width": 1280,
            "height": 720,
            "fps": 30,
            "source_url": f"/api/projects/{pid}/source",
            "thumbnail_url": f"/api/projects/{pid}/thumbnail",
            "clips": [],
            "transcript": [],
            "created_at": utc_now(),
        }
    )
    return submit(pid, demo_job, pid, body.target_duration if body else 30)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with jobs_lock:
        item = jobs.get(job_id)
        if not item:
            raise HTTPException(404, "job not found")
        return job_view(copy.deepcopy(item))


@app.get("/api/jobs")
def list_jobs():
    with jobs_lock:
        values = copy.deepcopy(list(jobs.values()))
    return [job_view(value) for value in sorted(values, key=lambda value: value.get("created_at", ""), reverse=True)]


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    with jobs_lock:
        item = jobs.get(job_id)
        if not item:
            raise HTTPException(404, "job not found")
        if item.get("status") in {"done", "error", "cancelled"}:
            return job_view(copy.deepcopy(item))
        event = cancel_events.get(job_id)
        if event:
            event.set()
        item = copy.deepcopy(item)
        item.update(
            status="running",
            stage="cancelling",
            cancel_requested=True,
            error="cancel requested",
            updated_at=utc_now(),
        )
        jobs[job_id] = item
        store.save_jobs(copy.deepcopy(jobs))
        return job_view(item)


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str):
    with jobs_lock:
        old = copy.deepcopy(jobs.get(job_id))
    if not old:
        raise HTTPException(404, "job not found")
    if old.get("status") in {"queued", "running"} or old.get("cancel_requested"):
        raise HTTPException(409, "wait for cancellation to finish before retrying")
    handlers = {
        "analyze_job": analyze_job,
        "upload_job": upload_job,
        "youtube_job": youtube_job,
        "demo_job": demo_job,
        "export_job": export_job,
        "preview_job": preview_job,
        "transcribe_job": transcribe_job,
    }
    if generation_handler is not None:
        handlers["higgsfield_job"] = generation_handler
    handler = handlers.get(old.get("kind"))
    if not handler:
        raise HTTPException(400, "job type cannot be retried")
    return submit(old.get("project_id"), handler, *old.get("args", []))


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    p = store.get(project_id)
    if not p:
        raise HTTPException(404, "project not found")
    return public_project(p)


def public_project(project: dict) -> dict:
    """Keep recognition cache/trash payloads server-side, with a recovery flag."""
    return {
        **{
            key: val
            for key, val in project.items()
            if key not in {"speech_cache", "clip_trash"}
        },
        "can_restore_clips": bool(project.get("clip_trash")),
    }


def range_response(path: Path, request_range: str | None):
    size = path.stat().st_size
    if not size:
        raise HTTPException(409, "Source is still being prepared.")
    if not request_range:
        return FileResponse(path, media_type="video/mp4")
    try:
        if not request_range.startswith("bytes=") or "," in request_range:
            raise ValueError
        val = request_range.removeprefix("bytes=").split("-")
        if len(val) != 2:
            raise ValueError
        if not val[0]:
            suffix = int(val[1])
            if suffix <= 0:
                raise ValueError
            start, end = max(0, size - suffix), size - 1
        else:
            start = int(val[0])
            end = int(val[1]) if val[1] else size - 1
        end = min(end, size - 1)
        length = end - start + 1
        if start < 0 or start >= size or end < start:
            raise ValueError

        def iterator():
            with path.open("rb") as f:
                f.seek(start)
                remain = length
                while remain:
                    data = f.read(min(1024 * 1024, remain))
                    if not data:
                        break
                    remain -= len(data)
                    yield data

        return StreamingResponse(
            iterator(),
            status_code=206,
            media_type="video/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
            },
        )
    except (ValueError, IndexError):
        raise HTTPException(
            416, "invalid range", headers={"Content-Range": f"bytes */{size}"}
        )


@app.get("/api/projects/{project_id}/source")
def source(project_id: str, range: str | None = Header(default=None, alias="Range")):
    return range_response(source_path(project_id), range)


@app.get("/api/projects/{project_id}/thumbnail")
def thumbnail(project_id: str):
    src = source_path(project_id)
    out = store.files / f"{project_id}.jpg"
    if not out.exists():
        try:
            media.run(
                [
                    media.FFMPEG,
                    "-y",
                    "-ss",
                    "0.5",
                    "-i",
                    str(src),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:-2",
                    str(out),
                ],
                120,
            )
        except Exception:
            raise HTTPException(404, "thumbnail unavailable")
    return FileResponse(workspace_file(out), media_type="image/jpeg")


CLIP_FIELDS = {
    "title",
    "start",
    "end",
    "selected",
    "framing",
    "focus_x",
    "smoothing",
    "caption_text",
    "caption_style",
    "caption_color",
    "caption_position",
    "caption_x",
    "caption_y",
    "caption_enabled",
    "playback_speed",
    "audio_volume",
    "audio_denoise",
    "audio_fade",
    "resolution",
    "subject",
    "suggestion_status",
    "reviewed",
}
MEDIA_CLIP_FIELDS = {
    "start",
    "end",
    "framing",
    "focus_x",
    "smoothing",
    "caption_text",
    "caption_style",
    "caption_color",
    "caption_position",
    "caption_x",
    "caption_y",
    "caption_enabled",
    "playback_speed",
    "audio_volume",
    "audio_denoise",
    "audio_fade",
    "resolution",
    "subject",
}


def validate_clip(clip: dict, duration: float):
    try:
        clip["start"], clip["end"] = float(clip["start"]), float(clip["end"])
        if (
            not math.isfinite(clip["start"])
            or not math.isfinite(clip["end"])
            or clip["start"] < 0
            or clip["end"] <= clip["start"]
            or clip["end"] > duration
        ):
            raise ValueError
        for field in ("focus_x", "smoothing"):
            clip[field] = float(clip[field])
            if not math.isfinite(clip[field]) or not 0 <= clip[field] <= 1:
                raise ValueError
        if clip["resolution"] not in (180, 360, 720, 1080):
            raise ValueError
        if clip["framing"] not in ("follow", "manual", "fit"):
            raise ValueError
        if clip.get("subject", "auto") not in ("auto", "left", "right"):
            raise ValueError
        if clip.get("suggestion_status", "pending") not in (
            "pending",
            "kept",
            "discarded",
        ):
            raise ValueError
        if not isinstance(clip.get("reviewed", False), bool):
            raise ValueError
        if clip["caption_style"] not in ("clean", "bold", "minimal"):
            raise ValueError
        if clip["caption_position"] not in ("bottom", "center"):
            raise ValueError
        if not isinstance(clip["caption_color"], str) or not re.fullmatch(
            r"#[0-9a-fA-F]{6}", clip["caption_color"]
        ):
            raise ValueError
        if (
            not isinstance(clip["title"], str)
            or not 1 <= len(clip["title"].strip()) <= 150
        ):
            raise ValueError
        if (
            not isinstance(clip["caption_text"], str)
            or len(clip["caption_text"]) > 4000
        ):
            raise ValueError
        if not isinstance(clip["selected"], bool):
            raise ValueError
        if not isinstance(clip.get("caption_enabled", True), bool):
            raise ValueError
        if not isinstance(clip.get("audio_denoise", False), bool):
            raise ValueError
        for field, default, low, high in (
            ("playback_speed", 1.0, 0.5, 2.0),
            ("audio_volume", 1.0, 0.0, 2.0),
            ("audio_fade", 0.0, 0.0, 2.0),
        ):
            raw = clip.get(field, default)
            if isinstance(raw, bool):
                raise ValueError
            clip[field] = float(raw)
            if not math.isfinite(clip[field]) or not low <= clip[field] <= high:
                raise ValueError
        for field in ("caption_x", "caption_y"):
            if field in clip:
                clip[field] = float(clip[field])
                if not math.isfinite(clip[field]) or not 0.05 <= clip[field] <= 0.95:
                    raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(
            400,
            "Invalid clip settings. Check time bounds, framing, captions, speed, and audio values.",
        )


@app.patch("/api/projects/{project_id}/clips/{clip_id}")
def patch_clip(project_id: str, clip_id: str, body: dict[str, Any]):
    with projects_lock:
        p = store.get(project_id)
        clip = next((c for c in p["clips"] if c["id"] == clip_id), None) if p else None
        if not clip:
            raise HTTPException(404, "clip not found")
        # Validate supplied values even when Python considers them equal (True == 1).
        candidate = {**clip, **{k: v for k, v in body.items() if k in CLIP_FIELDS}}
        validate_clip(candidate, float(p["duration"]))
        changes = {
            k: v for k, v in body.items() if k in CLIP_FIELDS and clip.get(k) != v
        }
        if (
            "caption_position" in changes
            and not {"caption_x", "caption_y"} & body.keys()
        ):
            changes.update(
                caption_x=0.5,
                caption_y=0.5 if changes["caption_position"] == "center" else 0.86,
            )
        clip.update(changes)
        if "suggestion_status" in changes:
            clip["reviewed"] = True
            if changes["suggestion_status"] == "discarded":
                clip["selected"] = False
            elif changes["suggestion_status"] == "kept":
                clip["selected"] = True
        validate_clip(clip, float(p["duration"]))
        if changes.keys() & {"start", "end"}:
            # The old scoped recognition stays in cache; it no longer covers this trim.
            clip.pop("transcript", None)
            clip.pop("transcription_key", None)
        if changes.keys() & MEDIA_CLIP_FIELDS:
            clip["revision"] = int(clip.get("revision", 1)) + 1
            clip["status"] = "draft"
            clip.pop("download_url", None)
            clip.pop("preview_revision", None)
        if changes:
            p["edit_revision"] = int(p.get("edit_revision", 0)) + 1
        store.save(p)
        return clip


@app.post("/api/projects/{project_id}/clips")
def add_clip(project_id: str, body: dict[str, Any]):
    with projects_lock:
        p = store.get(project_id)
        if not p:
            raise HTTPException(404, "project not found")
        clip = clip_defaults(0, min(30, p["duration"]), len(p["clips"]))
        clip.update({k: v for k, v in body.items() if k in CLIP_FIELDS})
        validate_clip(clip, float(p["duration"]))
        # A passage clip inherits corrected speech from its parent, with source timestamps.
        if body.get("source_clip_id"):
            parent = next(
                (c for c in p["clips"] if c["id"] == body["source_clip_id"]), None
            )
            if parent is None:
                raise HTTPException(404, "source clip not found")
            if "transcript" in parent:
                clip["transcript"] = [
                    {
                        **row,
                        "start": max(row["start"], clip["start"]),
                        "end": min(row["end"], clip["end"]),
                    }
                    for row in parent["transcript"]
                    if row["end"] > clip["start"] and row["start"] < clip["end"]
                ]
        p["clips"].append(clip)
        p["edit_revision"] = int(p.get("edit_revision", 0)) + 1
        store.save(p)
        return clip


@app.delete("/api/projects/{project_id}/clips/{clip_id}")
def delete_clip(project_id: str, clip_id: str):
    with projects_lock:
        p = store.get(project_id)
        if not p:
            raise HTTPException(404, "project not found")
        old = len(p["clips"])
        p["clips"] = [c for c in p["clips"] if c["id"] != clip_id]
        if len(p["clips"]) == old:
            raise HTTPException(404, "clip not found")
        p["edit_revision"] = int(p.get("edit_revision", 0)) + 1
        store.save(p)
        return {"ok": True}


@app.post("/api/projects/{project_id}/clips/bulk")
def bulk_clips(project_id: str, body: BulkClipsInput):
    with projects_lock:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "project not found")
        with jobs_lock:
            busy = any(
                job.get("project_id") == project_id
                and job.get("status") in {"queued", "running"}
                for job in jobs.values()
            )
        if busy:
            raise HTTPException(409, "Wait for the current job before removing clips.")
        if body.action == "delete":
            ids = set(body.clip_ids)
            if not ids or not ids.issubset({clip["id"] for clip in project["clips"]}):
                raise HTTPException(400, "Choose existing clips to remove.")
            project["clip_trash"] = [
                {"index": index, "clip": clip}
                for index, clip in enumerate(project["clips"])
                if clip["id"] in ids
            ]
            project["clips"] = [
                clip for clip in project["clips"] if clip["id"] not in ids
            ]
        else:
            existing = {clip["id"] for clip in project["clips"]}
            for entry in sorted(
                project.get("clip_trash", []), key=lambda entry: entry["index"]
            ):
                if entry["clip"]["id"] not in existing:
                    project["clips"].insert(
                        min(entry["index"], len(project["clips"])), entry["clip"]
                    )
            project.pop("clip_trash", None)
        project["edit_revision"] = int(project.get("edit_revision", 0)) + 1
        store.save(project)
        return public_project(project)


@app.post("/api/projects/{project_id}/analyze")
def analyze(project_id: str, body: AnalyzeInput):
    if not store.get(project_id):
        raise HTTPException(404, "project not found")
    options = (
        body.model_dump(exclude={"target_duration"}) if body.mode == "smart" else None
    )
    return (
        submit(project_id, analyze_job, project_id, body.target_duration, options)
        if options
        else submit(project_id, analyze_job, project_id, body.target_duration)
    )


@app.post("/api/projects/{project_id}/transcribe")
def transcribe(project_id: str, body: TranscribeInput | None = None):
    project = store.get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    if (
        body
        and body.clip_id
        and not any(c["id"] == body.clip_id for c in project["clips"])
    ):
        raise HTTPException(404, "clip not found")
    capability = public_capabilities()["transcription"]
    if not capability["available"]:
        raise HTTPException(503, capability["message"])
    return (
        submit(
            project_id, transcribe_job, project_id, body.model_dump(exclude_none=True)
        )
        if body
        else submit(project_id, transcribe_job, project_id)
    )


@app.put("/api/projects/{project_id}/transcript")
def correct_transcript(project_id: str, body: TranscriptInput):
    """Correct caption text without changing the original media or its timestamps."""
    with projects_lock:
        project = store.get(project_id)
        if not project:
            raise HTTPException(404, "project not found")
        if any(
            job.get("project_id") == project_id
            and job.get("status") in {"queued", "running"}
            for job in jobs.values()
        ):
            raise HTTPException(
                409, "Wait for the current job before correcting the transcript."
            )
        target = (
            next((c for c in project["clips"] if c["id"] == body.clip_id), None)
            if body.clip_id
            else project
        )
        if target is None:
            raise HTTPException(404, "clip not found")
        original = target.get("transcript", [])
        if not original or len(body.segments) != len(original):
            raise HTTPException(
                400,
                "Keep the existing transcript segments; transcribe the source first.",
            )
        rows = [segment.model_dump() for segment in body.segments]
        if sum(len(row["text"]) for row in rows) > 1_000_000:
            raise HTTPException(400, "Transcript text is too long.")
        for row, previous in zip(rows, original):
            if row["start"] != previous["start"] or row["end"] != previous["end"]:
                raise HTTPException(
                    400, "Transcript correction cannot change segment timestamps."
                )
            row["text"] = row["text"].strip()
        if rows != original:
            target["transcript"] = rows
            # Rendered automatic captions are now stale; manual caption overlays remain valid.
            for clip in (
                [target]
                if body.clip_id
                else [c for c in project["clips"] if "transcript" not in c]
            ):
                if not clip.get("caption_text"):
                    clip["revision"] = clip.get("revision", 1) + 1
                    clip["status"] = "draft"
                    clip.pop("download_url", None)
            project["edit_revision"] = int(project.get("edit_revision", 0)) + 1
            store.save(project)
        return public_project(project)


@app.post("/api/projects/{project_id}/export")
def export(project_id: str, body: ExportInput):
    project = store.get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    selected = [clip for clip in project["clips"] if (
        clip["id"] in body.clip_ids if body.clip_ids else clip.get("selected", True)
    )]
    if not selected:
        raise HTTPException(400, "Choose at least one clip to export.")
    # Capture both membership and revisions at the user's export action.
    # A queued job must not silently render later edits or a changed selection.
    return submit(project_id, export_job, project_id,
                  [clip["id"] for clip in selected],
                  {clip["id"]: clip.get("revision", 1) for clip in selected})


@app.post("/api/projects/{project_id}/preview")
def preview(project_id: str, body: PreviewInput):
    project = store.get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    clip = next((c for c in project.get("clips", []) if c["id"] == body.clip_id), None)
    if not clip:
        raise HTTPException(404, "clip not found")
    return submit(
        project_id,
        preview_job,
        project_id,
        body.clip_id,
        int(clip.get("revision", 1)),
    )


@app.get("/api/projects/{project_id}/clips/{clip_id}/captions")
def captions(project_id: str, clip_id: str):
    p = store.get(project_id)
    clip = next((c for c in p["clips"] if c["id"] == clip_id), None) if p else None
    if not clip:
        raise HTTPException(404, "clip not found")
    return PlainTextResponse(
        srt_for_clip(clip, clip.get("transcript", p.get("transcript", []))),
        media_type="application/x-subrip",
        headers={"Content-Disposition": f"attachment; filename={clip_id}.srt"},
    )


@app.get("/api/projects/{project_id}/clips/{clip_id}/download")
def clip_download(project_id: str, clip_id: str):
    safe_identifier(project_id)
    safe_identifier(clip_id)
    path = workspace_file(store.files / project_id / f"{clip_id}.mp4")
    if not path.exists():
        raise HTTPException(404, "clip is not exported")
    return FileResponse(path, media_type="video/mp4", filename=f"{clip_id}.mp4")


@app.get("/api/projects/{project_id}/clips/{clip_id}/preview")
def clip_preview(project_id: str, clip_id: str):
    safe_identifier(project_id)
    safe_identifier(clip_id)
    project = store.get(project_id)
    clip = next((c for c in (project or {}).get("clips", []) if c["id"] == clip_id), None)
    if not clip or int(clip.get("preview_revision", -1)) != int(clip.get("revision", 1)):
        raise HTTPException(404, "preview is not ready for this clip revision")
    path = workspace_file(store.files / project_id / f"preview-{clip_id}.mp4")
    if not path.exists():
        raise HTTPException(404, "preview is not ready")
    return FileResponse(path, media_type="video/mp4")


@app.get("/api/projects/{project_id}/clips/{clip_id}/previews/{job_id}")
def immutable_preview(project_id: str, clip_id: str, job_id: str):
    safe_identifier(project_id)
    safe_identifier(clip_id)
    safe_identifier(job_id)
    path = workspace_file(
        store.files / project_id / f"preview-{clip_id}-{job_id}.mp4"
    )
    return FileResponse(path, media_type="video/mp4")


@app.get("/api/projects/{project_id}/download")
def project_download(project_id: str):
    safe_identifier(project_id)
    path = workspace_file(store.files / project_id / f"{project_id}-clips.zip")
    if not path.exists():
        raise HTTPException(404, "batch export is not ready")
    return FileResponse(
        path, media_type="application/zip", filename=f"{project_id}-clips.zip"
    )


from .settings import register as register_settings

register_export_routes(app, lambda: store)

register_settings(
    app,
    lambda: any(job.get("status") in {"running", "queued"} for job in jobs.values()),
)

from .generation import register as register_generation

generation_handler = register_generation(
    app, submit, store, create_project, analyze_job, update
)

frontend = ROOT / "frontend" / "dist"
if frontend.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
