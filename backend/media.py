from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Callable

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
        rows.append(
            (
                max(a, start) - start,
                min(b, end) - start,
                text,
            )
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
                "-skip_frame",
                "nokey",
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


def render_clip(
    source: str | Path,
    clip: dict,
    out: str | Path,
    srt: str | None = None,
    progress: Progress | None = None,
) -> None:
    start, end = max(0, float(clip["start"])), float(clip["end"])
    duration = max(0.2, end - start)
    width = int(clip.get("resolution") or 720)
    framing = clip.get("framing", "follow")
    vf = [
        f"scale={width}:-2:force_original_aspect_ratio=decrease",
        f"pad={width}:{int(width*16/9)}:(ow-iw)/2:(oh-ih)/2:black",
        "format=yuv420p",
    ]
    # Follow uses an OpenCV frame pass below so face/motion tracking really moves the crop.
    if framing == "fit":
        vf = [
            f"scale={width}:-2:force_original_aspect_ratio=decrease",
            f"pad={width}:{int(width*16/9)}:(ow-iw)/2:(oh-ih)/2:black",
            "format=yuv420p",
        ]
    elif framing == "manual":
        fx = max(0.05, min(0.95, float(clip.get("focus_x", 0.5))))
        # Crop to a 9:16 window in the original frame, then scale; clamp protects portrait sources.
        vf = [
            f"crop=ih*9/16:ih:(iw-ow)*{fx}:0",
            f"scale={width}:{int(width*16/9)}",
            "format=yuv420p",
        ]
    if framing == "follow":
        _render_follow_cv2(source, clip, out, width, progress)
        _burn_caption(out, clip, srt)
        _postprocess_effects(out, clip, progress)
        return
    caption_file = _caption_ass(out, clip, srt)
    if caption_file:
        vf.append(f"ass={_filter_path(caption_file)}")
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
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        ",".join(vf),
        "-r",
        "30",
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
        events = [
            (ass_time(a), ass_time(b), ass_text(t.strip()))
            for a, b, t in blocks
            if t.strip()
        ]
    if not events:
        return None
    # Normalized editor coordinates map to ASS's fixed 720x1280 canvas,
    # remaining identical at every export resolution. Legacy presets retain
    # their old placement until the clip is edited.
    position = ""
    if "caption_x" in clip or "caption_y" in clip:
        x = round(max(0.05, min(0.95, float(clip.get("caption_x", 0.5)))) * 720)
        y = round(max(0.05, min(0.95, float(clip.get("caption_y", 0.86)))) * 1280)
        position = f"{{\\an5\\pos({x},{y})}}"
    # ASS is self-contained and avoids shell quoting or shell command interpolation.
    path.write_text(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Clip,DejaVu Sans,{fontsize},&H00{bgr},&H00{bgr},&H000000,&H99000000,{bold},0,0,0,100,100,0,0,1,{outline},1,{alignment},42,42,{margin_v},1\n\n"
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
                    f"ass={_filter_path(caption_file)}",
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
    progress: Progress | None = None,
) -> None:
    """Track a face, then salient motion, while writing CFR frames and remuxing original audio."""
    import cv2  # type: ignore

    start, end = max(0.0, float(clip["start"])), float(clip["end"])
    # Stream CFR frames at source resolution. The detector is downsampled
    # separately; full-resolution pixels are retained for the final crop.
    _, sw, sh, _ = metadata(source)
    sw, sh = int(sw), int(sh)
    if sw < 2 or sh < 2:
        raise RuntimeError("source has no video frames")
    crop_w = min(sw, max(2, int(sh * 9 / 16)))
    crop_h = min(sh, max(2, int(sw * 16 / 9)))
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
        str(temp), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, (width, int(width * 16 / 9))
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
        if haar_root and hasattr(cv2, "CascadeClassifier")
        else None
    )
    focus = max(0.0, min(1.0, float(clip.get("focus_x", 0.5))))
    smooth = max(0.0, min(0.8, float(clip.get("smoothing", 0.15))))
    frames = max(1, int((end - start) * 30))
    i = 0
    frame_bytes = sw * sh * 3
    last_candidate = None
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
                candidate = last_candidate
                if i % 3 == 0:
                    faces = (
                        cascade.detectMultiScale(gray, 1.1, 4)
                        if cascade is not None and not cascade.empty()
                        else []
                    )
                    candidate = None
                    if len(faces):
                        candidate = _select_face_x(
                            faces,
                            small.shape[1],
                            last_candidate,
                            str(clip.get("subject", "auto")),
                        )
                    if candidate is None:
                        blur = cv2.GaussianBlur(gray, (11, 11), 0)
                        _, th = cv2.threshold(
                            blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
                        )
                        moments = cv2.moments(th)
                        if moments["m00"]:
                            candidate = (moments["m10"] / moments["m00"]) / small.shape[
                                1
                            ]
                    last_candidate = candidate
                if candidate is not None:
                    focus = (
                        float(candidate)
                        if smooth == 0
                        else focus * (1 - smooth) + float(candidate) * smooth
                    )
                cx = int(max(crop_w / 2, min(sw - crop_w / 2, focus * sw)))
                x0, y0 = int(cx - crop_w / 2), int(max(0, (sh - crop_h) / 2))
                cropped = frame[y0 : y0 + crop_h, x0 : x0 + crop_w]
                writer.write(
                    cv2.resize(
                        cropped,
                        (width, int(width * 16 / 9)),
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
