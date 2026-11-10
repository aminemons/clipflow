"""Compile a short creative brief into a bounded, local editing job."""

from contextlib import contextmanager
from typing import Literal

from pydantic import Field, StrictBool

from .clip_generation import GenerateInput, SetupModel, generate_clips
from .motion_graphics import MAX_TEXT, valid_motion_graphic


class AutoEditInput(SetupModel):
    style: Literal["story", "social", "visual"] = "story"
    format: Literal["9:16", "4:5", "16:9"] = "9:16"
    focus: str = Field(default="", max_length=120)
    opening_text: str = Field(default="", max_length=MAX_TEXT)
    count: Literal[1, 3] = 1
    download_speech: StrictBool = False
    visible_captions: StrictBool = False


def auto_edit(api, item, project_id, body):
    brief = AutoEditInput.model_validate(body)
    style = brief.style
    opening = brief.opening_text.strip()
    preset = "callout" if style == "social" else "opening"
    if opening and not valid_motion_graphic({"preset": preset, "text": opening}):
        raise RuntimeError("Use plain text for the opening title.")
    use_speech = style != "visual"
    follow_subject = brief.format != "16:9" and style != "visual"
    plan = GenerateInput(
        automatic=True,
        target_duration={"story": 45, "social": 24, "visual": 15}[style],
        max_clips=brief.count,
        tolerance=.45,
        topic=brief.focus.strip() if use_speech else "",
        use_transcript=use_speech,
        camera={
            "aspect_ratio": brief.format,
            "framing": "follow" if follow_subject else "fit",
            "camera_motion": "dynamic" if style == "social" else "steady",
            "camera_auto_zoom": style == "social" and follow_subject,
            "safe_framing": "fit",
        },
        captions={
            "mode": "auto" if use_speech and not brief.visible_captions else "none",
            "style": "bold" if style == "social" else "clean",
            "size": 62 if style == "social" else 50,
            "color": "#ffe9a7" if style == "social" else "#ffffff",
            "y": .78 if brief.format == "9:16" else .84,
            "quality": "auto",
        },
        audio={"denoise": use_speech, "fade": .12 if use_speech else .3},
    )

    @contextmanager
    def finish(source, clips):
        # Previews use the final settings and live under the same cleanup rules
        # as editor proofs. Remove the entire staged batch if any render fails.
        output_dir = api.store.files / project_id
        output_dir.mkdir(exist_ok=True)
        files = []
        try:
            for index, clip in enumerate(clips):
                text = opening
                if not text and style == "social" and clip["transcript"]:
                    # Existing local ranking derives the title from the actual dialogue.
                    text = clip["title"].strip()
                graphic = {"preset": preset, "text": text}
                if valid_motion_graphic(graphic):
                    clip["motion_graphic"] = graphic
                clip["selected"] = False
                api.ensure_workspace_space(max(api.MIN_FREE_BYTES, source.stat().st_size))
                output = output_dir / f"preview-{clip['id']}-{item['id']}.mp4"
                files.append(output)
                api.render_clip(
                    source, clip, output,
                    api.srt_for_clip(clip, clip["transcript"], for_render=True) or None,
                    lambda stage, percent: api.update(
                        item, f"Finishing cut {index + 1} of {len(clips)}: {stage}",
                        94 + int(5 * (index + percent / 100) / len(clips)),
                    ),
                )
                clip["auto_proof"] = {"job_id": item["id"], "revision": clip["revision"]}
            yield {
                **brief.model_dump(),
                "job_id": item["id"],
                "warning": item.get("warning", ""),
            }
        except BaseException:
            for path in files:
                path.unlink(missing_ok=True)
            raise

    return generate_clips(
        api, item, project_id, plan.model_dump(),
        finish=finish, speech_policy="download" if brief.download_speech else "cached",
    )
