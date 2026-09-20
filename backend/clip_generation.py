"""Validated project setup and atomic generation of independently editable clips."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SetupModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class TimeRange(SetupModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)

    @model_validator(mode="after")
    def ordered(self):
        if self.end <= self.start:
            raise ValueError("Each range must end after it starts.")
        return self


class CameraSetup(SetupModel):
    framing: Literal["follow", "manual", "fit", "blur"] = "follow"
    camera_motion: Literal["steady", "smooth", "dynamic"] = "smooth"
    camera_zoom: float = Field(default=1, ge=1, le=1.5)
    camera_auto_zoom: bool = False
    camera_strategy: Literal["adaptive", "follow", "manual"] = "adaptive"
    vision_provider: Literal["local", "gemini"] = "local"
    safe_framing: Literal["fit", "blur"] = "fit"
    camera_dead_zone: float = Field(default=.08, ge=0, le=.3)
    focus_x: float = Field(default=.5, ge=0, le=1)
    subject: Literal["auto", "left", "right"] = "auto"
    aspect_ratio: Literal["9:16", "1:1", "4:5", "16:9"] = "9:16"
    resolution: Literal[360, 720, 1080] = 720


class CaptionSetup(SetupModel):
    mode: Literal["none", "auto", "manual"] = "none"
    text: str = Field(default="", max_length=4000)
    style: Literal["clean", "bold", "minimal"] = "clean"
    font: Literal["outfit", "anton", "noto-arabic"] = "outfit"
    size: float = Field(default=52, ge=32, le=90)
    color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    x: float = Field(default=.5, ge=.05, le=.95)
    y: float = Field(default=.86, ge=.05, le=.95)
    language: Literal["auto", "ar", "fr", "en"] = "auto"
    quality: Literal["auto", "fast", "balanced", "accurate"] = "balanced"
    dialect: Literal["none", "algerian"] = "none"


class AudioSetup(SetupModel):
    volume: float = Field(default=1, ge=0, le=2)
    denoise: bool = False
    fade: float = Field(default=0, ge=0, le=2)


class GenerateInput(SetupModel):
    automatic: bool = False
    mode: Literal["smart", "full", "manual"] = "smart"
    target_duration: float = Field(default=30, ge=5, le=300)
    tolerance: float = Field(default=.3, ge=.1, le=.5)
    max_clips: int = Field(default=5, ge=1, le=20)
    topic: str = Field(default="", max_length=500)
    use_transcript: bool = False
    provider: Literal["local", "groq", "openai", "anthropic", "gemini", "ollama"] = "local"
    ranges: list[TimeRange] = Field(default_factory=list, max_length=100)
    camera: CameraSetup = Field(default_factory=CameraSetup)
    captions: CaptionSetup = Field(default_factory=CaptionSetup)
    audio: AudioSetup = Field(default_factory=AudioSetup)

    @model_validator(mode="after")
    def coherent(self):
        if self.mode == "manual" and not self.ranges:
            raise ValueError("Choose at least one time range.")
        if self.captions.mode == "manual" and not self.captions.text.strip():
            raise ValueError("Enter caption text or turn captions off.")
        if self.mode == "smart" and self.provider != "local" and not self.use_transcript:
            raise ValueError("Language model ranking requires speech analysis.")
        return self


def generate_clips(api, item: dict, project_id: str, payload: dict) -> dict:
    """Compute privately; commit once so cancellation/failure never leaves half a batch.

    Existing clips retain their settings, corrected transcripts and exports. New
    clips carry their own transcript snapshot, allowing later independent edits.
    Camera paths are evaluated against actual frames during proof/export renders.
    """
    from .highlights import suggest_highlights
    from .language_models import available

    setup = GenerateInput.model_validate(payload)
    project = api.store.get(project_id)
    if not project:
        raise RuntimeError("Project no longer exists.")
    revision = int(project.get("edit_revision", 0))
    duration = float(project["duration"])
    if any(r.end > duration for r in setup.ranges):
        raise RuntimeError("A selected range extends beyond the source video.")
    if setup.mode == "smart" and not available(setup.provider):
        raise RuntimeError("Configure the chosen highlight provider in Settings first.")
    source = api.source_path(project_id)
    transcript = project.get("transcript", [])
    speech_options = {"language": setup.captions.language, "quality": setup.captions.quality,
                      "dialect": setup.captions.dialect}
    cached = project.get("generation_speech", {})
    if not transcript and cached.get("options") == speech_options:
        transcript = cached.get("segments", [])
    needs_speech = setup.captions.mode == "auto" or (setup.mode == "smart" and setup.use_transcript)
    if needs_speech and not transcript:
        if not any(s.get("codec_type") == "audio" for s in api.media.probe(source).get("streams", [])):
            if not setup.automatic:
                raise RuntimeError("This source has no audio. Turn off speech analysis and automatic captions.")
            setup.use_transcript = False
            setup.captions.mode = "none"
            item["warning"] = "No audio track: selected visual moments with captions off."
        else:
            if setup.captions.quality == "auto":
                readiness = api.speech.model_readiness(source, speech_options)
                if readiness.get("warning"):
                    item["warning"] = readiness["warning"]
            try:
                transcript = api.speech.transcribe(source, duration,
                    lambda stage, percent: api.update(item, stage, int(percent * .5)),
                    speech_options)
            except RuntimeError as error:
                if not setup.automatic or not str(error).startswith("No speech was detected"):
                    raise
                transcript = []
        if not transcript and not setup.automatic:
            raise RuntimeError("No speech was recognized. Check the language or choose manual captions.")
        if not transcript and setup.automatic:
            setup.use_transcript = False
            setup.captions.mode = "none"
            item.setdefault("warning", "No speech was recognized: selected visual moments with captions off.")
    progress = lambda stage, percent: api.update(item, stage, 50 + int(percent * .4))
    if setup.mode == "smart":
        suggestions = suggest_highlights(source, transcript if setup.use_transcript else [],
            setup.target_duration, setup.max_clips, setup.tolerance, setup.topic,
            setup.provider, progress)
    elif setup.mode == "full":
        suggestions = [{"start": start, "end": end} for start, end in
            api.analyze_segments(source, setup.target_duration, progress)]
    else:
        suggestions = [r.model_dump() for r in setup.ranges]
    if not suggestions:
        raise RuntimeError("No matching moments were found. Broaden the topic or choose time ranges manually.")
    prepared = []
    api.update(item, "Applying camera, captions and audio", 94)
    for row in suggestions:
        clip = api.clip_defaults(row["start"], row["end"], len(project.get("clips", [])) + len(prepared))
        clip.update(setup.camera.model_dump())
        clip.update(caption_enabled=setup.captions.mode != "none",
            caption_text=setup.captions.text.strip() if setup.captions.mode == "manual" else "",
            caption_font=setup.captions.font, caption_size=setup.captions.size,
            caption_style=setup.captions.style, caption_color=setup.captions.color,
            caption_x=setup.captions.x, caption_y=setup.captions.y,
            audio_volume=setup.audio.volume, audio_denoise=setup.audio.denoise,
            audio_fade=setup.audio.fade, generation_id=item.get("id", ""))
        # Explicit snapshots also prevent project speech from leaking into a
        # clip whose user chose captions off or manual text.
        clip["transcript"] = [dict(t) for t in transcript
            if t["end"] > clip["start"] and t["start"] < clip["end"]] if setup.captions.mode == "auto" else []
        if setup.mode == "smart":
            clip.update(title=str(row.get("title") or clip["title"])[:150],
                reason=row.get("reason", "Suggested moment"), score=row.get("score", 0),
                suggestion_status="pending")
        api.validate_clip(clip, duration)
        prepared.append(clip)
    api.check_cancelled(item)
    with api.projects_lock:
        latest = api.store.get(project_id)
        if not latest or int(latest.get("edit_revision", 0)) != revision:
            raise RuntimeError("The project changed during generation. Your edits were kept; generate again.")
        api.check_cancelled(item)
        # Deliberately append: setting up another batch must never erase edited clips.
        latest["clips"].extend(prepared)
        latest["generation_settings"] = setup.model_dump()
        if needs_speech and transcript:
            latest["generation_speech"] = {"options": speech_options, "segments": transcript}
        latest["edit_revision"] = revision + 1
        api.store.save(latest)
    # The commit is the completion boundary; do not report cancellation after it.
    item.update(stage=f"Created {len(prepared)} editable clips", progress=99)
    return {"clip_titles": [c["title"] for c in prepared]}
