"""Editable handoff files for Premiere Pro and After Effects."""

from __future__ import annotations

import json
import math
import queue
import re
import threading
import zipfile
from fractions import Fraction
from pathlib import Path
from urllib.parse import quote
import xml.etree.ElementTree as ET

from .media import aspect_dimensions, srt_for_clip


_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _identifier(value: object, label: str) -> str:
    value = str(value or "")
    if not _ID.fullmatch(value):
        raise ValueError(f"invalid {label}")
    return value


def _positive(value: object, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) and number > 0 else default


def _caption_color(value: object) -> str:
    color = str(value or "")
    return color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "#ffffff"


def _frames(seconds: float, fps: Fraction) -> int:
    return max(0, round(seconds * float(fps)))


def _clip_frames(clip: dict, fps: Fraction) -> int:
    return max(1, _frames(clip["end"] - clip["start"], fps))


def _node(parent: ET.Element, name: str, text: object | None = None, **attributes) -> ET.Element:
    child = ET.SubElement(parent, name, {key: str(value) for key, value in attributes.items()})
    if text is not None:
        child.text = str(text)
    return child


def _rate(parent: ET.Element, fps: Fraction) -> None:
    rate = _node(parent, "rate")
    nominal = int(math.floor(float(fps) + 0.5))
    _node(rate, "timebase", nominal)
    _node(rate, "ntsc", "TRUE" if abs(float(fps) - nominal) > 0.001 else "FALSE")


def _write_source_file(
    clip_item: ET.Element,
    *,
    index: int,
    media_type: str,
    project: dict,
    media_name: str,
    fps: Fraction,
    has_audio: bool,
) -> None:
    file_node = _node(clip_item, "file", id="file-1")
    if index != 1 or media_type != "video":
        return

    _node(file_node, "name", media_name)
    _node(file_node, "pathurl", "file://localhost/media/" + quote(media_name))
    file_rate = _node(file_node, "rate")
    nominal_rate = int(math.floor(float(fps) + 0.5))
    _node(file_rate, "timebase", nominal_rate)
    is_ntsc = abs(float(fps) - round(float(fps))) > 0.001
    _node(file_rate, "ntsc", "TRUE" if is_ntsc else "FALSE")

    source_duration = _frames(float(project.get("duration") or 0), fps)
    _node(file_node, "duration", source_duration)
    file_media = _node(file_node, "media")
    file_video = _node(file_media, "video")
    file_video_format = _node(file_video, "samplecharacteristics")
    _rate(file_video_format, fps)
    source_width = max(1, int(project.get("width") or 1920))
    source_height = max(1, int(project.get("height") or 1080))
    _node(file_video_format, "width", source_width)
    _node(file_video_format, "height", source_height)

    if has_audio:
        file_audio = _node(file_media, "audio")
        _node(file_audio, "channelcount", 2)


def _write_clip_item(
    track: ET.Element,
    clip: dict,
    *,
    index: int,
    media_type: str,
    timeline_frame: int,
    project: dict,
    media_name: str,
    fps: Fraction,
    has_audio: bool,
) -> None:
    source_in = _frames(clip["start"], fps)
    source_duration = _clip_frames(clip, fps)
    timeline_end = timeline_frame + source_duration

    item = _node(track, "clipitem", id=f"clipitem-{media_type}-{index}")
    _node(item, "name", str(clip["title"]))
    _rate(item, fps)
    _node(item, "enabled", "TRUE")
    _node(item, "duration", source_duration)
    _node(item, "start", timeline_frame)
    _node(item, "end", timeline_end)
    _node(item, "in", source_in)
    _node(item, "out", source_in + source_duration)
    _write_source_file(
        item,
        index=index,
        media_type=media_type,
        project=project,
        media_name=media_name,
        fps=fps,
        has_audio=has_audio,
    )

    source_track = _node(item, "sourcetrack")
    _node(source_track, "mediatype", media_type)
    if media_type == "audio":
        _node(source_track, "trackindex", 1)
    _node(item, "logginginfo")


