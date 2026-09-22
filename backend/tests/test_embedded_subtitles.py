"""Exercise caption reuse with an actual text track in a small MP4."""

import subprocess
import threading

from backend import app, highlights
from backend.clip_generation import generate_clips
from backend.embedded_subtitles import extract_text_subtitles
from backend.media import FFMPEG, probe
from backend.store import Store


def test_embedded_timed_text_can_replace_speech_recognition(tmp_path):
    captions = tmp_path / "captions.srt"
    captions.write_text(
        "1\n00:00:00,300 --> 00:00:01,300\nAlready captioned\n\n"
        "2\n00:00:01,400 --> 00:00:01,900\nNext line\n",
        encoding="utf-8",
    )
    source = tmp_path / "source.mp4"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=2",
         "-i", str(captions), "-c:v", "mpeg4", "-c:s", "mov_text", str(source)],
        check=True, capture_output=True, timeout=30,
    )
    cues = extract_text_subtitles(source, probe(source)["streams"], FFMPEG)
    assert cues == [
        {"start": 0.3, "end": 1.3, "text": "Already captioned"},
        {"start": 1.4, "end": 1.9, "text": "Next line"},
    ]


def test_automatic_generation_reuses_source_subtitles(tmp_path, monkeypatch):
    captions = tmp_path / "captions.srt"
    captions.write_text(
        "1\n00:00:00,300 --> 00:00:01,300\nAlready captioned\n",
        encoding="utf-8",
    )
    source = tmp_path / "source.mp4"
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=160x90:d=2",
         "-i", str(captions), "-c:v", "mpeg4", "-c:s", "mov_text", str(source)],
        check=True, capture_output=True, timeout=30,
    )
    store = Store(tmp_path / "data")
    store.save({"id": "captioned", "duration": 2, "clips": [], "transcript": [], "edit_revision": 0})
    monkeypatch.setattr(app, "store", store)
    monkeypatch.setattr(app, "source_path", lambda _: source)
    monkeypatch.setattr(app, "update", lambda *_: None)
    monkeypatch.setattr(app, "check_cancelled", lambda *_: None)
    monkeypatch.setattr(app, "projects_lock", threading.RLock())
    def fail_if_speech_is_loaded(*_args):
        raise AssertionError("speech model loaded despite source subtitles")

    monkeypatch.setattr(app.speech, "transcribe", fail_if_speech_is_loaded)
    monkeypatch.setattr(
        highlights, "suggest_highlights",
        lambda _source, cues, *_: [{"start": 0.2, "end": 1.4, "title": cues[0]["text"]}],
    )
    job = {"id": "embedded-text"}
    generate_clips(app, job, "captioned", {
        "automatic": True, "mode": "smart", "target_duration": 5,
        "max_clips": 1, "use_transcript": True,
        "captions": {"mode": "auto"},
    })
    clip = store.get("captioned")["clips"][0]
    assert clip["transcript"][0]["text"] == "Already captioned"
    assert clip["caption_enabled"] is True
    assert "unnecessary" in job["warning"]
