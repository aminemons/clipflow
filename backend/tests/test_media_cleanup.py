from pathlib import Path

import pytest

from backend import media


def test_follow_cancellation_cleans_stream_and_tracking_temp(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "preview.mp4"
    media.make_demo(source)
    media.set_cancel_check(lambda: True)
    try:
        with pytest.raises(RuntimeError, match="cancel"):
            media.render_clip(
                source,
                {"start": 0, "end": 2, "framing": "follow", "resolution": 180},
                output,
            )
    finally:
        media.set_cancel_check(None)
    assert not output.with_suffix(".tracking.mp4").exists()
    assert not output.with_suffix(".normalized.mp4").exists()


def test_face_subject_preference_is_deterministic():
    faces = [(10, 0, 20, 20), (100, 0, 40, 40)]
    assert media._select_face_x(faces, 200, None, "left") == 0.1
    assert media._select_face_x(faces, 200, None, "right") == 0.6
    # Auto follows the nearest existing subject once a track is established.
    assert media._select_face_x(faces, 200, 0.12, "auto") == 0.1


def test_face_subject_preference_accepts_opencv_numpy_boxes():
    np = pytest.importorskip("numpy")
    faces = np.array([[10, 0, 20, 20], [100, 0, 40, 40]], dtype=np.int32)
    assert media._select_face_x(faces, 200, None, "right") == 0.6


def test_timed_srt_ass_events_and_center_style(tmp_path: Path):
    ass = media._caption_ass(
        tmp_path / "caption.mp4",
        {"caption_position": "center", "caption_style": "minimal"},
        "1\n00:00:00,200 --> 00:00:01,200\nhello world\n",
    )
    assert ass is not None
    content = ass.read_text(encoding="utf-8")
    assert "Style: Clip" in content and ",5,42,42,72," in content
    assert "Dialogue: 0,0:00:00.20,0:00:01.20" in content
    ass.unlink(missing_ok=True)
