from pathlib import Path
import re
import struct
import subprocess

import pytest

from backend import media


@pytest.fixture()
def av_fixture(tmp_path):
    source = tmp_path / "source.mp4"
    media.run(
        [
            media.FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=180x100:rate=30:duration=1.6",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=48000:duration=1.6",
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(source),
        ],
        300,
    )
    return source


@pytest.fixture()
def video_fixture(tmp_path):
    source = tmp_path / "video-only.mp4"
    media.run(
        [
            media.FFMPEG,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=180x100:rate=30:duration=1.2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        300,
    )
    return source


def _streams(path):
    return {stream.get("codec_type") for stream in media.probe(path).get("streams", [])}


def test_double_speed_keeps_av_and_halves_duration(av_fixture, tmp_path):
    output = tmp_path / "fast.mp4"
    media.render_clip(
        av_fixture,
        {"start": 0, "end": 1.6, "framing": "fit", "playback_speed": 2},
        output,
    )
    duration = media.metadata(output)[0]
    assert 0.6 <= duration <= 1.1
    assert {"video", "audio"} <= _streams(output)


def test_mute_and_audio_filters_are_applied(av_fixture, tmp_path):
    output = tmp_path / "muted.mp4"
    media.render_clip(
        av_fixture,
        {
            "start": 0,
            "end": 1.6,
            "framing": "manual",
            "focus_x": 0.5,
            "audio_volume": 0,
            "audio_denoise": True,
            "audio_fade": 0.4,
        },
        output,
    )
    assert {"video", "audio"} <= _streams(output)
    analysis = media.run(
        [
            media.FFMPEG,
            "-hide_banner",
            "-i",
            str(output),
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ],
        300,
    )
    match = re.search(r"mean_volume:\s*(-?[\d.]+) dB", analysis.stderr)
    assert match and float(match.group(1)) < -70


def _pcm_rms(path, start_sample=0, sample_count=None):
    """Decode a small mono PCM window so fade behavior is measured, not inferred."""
    raw = subprocess.run(
        [
            media.FFMPEG,
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "-",
        ],
        stdout=subprocess.PIPE,
        check=True,
    ).stdout
    values = struct.unpack("<%df" % (len(raw) // 4), raw)
    window = values[
        start_sample : start_sample + sample_count if sample_count else None
    ]
    return (sum(sample * sample for sample in window) / max(1, len(window))) ** 0.5


def test_nonmuted_fade_reduces_opening_energy(av_fixture, tmp_path):
    output = tmp_path / "faded.mp4"
    media.render_clip(
        av_fixture,
        {"start": 0, "end": 1.6, "framing": "fit", "audio_fade": 0.4},
        output,
    )
    opening = _pcm_rms(output, 80, 320)
    middle = _pcm_rms(output, 4000, 320)
    assert middle > 0.05
    assert opening < middle * 0.55


def test_follow_mode_effects_postprocess_tiny_source(av_fixture, tmp_path):
    output = tmp_path / "follow.mp4"
    media.render_clip(
        av_fixture,
        {
            "start": 0,
            "end": 1.6,
            "framing": "follow",
            "resolution": 180,
            "playback_speed": 2,
            "audio_volume": 0.5,
        },
        output,
    )
    assert 0.6 <= media.metadata(output)[0] <= 1.1
    assert {"video", "audio"} <= _streams(output)


def test_video_only_speed_path_has_no_spurious_audio(video_fixture, tmp_path):
    output = tmp_path / "video-fast.mp4"
    media.render_clip(
        video_fixture,
        {"start": 0, "end": 1.2, "framing": "fit", "playback_speed": 2},
        output,
    )
    assert 0.4 <= media.metadata(output)[0] <= 0.8
    assert _streams(output) == {"video"}


def test_srt_offsets_include_source_start_and_scale_for_download():
    clip = {"start": 10, "end": 14, "playback_speed": 2}
    transcript = [{"start": 11, "end": 12, "text": "inside"}]
    standalone = media.srt_for_clip(clip, transcript)
    render = media.srt_for_clip(clip, transcript, for_render=True)
    assert "00:00:00,500 --> 00:00:01,000" in standalone
    assert "00:00:01,000 --> 00:00:02,000" in render