def _xml(project: dict, clips: list[dict], media_name: str, fps: Fraction, has_audio: bool) -> bytes:
    root = ET.Element("xmeml", version="5")
    sequence = _node(root, "sequence")
    _node(sequence, "name", str(project.get("title") or "Clipflow handoff"))
    _node(sequence, "duration", sum(_frames(c["end"] - c["start"], fps) for c in clips))
    _rate(sequence, fps)
    media = _node(sequence, "media")
    video = _node(media, "video")
    format_node = _node(video, "format")
    sample = _node(format_node, "samplecharacteristics")
    _rate(sample, fps)
    _node(sample, "width", clips[0]["width"])
    _node(sample, "height", clips[0]["height"])
    video_track = _node(video, "track")
    audio_track = None
    if has_audio:
        audio_track = _node(_node(media, "audio"), "track")
    timeline_frame = 0
    for index, clip in enumerate(clips, 1):
        tracks = [(video_track, "video")]
        if audio_track is not None:
            tracks.append((audio_track, "audio"))
        for track, media_type in tracks:
            _write_clip_item(
                track,
                clip,
                index=index,
                media_type=media_type,
                timeline_frame=timeline_frame,
                project=project,
                media_name=media_name,
                fps=fps,
                has_audio=has_audio,
            )
        # Audio and video items share the same timeline interval.
        timeline_frame += _clip_frames(clip, fps)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _parse_srt_time(value: str) -> float:
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(",")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def _format_srt_time(seconds: float) -> str:
    millis = max(0, round(seconds * 1000))
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def _sequence_srt(clips: list[dict], project: dict) -> str:
    rows: list[tuple[float, float, str]] = []
    offset = 0.0
    transcript = project.get("transcript", [])
    for clip in clips:
        source_transcript = clip.get("transcript", transcript)
        srt = srt_for_clip(clip, source_transcript, for_render=True)
        blocks = re.split(r"\n\s*\n", srt.strip()) if srt.strip() else []
        for block in blocks:
            lines = block.splitlines()
            if len(lines) < 3 or " --> " not in lines[1]:
                continue
            first, last = lines[1].split(" --> ", 1)
            start = offset + _parse_srt_time(first)
            end = offset + _parse_srt_time(last)
            rows.append((start, end, "\n".join(lines[2:])))
        offset += float(clip["end"]) - float(clip["start"])
    formatted_rows = [
        f"{index}\n{_format_srt_time(start)} --> {_format_srt_time(end)}\n{text}"
        for index, (start, end, text) in enumerate(rows, 1)
    ]
    return "\n\n".join(formatted_rows) + ("\n" if rows else "")


def _jsx(project_title: str, clips: list[dict], media_name: str) -> str:
    payload = json.dumps({"title": project_title, "media": media_name, "clips": clips}, ensure_ascii=True)
    return """(function () {
    var data = """ + payload + """;
    var scriptFile = new File($.fileName);
    var mediaFile = new File(scriptFile.parent.fsName + "/media/" + data.media);
    if (!mediaFile.exists) { alert("Clipflow media file is missing. Extract the full handoff ZIP first."); return; }
    app.beginUndoGroup("Clipflow Adobe handoff");
    var project = app.newProject();
    if (!project) { app.endUndoGroup(); return; }
    var footage = project.importFile(new ImportOptions(mediaFile));
    var folder = project.items.addFolder(data.title + " clips");
    footage.parentFolder = folder;
    for (var i = 0; i < data.clips.length; i++) {
        var clip = data.clips[i];
        var duration = (clip.end - clip.start) / clip.speed;
        var comp = project.items.addComp(clip.title, clip.width, clip.height, 1, duration, clip.fps);
        comp.parentFolder = folder;
        var layer = comp.layers.add(footage);
        layer.name = clip.title + " source";
        layer.stretch = 100 / clip.speed;
        layer.startTime = -clip.start / clip.speed;
        layer.inPoint = 0;
        layer.outPoint = duration;
        for (var j = 0; j < clip.captions.length; j++) {
            var cue = clip.captions[j];
            var textLayer = comp.layers.addText(cue.text);
            textLayer.name = clip.title + " caption " + (j + 1);
            textLayer.startTime = cue.start;
            textLayer.inPoint = cue.start;
            textLayer.outPoint = Math.max(cue.start + 0.04, cue.end);
            var textProp = textLayer.property("Source Text");
            var doc = textProp.value;
            doc.fontSize = clip.captionSize;
            var color = cue.color.replace("#", "");
            doc.fillColor = [parseInt(color.substr(0, 2), 16) / 255, parseInt(color.substr(2, 2), 16) / 255, parseInt(color.substr(4, 2), 16) / 255];
            doc.justification = ParagraphJustification.CENTER_JUSTIFY;
            textProp.setValue(doc);
            textLayer.property("Position").setValue([clip.width * clip.captionX, clip.height * clip.captionY]);
        }
    }
    app.endUndoGroup();
    var saveFile = new File(scriptFile.parent.fsName + "/" + data.title.replace(/[\\\\/:*?\"<>|]/g, "_") + "_AfterEffects.aep");
    project.save(saveFile);
    alert("After Effects handoff saved next to the script. Save the extracted media folder with the AEP when moving the project.");
}());
"""


