from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from typing import Callable
from .caption_layout import caption_cues, font_name, fonts_directory, word_caption_cues

from .camera import (
    CameraController,
    CameraPoint,
    TrackedTarget,
    camera_settings,
    choose_target,
    interpolate_keyframes,
)
from .vision_framing import (
    analyze_frame,
    boxes_fit_viewport,
    full_frame_view,
    gemini_vision_plans,
    safe_zoom_for_boxes,
)

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"
Progress = Callable[[str, int], None]
_cancel_state = threading.local()


def set_cancel_check(check: Callable[[], bool] | None) -> None:
    _cancel_state.check = check


def _check_cancel() -> None:
    check = getattr(_cancel_state, "check", None)
    if check and check():
        raise RuntimeError("job cancelled")


def run(
    args: list[str], timeout: int = 1800, *, capture: bool = True
) -> subprocess.CompletedProcess:
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    started = time.monotonic()
    try:
        while True:
            try:
                # communicate(timeout) drains both pipes while still giving
                # cancellation and timeout checks during long encodes.
                stdout, stderr = process.communicate(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic() - started > timeout:
                    process.kill()
                    stdout, stderr = process.communicate(timeout=10)
                    raise subprocess.TimeoutExpired(
                        args, timeout, output=stdout, stderr=stderr
                    )
                _check_cancel()
    except BaseException:
        if process.poll() is None:
            process.kill()
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        raise
    result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
    if process.returncode:
        raise subprocess.CalledProcessError(
            process.returncode, args, output=stdout, stderr=stderr
        )
    return result


def probe(path: str | Path) -> dict:
    try:
        r = run(
            [
                FFPROBE,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            120,
        )
        return json.loads(r.stdout)
    except Exception as exc:
        if exc.__class__.__name__ == "JobCancelled" or "cancel" in str(exc).lower():
            raise
        return {"streams": [], "format": {}}


def metadata(path: str | Path) -> tuple[float, int, int, float]:
    data = probe(path)
    fmt = data.get("format", {})
    duration = float(fmt.get("duration") or 0)
    video = next(
        (x for x in data.get("streams", []) if x.get("codec_type") == "video"), {}
    )
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    rate = video.get("r_frame_rate", "30/1")
    try:
        fps = float(rate.split("/")[0]) / float(rate.split("/")[1])
    except Exception:
        fps = 30.0
    return duration, width, height, fps


def _safe_time(seconds: float) -> str:
    h, rest = divmod(max(0, seconds), 3600)
    m, s = divmod(rest, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}".replace(".", ",")


def _playback_speed(clip: dict) -> float:
    """Normalize the user-facing speed range before it reaches FFmpeg."""
    try:
        speed = float(clip.get("playback_speed", 1.0))
    except (TypeError, ValueError):
        speed = 1.0
    return max(0.5, min(2.0, speed)) if math.isfinite(speed) else 1.0


def _audio_volume(clip: dict) -> float:
    try:
        volume = float(clip.get("audio_volume", 1.0))
    except (TypeError, ValueError):
        volume = 1.0
    return max(0.0, min(2.0, volume)) if math.isfinite(volume) else 1.0


def _audio_fade(clip: dict) -> float:
    try:
        fade = float(clip.get("audio_fade", 0.0))
    except (TypeError, ValueError):
        fade = 0.0
    return max(0.0, min(2.0, fade)) if math.isfinite(fade) else 0.0


def srt_for_clip(
    clip: dict, transcript: list[dict], *, for_render: bool = False
) -> str:
    """Build captions in output time for downloads or source time for rendering.

    The renderer burns captions before its postprocess speed change, so it must
    receive source-time events (``for_render=True``). Standalone SRT downloads
    are already in the final playback timeline and therefore divide offsets by
    playback speed.
    """
    start, end = float(clip["start"]), float(clip["end"])
    speed = _playback_speed(clip)
    scale = 1.0 if for_render else 1.0 / speed
    rows = []
    for item in transcript:
        a, b = float(item.get("start", 0)), float(item.get("end", 0))
        text = str(item.get("text", "")).strip()
        if b <= start or a >= end or not text:
            continue
        timed = word_caption_cues(item, start, end)
        if timed is None:
            rows.append((max(a, start) - start, min(b, end) - start, text))
        else:
            rows.extend(
                (cue_start - start, cue_end - start, cue_text)
                for cue_start, cue_end, cue_text in timed
            )
    manual = str(clip.get("caption_text", "")).strip()
    if manual:
        rows = [(0.0, (end - start) * scale, manual)]
    elif scale != 1.0:
        rows = [(a * scale, b * scale, text) for a, b, text in rows]
    return "\n\n".join(
        f"{i}\n{_safe_time(a)} --> {_safe_time(b)}\n{text}"
        for i, (a, b, text) in enumerate(rows, 1)
    ) + ("\n" if rows else "")


def detect_silence(path: str | Path) -> list[tuple[float, float]]:
    try:
        _check_cancel()
        r = run(
            [
                FFMPEG,
                "-hide_banner",
                "-vn",
                "-sn",
                "-i",
                str(path),
                "-af",
                "silencedetect=n=-35dB:d=0.35",
                "-f",
                "null",
                "-",
            ],
            300,
        )
        starts, ranges = [], []
        for line in r.stderr.splitlines():
            m = re.search(r"silence_start: ([\d.]+)", line)
            if m:
                starts.append(float(m.group(1)))
            m = re.search(r"silence_end: ([\d.]+)", line)
            if m and starts:
                ranges.append((starts.pop(0), float(m.group(1))))
        return ranges
    except Exception as exc:
        # JobCancelled is defined by the API layer; avoid importing it here,
        # but never turn a user cancellation into a silent scene fallback.
        if exc.__class__.__name__ == "JobCancelled" or "cancel" in str(exc).lower():
            raise
        return []


def _scene_points(
    path: str | Path, duration: float, fps: float, progress: Progress | None = None
) -> list[float]:
    """Find coarse scene changes from a sparse, resized FFmpeg stream.

    Decoding every full-resolution frame in Python made a 20-minute source
    appear hung. FFmpeg still decodes the source once, but emits only one
    160x90 grayscale frame per second, keeping Python work and memory bounded.
    Do not use ``-skip_frame nokey`` here: that decoder option discards all
    non-keyframes, so the ``fps=1`` stream would compare GOP/keyframe samples
    instead of adjacent seconds and could miss a real cut between keyframes.
    """
    try:
        import numpy as np  # type: ignore
    except Exception:
        return []
    try:
        frame_w, frame_h = 160, 90
        proc = subprocess.Popen(
            [
                FFMPEG,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(path),
                "-vf",
                "fps=1,scale=160:90:flags=fast_bilinear,format=gray",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        points: list[float] = []
        previous = None
        index = 0
        aborted = False
        try:
            try:
                while proc.stdout:
                    _check_cancel()
                    raw = proc.stdout.read(frame_w * frame_h)
                    if len(raw) != frame_w * frame_h:
                        break
                    current = np.frombuffer(raw, dtype=np.uint8)
                    if (
                        previous is not None
                        and float(
                            np.abs(
                                current.astype(np.int16) - previous.astype(np.int16)
                            ).mean()
                        )
                        > 18
                    ):
                        points.append(float(index))
                    previous = current
                    index += 1
                    if progress and index % 10 == 0:
                        progress(
                            "analyzing", 5 + min(15, int(index / max(duration, 1) * 15))
                        )
            except Exception:
                aborted = True
                raise
        finally:
            if proc.stdout:
                proc.stdout.close()
            if aborted:
                proc.kill()
                proc.wait(timeout=10)
            else:
                try:
                    proc.wait(timeout=120)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
        return [p for p in points if 1 < p < duration - 1]
    except Exception as exc:
        # Preserve API cancellation instead of silently falling back to no cuts.
        if exc.__class__.__name__ == "JobCancelled" or "cancel" in str(exc).lower():
            raise
        return []


def analyze_segments(
    path: str | Path, target: float, progress: Progress | None = None
) -> list[tuple[float, float]]:
    duration, _, _, fps = metadata(path)
    if duration <= 0:
        raise RuntimeError("source has no readable duration")
    if progress:
        progress("analyzing", 5)
    scene = _scene_points(path, duration, fps, progress)
    if progress:
        progress("analyzing", 20)
    silence = detect_silence(path)
    if progress:
        progress("analyzing", 30)
    # Candidate boundaries prefer meaningful scene cuts and silence edges.
    boundaries = sorted(
        {
            0.0,
            duration,
            *[round(x, 2) for x in scene],
            *[round(x, 2) for pair in silence for x in pair],
        }
    )
    starts = [0.0]
    t = 0.0
    while t < duration - 0.05:
        desired = min(t + target, duration)
        choices = [
            x
            for x in boundaries
            if t + max(4, target * 0.65) <= x <= min(duration, desired + target * 0.35)
        ]
        cut = min(choices, key=lambda x: abs(x - desired)) if choices else desired
        if cut <= t + 0.5:
            cut = min(duration, t + target)
        starts.append(cut)
        t = cut
    segments = [
        (starts[i], starts[i + 1])
        for i in range(len(starts) - 1)
        if starts[i + 1] - starts[i] >= 1
    ]
    if progress:
        progress("analyzing", 35)
    return segments or [(0.0, duration)]


def _select_face_x(
    faces, width: int, previous: float | None, subject: str = "auto"
) -> float | None:
    """Choose a face center while keeping a stable association between frames."""
    if subject not in {"auto", "left", "right"}:
        subject = "auto"
    boxes = list(faces) if faces is not None else []
    if not boxes or width <= 0:
        return None
    centers = [((x + w / 2) / width, w * h) for x, _y, w, h in boxes]
    if subject == "left":
        return min(centers, key=lambda item: item[0])[0]
    if subject == "right":
        return max(centers, key=lambda item: item[0])[0]
    if previous is not None:
        # Prefer continuity over face area after the first detection. This
        # prevents two speakers from swapping the crop on alternating frames.
        return min(centers, key=lambda item: abs(item[0] - previous))[0]
    return max(centers, key=lambda item: item[1])[0]


def _face_zoom_target(
    box_height: float,
    sample_height: float,
    crop_height: float,
    source_height: float,
    ceiling: float,
) -> float:
    """Return a bounded zoom that makes a face about 30% of the crop height."""
    try:
        box = float(box_height)
        sample = float(sample_height)
        crop = float(crop_height)
        source = float(source_height)
        limit = float(ceiling)
    except (TypeError, ValueError):
        return 1.0
    if not all(math.isfinite(value) and value > 0 for value in (box, sample, crop, source)):
        return 1.0
    desired = 0.30 * (crop / source) / (box / sample)
    return max(1.0, min(1.5, limit, desired))


def track_focus(
    path: str | Path, start: float, end: float, subject: str = "auto"
) -> tuple[float, float]:
    """Return a smoothed normalized focus point from face detection, motion fallback."""
    try:
        import cv2  # type: ignore

        cap = cv2.VideoCapture(str(path))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
        cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        xs, ys = [], []
        last_candidate = None
        for _ in range(max(1, min(12, int((end - start) * 2)))):
            _check_cancel()
            ok, frame = cap.read()
            if not ok:
                break
            # Face/motion analysis never needs source resolution. A 320px-wide
            # sample keeps long 1080p imports responsive and bounded in memory.
            sample_w = min(320, frame.shape[1])
            small = cv2.resize(
                frame,
                (sample_w, max(1, int(frame.shape[0] * sample_w / frame.shape[1]))),
                interpolation=cv2.INTER_AREA,
            )
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            candidate = last_candidate
            if _ % 3 == 0:
                faces = cascade.detectMultiScale(gray, 1.1, 4)
                candidate = None
                if len(faces):
                    previous_x = last_candidate[0] if last_candidate else None
                    face_x = _select_face_x(
                        faces, small.shape[1], previous_x, subject
                    )
                    selected = min(
                        faces,
                        key=lambda b: abs((b[0] + b[2] / 2) / small.shape[1] - face_x),
                    ) if face_x is not None else None
                    if selected is not None:
                        x, y, w, h = selected
                        candidate = (
                            (x + w / 2) / small.shape[1],
                            (y + h / 2) / small.shape[0],
                        )
                else:
                    # Motion centroid fallback over a blurred frame is deterministic and subject-agnostic.
                    blur = cv2.GaussianBlur(gray, (9, 9), 0)
                    _, th = cv2.threshold(
                        blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
                    )
                    moments = cv2.moments(th)
                    if moments["m00"]:
                        candidate = (
                            (moments["m10"] / moments["m00"]) / small.shape[1],
                            (moments["m01"] / moments["m00"]) / small.shape[0],
                        )
                last_candidate = candidate
            if candidate:
                xs.append(candidate[0])
                ys.append(candidate[1])
        cap.release()
        if xs:
            return (
                max(0.15, min(0.85, sum(xs) / len(xs))),
                max(0.2, min(0.8, sum(ys) / len(ys))),
            )
    except Exception as exc:
        if exc.__class__.__name__ == "JobCancelled" or "cancel" in str(exc).lower():
            raise
        pass
    return 0.5, 0.5


ASPECT_RATIOS = {
    "9:16": (9, 16),
    "1:1": (1, 1),
    "4:5": (4, 5),
    "16:9": (16, 9),
}


def _sample_clip_frames(
    source: str | Path, start: float, end: float, *, limit: int = 6
) -> list[object]:
    """Read a bounded set of frames for an explicitly selected remote provider."""

    import cv2  # type: ignore

    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        return []
    count = max(1, min(int(limit), 6))
    frames: list[object] = []
    try:
        for index in range(count):
            fraction = index / max(1, count - 1)
            cap.set(cv2.CAP_PROP_POS_MSEC, (start + (end - start) * fraction) * 1000.0)
            ok, frame = cap.read()
            if ok and frame is not None:
                frames.append(frame)
    finally:
        cap.release()
    return frames


def _gemini_clip_plans(
    source: str | Path, start: float, end: float, progress: Progress | None = None
):
    frames = _sample_clip_frames(source, start, end, limit=6)
    if not frames:
        raise RuntimeError("Could not sample source frames for Gemini framing.")
    return gemini_vision_plans(frames, progress=progress)


def _nearest_remote_plan(plans, frame_index: int, frame_count: int):
    if not plans:
        return None
    max_index = max(int(plan.index) for plan in plans)
    sample_index = round((frame_index / max(1, frame_count - 1)) * max_index)
    return min(plans, key=lambda plan: abs(int(plan.index) - sample_index))


def aspect_dimensions(clip: dict) -> tuple[int, int]:
    """Return an even output size while keeping resolution as the width."""
    width = int(clip.get("resolution") or 720)
    ratio = str(clip.get("aspect_ratio") or "9:16")
    numerator, denominator = ASPECT_RATIOS.get(ratio, ASPECT_RATIOS["9:16"])
    height = int(round(width * denominator / numerator))
    return width, height + (height % 2)


def render_clip(
    source: str | Path,
    clip: dict,
    out: str | Path,
    srt: str | None = None,
    progress: Progress | None = None,
) -> None:
    start, end = max(0, float(clip["start"])), float(clip["end"])
    duration = max(0.2, end - start)
    width, height = aspect_dimensions(clip)
    framing = clip.get("framing", "follow")
    aspect = width / height
    vf = [
        f"scale={width}:{height}:force_original_aspect_ratio=decrease",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black",
        "format=yuv420p",
    ]
    # Follow uses an OpenCV frame pass below so face/motion tracking really moves the crop.
    if framing == "fit":
        vf = [
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black",
            "format=yuv420p",
        ]
    elif framing == "manual":
        fx = max(0.05, min(0.95, float(clip.get("focus_x", 0.5))))
        _, source_width, source_height, _ = metadata(source)
        source_aspect = source_width / max(1, source_height)
        if source_aspect >= aspect:
            crop_width, crop_height = f"ih*{aspect:.8f}", "ih"
        else:
            crop_width, crop_height = "iw", f"iw/{aspect:.8f}"
        vf = [
            f"crop={crop_width}:{crop_height}:(iw-ow)*{fx}:(ih-oh)/2",
            f"scale={width}:{height}",
            "format=yuv420p",
        ]
    if framing == "follow":
        _render_follow_cv2(source, clip, out, width, height, progress)
        _burn_caption(out, clip, srt)
        _postprocess_effects(out, clip, progress)
        return
    # Manual camera paths use the same pixel cropper, but explicitly disable face
    # and motion detection.  This keeps authored keyframes deterministic while
    # retaining the historical static manual crop when no camera path is present.
    try:
        manual_zoom = float(clip.get("camera_zoom", 1.0))
    except (TypeError, ValueError):
        manual_zoom = 1.0
    if framing == "manual" and (
        bool(clip.get("camera_keyframes")) or abs(manual_zoom - 1.0) > 1e-9
    ):
        _render_follow_cv2(
            source,
            clip,
            out,
            width,
            height,
            progress,
            auto_tracking=False,
        )
        _burn_caption(out, clip, srt)
        _postprocess_effects(out, clip, progress)
        return
    caption_file = _caption_ass(out, clip, srt)
    filter_complex = None
    video_map = "0:v:0"
    if framing == "blur":
        caption_path = _filter_path(caption_file) if caption_file else None
        filter_complex = (
            f"[0:v]split=2[bg][fg];"
            f"[bg]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},boxblur=20:10[bgf];"
            f"[fg]scale={width}:{height}:force_original_aspect_ratio=decrease[fgf];"
            f"[bgf][fgf]overlay=(W-w)/2:(H-h)/2[v0]"
        )
        if caption_path:
            filter_complex += f";[v0]ass={caption_path}:fontsdir={_filter_path(fonts_directory())}[v]"
            video_map = "[v]"
        else:
            video_map = "[v0]"
    else:
        if caption_file:
            vf.append(f"ass={_filter_path(caption_file)}:fontsdir={_filter_path(fonts_directory())}")
    args = [
        FFMPEG,
        "-y",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(source),
        "-t",
        f"{duration:.3f}",
        "-map",
        "0:a?",
        ("-filter_complex" if filter_complex else "-vf"),
        (filter_complex if filter_complex else ",".join(vf)),
        "-r",
        "30",
        "-map",
        video_map,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(out),
    ]
    try:
        try:
            run(args, timeout=max(300, int(duration * 20)))
        except subprocess.CalledProcessError as e:
            raise RuntimeError((e.stderr or "ffmpeg render failed")[-1200:]) from e
        if progress:
            progress("rendering", 85)
    finally:
        if caption_file:
            caption_file.unlink(missing_ok=True)
    _postprocess_effects(out, clip, progress)


def _postprocess_effects(
    out: str | Path, clip: dict, progress: Progress | None = None
) -> None:
    """Apply speed and audio controls after captions have become video pixels.

    Applying ``setpts`` after the ASS pass keeps caption timing coupled to the
    picture. ``atempo`` preserves pitch while changing playback duration; the
    supported UI range fits in one FFmpeg ``atempo`` stage.
    """
    speed = _playback_speed(clip)
    volume = _audio_volume(clip)
    denoise = bool(clip.get("audio_denoise", False))
    fade = _audio_fade(clip)
    if speed == 1.0 and volume == 1.0 and not denoise and fade == 0.0:
        return
    source = Path(out)
    # Probe the captioned output, since the actual stream duration can differ
    # slightly from the requested clip duration after frame-rate conversion.
    output_duration = max(0.01, float(metadata(source)[0] or 0.01) / speed)
    fade = min(fade, output_duration / 2.0)
    audio_filters = [f"atempo={speed:.6f}", f"volume={volume:.6f}"]
    if denoise:
        audio_filters.append("afftdn")
    if fade > 0:
        audio_filters.extend(
            [
                f"afade=t=in:st=0:d={fade:.6f}",
                f"afade=t=out:st={max(0.0, output_duration - fade):.6f}:d={fade:.6f}",
            ]
        )
    temp = source.with_suffix(".effects.mp4")
    temp.unlink(missing_ok=True)
    args = [
        FFMPEG,
        "-y",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        f"setpts=PTS/{speed:.6f}",
        "-af",
        ",".join(audio_filters),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(temp),
    ]
    try:
        try:
            run(args, timeout=max(300, int(output_duration * 20)))
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(
                (exc.stderr or "audio/video effects failed")[-1200:]
            ) from exc
        os.replace(temp, source)
        if progress:
            progress("rendering", 92)
    finally:
        temp.unlink(missing_ok=True)


def _filter_path(path: str | Path) -> str:
    """Escape a Windows or POSIX path for an ffmpeg filter argument."""
    escaped = str(path).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
    # The quotes are part of libavfilter syntax; without them Windows' drive
    # colon is parsed as a filter option separator.
    return f"'{escaped}'"


def _caption_ass(out: str | Path, clip: dict, srt: str | None = None) -> Path | None:
    if not clip.get("caption_enabled", True):
        return None
    text = str(clip.get("caption_text", "")).strip()
    if not text and not srt:
        return None
    path = Path(out).with_suffix(".caption.ass")
    # ASS uses BBGGRR colors; preserve the UI hex color exactly in the rendered caption.
    color = str(clip.get("caption_color", "#d6fb78")).lstrip("#")
    if len(color) != 6 or any(c not in "0123456789abcdefABCDEF" for c in color):
        color = "d6fb78"
    bgr = color[4:6] + color[2:4] + color[0:2]
    style = str(clip.get("caption_style", "clean"))
    fontsize, bold, outline = {
        "bold": (64, 1, 3),
        "minimal": (46, 0, 1),
        "clean": (52, 0, 2),
    }.get(style, (52, 0, 2))
    fontsize = max(32, min(90, float(clip.get("caption_size", fontsize))))
    family = font_name(str(clip.get("caption_font", "outfit")), text or str(srt or ""))
    canvas_width = 720
    _, canvas_height = aspect_dimensions(
        {"resolution": canvas_width, "aspect_ratio": clip.get("aspect_ratio", "9:16")}
    )
    font_width_scale = round(canvas_width / 720 * 100)
    alignment = 5 if clip.get("caption_position") == "center" else 2
    margin_v = 72

    def ass_text(value: str) -> str:
        return (
            value.replace("\\", "\\\\")
            .replace("{", r"\{")
            .replace("}", r"\}")
            .replace("\r\n", r"\N")
            .replace("\n", r"\N")
        )

    def ass_time(value: str) -> str:
        value = value.replace(",", ".")
        parts = value.split(":")
        if len(parts) != 3:
            return "0:00:00.00"
        return f"{int(parts[0])}:{int(parts[1]):02d}:{float(parts[2]):05.2f}"

    events = []
    if text:
        events = [("0:00:00.00", "9:59:59.00", ass_text(text))]
    elif srt:
        srt_text = srt
        try:
            possible_path = Path(srt)
            if possible_path.exists():
                srt_text = possible_path.read_text(encoding="utf-8")
        except (OSError, ValueError):
            pass
        blocks = re.findall(
            r"\d+\s*\n(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|\Z)",
            srt_text,
        )
        def seconds(value):
            h, m, sec = value.replace(",", ".").split(":")
            return int(h) * 3600 + int(m) * 60 + float(sec)

        def timestamp(value):
            return f"{int(value // 3600)}:{int(value // 60) % 60:02d}:{value % 60:05.2f}"

        events = [(timestamp(a), timestamp(b), ass_text(t))
                  for start, end, line in blocks
                  for a, b, t in caption_cues(seconds(start), seconds(end), line)]
    if not events:
        return None
    # Normalized editor coordinates map to the selected aspect canvas while
    # keeping the established 720px caption width and font scale.
    position = ""
    if "caption_x" in clip or "caption_y" in clip:
        x = round(max(0.05, min(0.95, float(clip.get("caption_x", 0.5)))) * canvas_width)
        y = round(max(0.05, min(0.95, float(clip.get("caption_y", 0.86)))) * canvas_height)
        position = f"{{\\an5\\pos({x},{y})}}"
    # ASS is self-contained and avoids shell quoting or shell command interpolation.
    path.write_text(
        f"[Script Info]\nScriptType: v4.00+\nPlayResX: {canvas_width}\nPlayResY: {canvas_height}\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Clip,{family},{fontsize},&H00{bgr},&H00{bgr},&H000000,&H99000000,{bold},0,0,0,{font_width_scale},100,0,0,1,{outline},1,{alignment},42,42,{margin_v},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        + "".join(
            f"Dialogue: 0,{a},{b},Clip,,0,0,0,,{position}{t}\n" for a, b, t in events
        ),
        encoding="utf-8",
    )
    return path


def _burn_caption(out: str | Path, clip: dict, srt: str | None = None) -> None:
    caption_file = _caption_ass(out, clip, srt)
    if not caption_file:
        return
    src = Path(out)
    temp = src.with_suffix(".caption.mp4")
    try:
        try:
            run(
                [
                    FFMPEG,
                    "-y",
                    "-i",
                    str(src),
                    "-vf",
                    f"ass={_filter_path(caption_file)}:fontsdir={_filter_path(fonts_directory())}",
                    "-map",
                    "0:v:0",
                    "-map",
                    "0:a?",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-c:a",
                    "copy",
                    "-movflags",
                    "+faststart",
                    str(temp),
                ],
                600,
            )
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(
                (exc.stderr or "caption burn-in failed")[-1200:]
            ) from exc
        os.replace(temp, src)
    finally:
        temp.unlink(missing_ok=True)
        caption_file.unlink(missing_ok=True)


def _render_follow_cv2(
    source: str | Path,
    clip: dict,
    out: str | Path,
    width: int,
    height: int,
    progress: Progress | None = None,
    *,
    auto_tracking: bool = True,
) -> None:
    """Track a face or salient subject and render a stable, zoomable camera path.

    Detection is intentionally conservative.  The camera controller in ``camera.py``
    owns continuity, dead-zone, acceleration, and scene-cut behavior; this function
    only translates detector boxes and frames into pixels.
    """
    import cv2  # type: ignore

    start, end = max(0.0, float(clip["start"])), float(clip["end"])
    # Stream CFR frames at source resolution. The detector is downsampled
    # separately; full-resolution pixels are retained for the final crop.
    _, sw, sh, _ = metadata(source)
    sw, sh = int(sw), int(sh)
    if sw < 2 or sh < 2:
        raise RuntimeError("source has no video frames")
    target_aspect = width / max(1, height)
    if sw / sh >= target_aspect:
        crop_w = min(sw, max(2, int(sh * target_aspect)))
        crop_h = sh
    else:
        crop_w = sw
        crop_h = min(sh, max(2, int(sw / target_aspect)))
    # Landscape material uses a 9:16 crop; for a narrow source use the largest safe crop.
    crop_w, crop_h = min(crop_w, sw), min(crop_h, sh)
    process = subprocess.Popen(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(source),
            "-t",
            f"{end-start:.3f}",
            "-vf",
            "fps=30",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    temp = Path(out).with_suffix(".tracking.mp4")
    writer = cv2.VideoWriter(
        str(temp), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, (width, height)
    )
    if not writer.isOpened():
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
        temp.unlink(missing_ok=True)
        raise RuntimeError("could not create tracking video")
    haar_root = getattr(getattr(cv2, "data", None), "haarcascades", "")
    # OpenCV builds that omit the legacy cascade API still get the motion-centroid fallback.
    cascade = (
        cv2.CascadeClassifier(
            os.path.join(haar_root, "haarcascade_frontalface_default.xml")
        )
        if auto_tracking and haar_root and hasattr(cv2, "CascadeClassifier")
        else None
    )
    settings = camera_settings(clip)
    camera = CameraController(
        motion=str(settings["motion"]),
        zoom=float(settings["zoom"]),
        dead_zone=float(settings["dead_zone"]),
        initial=CameraPoint(
            max(0.0, min(1.0, float(clip.get("focus_x", 0.5)))),
            max(0.0, min(1.0, float(clip.get("focus_y", 0.5)))),
            float(settings["zoom"]),
        ),
    )
    keyframes = settings["keyframes"]
    auto_zoom = bool(settings.get("auto_zoom", False))
    auto_zoom_target = float(settings["zoom"])
    strategy = str(settings.get("strategy", "adaptive"))
    # Explicit keyframes are an authored camera path.  Adaptive safety is still
    # available for ordinary follow clips, but never silently overrides a path the
    # user authored frame by frame.
    adaptive_safety = strategy == "adaptive" and not keyframes and auto_tracking
    # Once adaptive analysis sees distributed content, keep the full-frame mode for
    # this clip. Switching back to a crop on a later detector pass could lose a
    # diagram label during a transient low-edge frame.
    safe_mode: str | None = None
    safe_zoom_cap = float(settings["zoom"])
    last_face_boxes: list[tuple[int, int, int, int]] = []
    remote_plans = ()
    if str(settings.get("vision_provider", "local")) == "gemini" and auto_tracking:
        try:
            remote_plans = _gemini_clip_plans(source, start, end, progress)
            if any(plan.protect_full_frame for plan in remote_plans):
                selected = next(
                    (plan.mode for plan in remote_plans if plan.protect_full_frame and plan.mode in {"fit", "blur"}),
                    str(settings.get("safe_framing", "fit")),
                )
                safe_mode = selected
        except Exception as exc:
            # A failed remote analysis must never make an export fail or turn into
            # an unsafe crop. Local OpenCV safety continues and the progress reason
            # is visible to the job UI.
            remote_plans = ()
            if progress:
                progress("vision fallback", 45)
    frames = max(1, int((end - start) * 30))
    i = 0
    frame_bytes = sw * sh * 3
    last_target: TrackedTarget | None = None
    detector_misses = 0
    previous_gray = None
    frame_failed = False
    try:
        try:
            while i < frames:
                _check_cancel()
                if not process.stdout:
                    break
                chunks = []
                remaining = frame_bytes
                while remaining:
                    chunk = process.stdout.read(remaining)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    remaining -= len(chunk)
                if remaining:
                    break
                import numpy as np  # type: ignore

                frame = np.frombuffer(b"".join(chunks), dtype=np.uint8).reshape(
                    (sh, sw, 3)
                )
                sample_w = min(320, sw)
                small = cv2.resize(
                    frame,
                    (sample_w, max(1, int(sh * sample_w / sw))),
                    interpolation=cv2.INTER_AREA,
                )
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                remote_plan = _nearest_remote_plan(remote_plans, i, frames)
                remote_boxes = [
                    (
                        int(round(x * sample_w)),
                        int(round(y * small.shape[0])),
                        int(round(w * sample_w)),
                        int(round(h * small.shape[0])),
                    )
                    for x, y, w, h in (remote_plan.faces if remote_plan else ())
                ]
                if remote_plan and remote_plan.protect_full_frame and remote_plan.mode in {"fit", "blur"}:
                    safe_mode = remote_plan.mode
                remote_candidate = choose_target(
                    remote_boxes,
                    small.shape[1],
                    small.shape[0],
                    last_target,
                    str(clip.get("subject", "auto")),
                ) if remote_boxes else None
                candidate = remote_candidate or last_target
                scene_cut = False
                prior_gray = previous_gray if auto_tracking else None
                if auto_tracking and prior_gray is not None:
                    scene_delta = float(
                        cv2.absdiff(prior_gray, gray).mean()
                    )
                    # A hard cut should immediately release the previous identity.
                    # The threshold is deliberately high enough to ignore ordinary
                    # movement and low-light noise.
                    scene_cut = i > 2 and scene_delta >= 48.0
                    if scene_cut:
                        # Do not carry the previous subject through a cut on
                        # frames where detection is throttled (every third
                        # frame).  Otherwise the camera reset immediately
                        # snaps back toward the old scene's subject.
                        last_target = None
                        candidate = None
                        auto_zoom_target = float(settings["zoom"])
                if auto_tracking:
                    previous_gray = gray
                if auto_tracking and i % 3 == 0:
                    faces = (
                        cascade.detectMultiScale(gray, 1.1, 4)
                        if cascade is not None and not cascade.empty()
                        else []
                    )
                    # Convert detector sample boxes to source pixels before using
                    # them for viewport safety.  A single face may be followed, but
                    # the crop must leave enough room for every detected face.
                    local_face_boxes = [
                        (
                            int(round(x * sw / max(1, sample_w))),
                            int(round(y * sh / max(1, small.shape[0]))),
                            int(round(w * sw / max(1, sample_w))),
                            int(round(h * sh / max(1, small.shape[0]))),
                        )
                        for x, y, w, h in faces
                    ]
                    last_face_boxes = local_face_boxes or [
                        (
                            int(round(x * sw / max(1, sample_w))),
                            int(round(y * sh / max(1, small.shape[0]))),
                            int(round(w * sw / max(1, sample_w))),
                            int(round(h * sh / max(1, small.shape[0]))),
                        )
                        for x, y, w, h in remote_boxes
                    ]
                    if last_face_boxes:
                        safe_zoom_cap = safe_zoom_for_boxes(
                            last_face_boxes,
                            sw,
                            sh,
                            crop_w,
                            crop_h,
                            float(settings["zoom"]),
                        )
                    else:
                        safe_zoom_cap = float(settings["zoom"])
                    if adaptive_safety and len(faces) == 0 and not remote_boxes and safe_mode is None:
                        signals = analyze_frame(small)
                        if signals.distributed_content:
                            safe_mode = str(settings.get("safe_framing", "fit"))
                    face_target = None
                    candidate = choose_target(
                        faces,
                        small.shape[1],
                        small.shape[0],
                        last_target,
                        str(clip.get("subject", "auto")),
                    ) if len(faces) else remote_candidate
                    face_target = candidate
                    # Motion is only considered when no face is available.  It uses
                    # frame difference and connected components, avoiding the old
                    # whole-frame threshold that often chased a bright wall.
                    if candidate is None and prior_gray is not None:
                        diff = cv2.absdiff(prior_gray, gray)
                        _, motion_mask = cv2.threshold(diff, 22, 255, cv2.THRESH_BINARY)
                        motion_mask = cv2.morphologyEx(
                            motion_mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
                        )
                        contours, _ = cv2.findContours(
                            motion_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                        )
                        boxes = []
                        image_area = float(max(1, small.shape[0] * small.shape[1]))
                        for contour in contours:
                            x, y, w, h = cv2.boundingRect(contour)
                            area = (w * h) / image_area
                            if 0.003 <= area <= 0.65:
                                boxes.append((x, y, w, h))
                        candidate = choose_target(
                            boxes,
                            small.shape[1],
                            small.shape[0],
                            last_target,
                            str(clip.get("subject", "auto")),
                        )
                    if auto_zoom:
                        if face_target is not None and face_target.box:
                            face_height = max(1.0, float(face_target.box[3]))
                            sample_height = max(1.0, float(small.shape[0]))
                            # Size the detected face to roughly 30% of the
                            # output crop.  Detector boxes are sample-sized,
                            # so use their normalized height and the crop's
                            # source-height fraction before applying the
                            # user's zoom ceiling.
                            auto_zoom_target = _face_zoom_target(
                                face_height,
                                sample_height,
                                crop_h,
                                sh,
                                float(settings["zoom"]),
                            )
                        else:
                            # Motion fallback and detector misses have no
                            # reliable subject size; never infer a punch-in
                            # from arbitrary changed pixels.
                            auto_zoom_target = 1.0
                    if candidate is not None:
                        last_target = candidate
                        detector_misses = 0
                    else:
                        detector_misses += 1
                        if detector_misses > 18:
                            last_target = None
                    # A cut starts a fresh association even when no detector target
                    # exists in the first frame of the new scene.
                    if scene_cut:
                        last_target = candidate
                point = interpolate_keyframes(start + i / 30.0, keyframes)
                if point is None:
                    point = camera.update(
                        last_target,
                        1.0 / 30.0,
                        scene_cut=scene_cut,
                        target_zoom=(
                            min(
                                auto_zoom_target if auto_zoom else float(settings["zoom"]),
                                safe_zoom_cap,
                            )
                            if last_face_boxes and strategy != "manual"
                            else (auto_zoom_target if auto_zoom else float(settings["zoom"]))
                        ),
                    )
                else:
                    # Manual keyframes are authored camera positions.  Interpolation
                    # is deterministic and must not be changed by detector smoothing.
                    camera.point = point.bounded()
                    camera._velocity[:] = [0.0, 0.0, 0.0]
                zoom = max(1.0, min(1.5, float(point.zoom)))
                if last_face_boxes and strategy != "manual":
                    # Apply the cap at the pixel boundary too; controller velocity
                    # smoothing must never produce a transient face cut.
                    zoom = min(zoom, safe_zoom_cap)
                current_crop_w = max(2, min(sw, int(round(crop_w / zoom))))
                current_crop_h = max(2, min(sh, int(round(crop_h / zoom))))
                cx = int(max(current_crop_w / 2, min(sw - current_crop_w / 2, point.x * sw)))
                cy = int(max(current_crop_h / 2, min(sh - current_crop_h / 2, point.y * sh)))
                x0 = int(cx - current_crop_w / 2)
                y0 = int(cy - current_crop_h / 2)
                # A zoom cap can correctly bottom out at 1x while the union of
                # several subjects is still wider than the portrait crop. The final
                # pixel boundary is authoritative: adaptive framing must preserve
                # every reliable face, even if that means fitting the whole source.
                faces_need_full_frame = (
                    strategy == "adaptive"
                    and bool(last_face_boxes)
                    and not boxes_fit_viewport(
                        last_face_boxes,
                        x0,
                        y0,
                        current_crop_w,
                        current_crop_h,
                        margin=0.0,
                    )
                )
                frame_mode = safe_mode
                if faces_need_full_frame:
                    frame_mode = str(settings.get("safe_framing", "fit"))
                if frame_mode:
                    # Screen content has no compact subject to follow.  Preserve all
                    # source pixels even when the requested output is portrait.
                    writer.write(full_frame_view(frame, width, height, frame_mode))
                else:
                    cropped = frame[y0 : y0 + current_crop_h, x0 : x0 + current_crop_w]
                    writer.write(
                        cv2.resize(
                            cropped,
                            (width, height),
                            interpolation=cv2.INTER_AREA,
                        )
                    )
                i += 1
                if progress and i % 30 == 0:
                    progress("tracking", 45 + min(35, int(i / frames * 35)))
        except BaseException:
            frame_failed = True
            raise
    finally:
        writer.release()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=10)
        if frame_failed:
            temp.unlink(missing_ok=True)
    if i == 0:
        temp.unlink(missing_ok=True)
        raise RuntimeError("source frame decode failed")
    try:
        run(
            [
                FFMPEG,
                "-y",
                "-i",
                str(temp),
                "-ss",
                f"{start:.3f}",
                "-i",
                str(source),
                "-t",
                f"{end-start:.3f}",
                "-map",
                "0:v:0",
                "-map",
                "1:a?",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                str(out),
            ],
            max(300, int((end - start) * 20)),
        )
    finally:
        temp.unlink(missing_ok=True)
    if progress:
        progress("rendering", 85)


def make_zip(files: list[tuple[str, str]], out: str | Path) -> None:
    used: set[str] = set()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for file, name in files:
            safe = (
                re.sub(r"[^A-Za-z0-9._ -]+", "_", Path(name).name).strip(" .")
                or "clip.mp4"
            )
            stem, suffix = Path(safe).stem, Path(safe).suffix or ".mp4"
            candidate = safe
            index = 2
            while candidate.lower() in used:
                candidate = f"{stem}-{index}{suffix}"
                index += 1
            used.add(candidate.lower())
            z.write(file, candidate)


def make_demo(out: str | Path) -> None:
    # A self-authored 12-second landscape composition: moving geometric subject + tone audio.
    # Overlay's x/y expressions are evaluated per frame, creating a clearly
    # moving subject without relying on external media or a heavyweight encoder.
    run(
        [
            FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x111827:s=1280x720:r=30:d=12",
            "-f",
            "lavfi",
            "-i",
            "color=c=0xd6fb78:s=240x180:r=30:d=12",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x6ee7b7:s=120x120:r=30:d=12",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=12",
            "-filter_complex",
            "[0:v][1:v]overlay=x='520+350*sin(2*PI*t/12)':y='240+90*cos(2*PI*t/9)'[a];[a][2:v]overlay=x='700+100*cos(2*PI*t/5)':y=260[v]",
            "-map",
            "[v]",
            "-map",
            "3:a",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "-movflags",
            "+faststart",
            str(out),
        ],
        300,
    )
