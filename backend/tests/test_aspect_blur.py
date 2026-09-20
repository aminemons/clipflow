from pathlib import Path

import pytest

from backend import media


@pytest.fixture()
def source(tmp_path: Path):
    path = tmp_path / "source.mp4"
    media.run(
        [
            media.FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=180x100:rate=24:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=1",
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(path),
        ],
        300,
    )
    return path


def _size(path: Path):
    video = next(stream for stream in media.probe(path)["streams"] if stream["codec_type"] == "video")
    return int(video["width"]), int(video["height"])


@pytest.mark.parametrize(
    ("aspect_ratio", "expected"),
    [("9:16", (120, 214)), ("1:1", (120, 120)), ("4:5", (120, 150)), ("16:9", (120, 68))],
)
def test_fit_respects_all_aspect_ratios(source, tmp_path, aspect_ratio, expected):
    output = tmp_path / f"fit-{aspect_ratio.replace(':', '-')}.mp4"
    media.render_clip(
        source,
        {"start": 0, "end": 1, "resolution": 120, "framing": "fit", "aspect_ratio": aspect_ratio},
        output,
    )
    assert _size(output) == expected


def test_blur_framing_outputs_target_size_and_audio(source, tmp_path):
    output = tmp_path / "blur.mp4"
    media.render_clip(
        source,
        {"start": 0, "end": 1, "resolution": 120, "framing": "blur", "aspect_ratio": "1:1"},
        output,
    )
    assert _size(output) == (120, 120)
    assert any(stream["codec_type"] == "audio" for stream in media.probe(output)["streams"])


@pytest.mark.parametrize(
    ("aspect_ratio", "play_res_y", "y"),
    [("1:1", 720, 360), ("16:9", 406, 203)],
)
def test_caption_positions_use_selected_aspect_canvas(tmp_path, aspect_ratio, play_res_y, y):
    ass = media._caption_ass(
        tmp_path / f"caption-{aspect_ratio.replace(':', '-')}.mp4",
        {
            "caption_text": "caption",
            "caption_x": 0.5,
            "caption_y": 0.5,
            "aspect_ratio": aspect_ratio,
        },
    )
    content = ass.read_text(encoding="utf-8")
    assert f"PlayResY: {play_res_y}" in content
    assert f"\\pos(360,{y})" in content