def _caption_cues(raw: dict, clip: dict, project: dict) -> list[dict]:
    color = clip["captionColor"]
    text = clip["caption"]
    if text:
        duration = (clip["end"] - clip["start"]) / clip["speed"]
        return [{"start": 0, "end": duration, "text": text, "color": color}]

    transcript = raw.get("transcript", project.get("transcript", []))
    srt = srt_for_clip(raw, transcript)
    if not srt.strip():
        return []

    cues = []
    for block in re.split(r"\n\s*\n", srt.strip()):
        lines = block.splitlines()
        if len(lines) < 3 or " --> " not in lines[1]:
            continue
        start_text, end_text = lines[1].split(" --> ", 1)
        cues.append({
            "start": _parse_srt_time(start_text),
            "end": _parse_srt_time(end_text),
            "text": "\n".join(lines[2:]),
            "color": color,
        })
    return cues


def prepare(project: dict, clips: list[dict], source: Path) -> tuple[list[dict], str, Fraction]:
    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError("source media not found")
    if not clips:
        raise ValueError("no clips selected")
    fps_value = _positive(project.get("fps"), 30)
    fps = Fraction(fps_value).limit_denominator(1001)
    clean: list[dict] = []
    seen = set()
    for index, raw in enumerate(clips, 1):
        if not isinstance(raw, dict):
            raise ValueError("clip metadata must be an object")
        clip_id = _identifier(raw.get("id"), "clip identifier")
        if clip_id in seen:
            raise ValueError("duplicate clip identifier")
        seen.add(clip_id)
        try:
            start, end = float(raw["start"]), float(raw["end"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("invalid clip timing") from None
        duration = float(project.get("duration") or end)
        invalid_timing = (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end <= start
            or end > duration + 0.05
        )
        if invalid_timing:
            raise ValueError("invalid clip timing")
        speed = _positive(raw.get("playback_speed"), 1)
        dimensions = aspect_dimensions({
            "resolution": raw.get("resolution") or 720,
            "aspect_ratio": raw.get("aspect_ratio") or "9:16",
        })
        caption_enabled = raw.get("caption_enabled", True)
        caption_text = str(raw.get("caption_text") or "") if caption_enabled else ""
        caption_color = _caption_color(raw.get("caption_color"))
        clean_clip = {
            "id": clip_id,
            "title": str(raw.get("title") or f"Clip {index}"),
            "start": start,
            "end": end,
            "speed": speed,
            "width": dimensions[0],
            "height": dimensions[1],
            "fps": float(fps),
            "caption": caption_text,
            "captionSize": max(1, int(raw.get("caption_size") or 52)),
            "captionColor": caption_color,
            "captionX": min(1, max(0, float(raw.get("caption_x", .5)))),
            "captionY": min(1, max(0, float(raw.get("caption_y", .86)))),
            "captions": [],
        }
        clean_clip["captions"] = _caption_cues(raw, clean_clip, project)
        clean.append(clean_clip)
    safe_name = source.name
    if safe_name in {"", ".", ".."} or "/" in safe_name or "\\" in safe_name:
        raise ValueError("invalid source media name")
    return clean, safe_name, fps


def _manifest(project: dict, clips: list[dict], media_name: str) -> dict:
    project_summary = {
        "id": str(project.get("id", "")),
        "title": str(project.get("title", "")),
        "duration": project.get("duration"),
        "width": project.get("width"),
        "height": project.get("height"),
        "fps": project.get("fps"),
    }
    limitations = [
        "Premiere XML carries source trims and basic audio/video placement; Clipflow crop, adaptive camera, denoise, caption styling, visual effects, and playback speed are not reproduced.",
        "Premiere uses the first selected clip's canvas when selected clips have different aspect ratios; clips with other ratios will be scaled into that sequence.",
        "SRT cues use source-speed timing. Retiming captions may be needed after reapplying playback speed in Premiere.",
        "After Effects script creates editable source layers and caption text layers. Adaptive camera tracking and rendered Clipflow effects are not reconstructed.",
        "Reapply playback speed in Premiere using the values in this manifest.",
        "Premiere XML media paths are package-relative hints. If Premiere reports offline media, relink to the media folder extracted from this ZIP.",
        "The After Effects script creates a new project; if an existing project has unsaved changes, After Effects may prompt before opening the new project. Save the resulting AEP alongside the extracted media folder.",
    ]
    return {
        "format": "Clipflow Adobe handoff v1",
        "project": project_summary,
        "source_media": f"media/{media_name}",
        "clips": clips,
        "limitations": limitations,
    }


def _package_readme(project: dict, media_name: str, has_audio: bool) -> str:
    audio_note = "and source audio" if has_audio else "; this source has no audio stream"
    return (
        "Clipflow Adobe edit handoff\n\n"
        "1. Extract the whole ZIP. Keep the media folder beside the project files.\n"
        f"2. Premiere Pro: import Premiere.xml. If media is offline, relink to media/{media_name}. "
        f"The sequence contains editable source trims{audio_note}. Reapply playback speed using the manifest values. "
        "SRT cues use source-speed timing and may need retiming after you change clip speeds. "
        "If selected clips use different aspect ratios, the first selected clip sets the sequence canvas.\n"
        "3. After Effects: open after-effects.jsx and run it with File > Scripts > Run Script File. "
        "It imports media relative to the script and saves an AEP beside the script. If a project is already open, "
        "AE may ask whether to save it before creating the new project. Keep the extracted media folder beside the AEP when moving it.\n"
        "4. Import captions.srt into Premiere and place it at the start of the sequence for editable caption cues.\n\n"
        "This is a conservative edit handoff. Clipflow crop/reframe, adaptive camera movement, denoise, caption appearance, "
        "and other rendered effects are not recreated. The manifest retains the source clip settings for reference. "
        "The ZIP includes the original source once; rendered outputs are not included and are not a visual match to the Clipflow render.\n"
    )


def _package_parts(project: dict, clips: list[dict], source: Path, has_audio: bool):
    clean, media_name, fps = prepare(project, clips, source)
    manifest = _manifest(project, clips, media_name)
    title = str(project.get("title") or "Clipflow handoff")
    readme = _package_readme(project, media_name, has_audio)
    content = [
        ("Premiere.xml", _xml(project, clean, media_name, fps, has_audio)),
        ("captions.srt", _sequence_srt(clean, project).encode("utf-8")),
        ("after-effects.jsx", _jsx(title, clean, media_name).encode("utf-8")),
        (
            "manifest.json",
            json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        ),
        ("README.txt", readme.encode("utf-8")),
    ]
    return media_name, content


def stream_package(project: dict, clips: list[dict], source: Path, *, has_audio: bool):
    """Yield a ZIP package without staging a second copy of the source on disk."""
    media_name, content = _package_parts(project, clips, source, has_audio)

    def generate():
        chunks: queue.Queue[bytes | None] = queue.Queue(maxsize=8)
        stop = threading.Event()
        state: dict[str, BaseException | None] = {"error": None}

        class Sink:
            def __init__(self):
                self.position = 0

            def tell(self):
                return self.position

            def seekable(self):
                return False

            def flush(self):
                return None

            def write(self, data):
                view = memoryview(data)
                for offset in range(0, len(view), 64 * 1024):
                    if stop.is_set():
                        raise BrokenPipeError("ZIP consumer disconnected")
                    chunk = bytes(view[offset : offset + 64 * 1024])
                    while not stop.is_set():
                        try:
                            chunks.put(chunk, timeout=0.1)
                            break
                        except queue.Full:
                            continue
                    if stop.is_set():
                        raise BrokenPipeError("ZIP consumer disconnected")
                self.position += len(data)
                return len(data)

        def produce():
            try:
                with zipfile.ZipFile(Sink(), "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as archive:
                    archive.write(source, f"media/{media_name}", compress_type=zipfile.ZIP_STORED)
                    for name, data in content:
                        archive.writestr(name, data)
            except BaseException as exc:
                if not stop.is_set():
                    state["error"] = exc
            finally:
                if not stop.is_set():
                    while True:
                        try:
                            chunks.put(None, timeout=0.1)
                            break
                        except queue.Full:
                            if stop.is_set():
                                break

        worker = threading.Thread(target=produce, name="clipflow-adobe-zip", daemon=True)
        worker.start()
        try:
            while True:
                chunk = chunks.get()
                if chunk is None:
                    if state["error"]:
                        raise state["error"]
                    break
                yield chunk
        finally:
            stop.set()
            worker.join(timeout=2)

    return generate()
