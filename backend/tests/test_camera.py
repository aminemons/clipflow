from pathlib import Path

import cv2
import numpy as np

from backend import media
from backend.camera import (
    CameraController,
    CameraPoint,
    camera_settings,
    choose_target,
    interpolate_keyframes,
    normalize_keyframes,
)


def test_keyframes_are_sorted_bounded_and_deterministically_interpolated():
    rows = normalize_keyframes(
        [
            {"time": 2, "x": 9, "y": -1, "zoom": 9},
            {"time": 0, "x": 0.2, "y": 0.4, "zoom": 1},
            {"time": 2, "x": 0.8, "y": 0.6, "zoom": 1.4},
        ]
    )
    assert interpolate_keyframes(1, rows) == CameraPoint(0.5, 0.5, 1.2)
    assert interpolate_keyframes(-1, rows) == CameraPoint(0.2, 0.4, 1.0)
    assert interpolate_keyframes(3, rows) == CameraPoint(0.8, 0.6, 1.4)


def test_target_selection_holds_identity_through_detector_jitter():
    first = choose_target([(10, 20, 40, 60), (210, 20, 100, 120)], 320, 180)
    assert first is not None and first.x > 0.6
    # The left face is slightly bigger, but continuity keeps the existing right face.
    second = choose_target([(10, 20, 100, 120), (205, 22, 95, 118)], 320, 180, first)
    assert second is not None and second.x > 0.6


def test_dead_zone_and_bounded_camera_motion():
    controller = CameraController("smooth", dead_zone=0.1)
    still = controller.update(CameraPoint(0.55, 0.5), 1 / 30)
    assert still.x == 0.5
    positions = [controller.update(CameraPoint(0.95, 0.5), 1 / 30).x for _ in range(30)]
    assert positions == sorted(positions)
    assert max(b - a for a, b in zip(positions, positions[1:])) <= 0.02


def test_camera_point_zoom_is_used_without_an_explicit_zoom_override():
    controller = CameraController("dynamic")
    point = controller.update(CameraPoint(0.5, 0.5, 1.5), 1 / 30)
    assert point.zoom > 1.0


def test_camera_settles_at_target_without_pan_or_zoom_overshoot():
    controller = CameraController("dynamic", dead_zone=0)
    points = [
        controller.update(CameraPoint(0.8, 0.5, 1.4), 1 / 30)
        for _ in range(240)
    ]

    assert all(point.x <= 0.8 and point.zoom <= 1.4 for point in points)
    assert abs(points[-1].x - 0.8) < 1e-6
    assert abs(points[-1].zoom - 1.4) < 1e-6


def test_face_auto_zoom_is_capped_by_user_ceiling_and_safe_without_face():
    # A 10% source-height face would need 3x to occupy 30%, but the user's
    # 1.4x ceiling remains authoritative.
    assert media._face_zoom_target(72, 720, 720, 720, 1.4) == 1.4
    # A face already near the requested size does not zoom out below 1x.
    assert media._face_zoom_target(216, 720, 720, 720, 1.4) == 1.0
    assert media._face_zoom_target(0, 720, 720, 720, 1.4) == 1.0


def test_auto_zoom_is_opt_in_in_camera_settings():
    assert camera_settings({})["auto_zoom"] is False
    assert camera_settings({"camera_auto_zoom": True})["auto_zoom"] is True


def test_follow_render_applies_manual_keyframes_and_zoom(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "camera.mp4"
    media.make_demo(source)
    media.render_clip(
        source,
        {
            "start": 0,
            "end": 1.5,
            "resolution": 120,
            "framing": "follow",
            "aspect_ratio": "9:16",
            "camera_motion": "steady",
            "camera_dead_zone": 0.08,
            "camera_keyframes": [
                {"time": 0, "x": 0.25, "y": 0.5, "zoom": 1.0},
                {"time": 1.5, "x": 0.75, "y": 0.5, "zoom": 1.5},
            ],
        },
        output,
    )
    duration, width, height, fps = media.metadata(output)
    assert output.exists() and duration > 1.2
    assert (width, height) == (120, 214)
    assert fps >= 29


def test_manual_keyframes_change_exported_pixels_without_auto_tracking(tmp_path: Path):
    source = tmp_path / "source.mp4"
    moving = tmp_path / "manual-moving.mp4"
    fixed = tmp_path / "manual-fixed.mp4"
    media.make_demo(source)
    common = {
        "start": 0,
        "end": 1.5,
        "resolution": 120,
        "framing": "manual",
        "aspect_ratio": "9:16",
        "camera_motion": "dynamic",
        "camera_zoom": 1.0,
    }
    media.render_clip(
        source,
        {
            **common,
            "camera_keyframes": [
                {"time": 0, "x": 0.2, "y": 0.5, "zoom": 1.0},
                {"time": 1.5, "x": 0.8, "y": 0.5, "zoom": 1.4},
            ],
        },
        moving,
    )
    media.render_clip(
        source,
        {
            **common,
            "camera_keyframes": [
                {"time": 0, "x": 0.2, "y": 0.5, "zoom": 1.0},
                {"time": 1.5, "x": 0.2, "y": 0.5, "zoom": 1.0},
            ],
        },
        fixed,
    )
    frames = []
    for path in (moving, fixed):
        capture = cv2.VideoCapture(str(path))
        capture.set(cv2.CAP_PROP_POS_MSEC, 1200)
        ok, frame = capture.read()
        capture.release()
        assert ok
        frames.append(frame)
    assert float(np.mean(np.abs(frames[0].astype(np.int16) - frames[1].astype(np.int16)))) > 3.0

def test_target_selection_accepts_opencv_numpy_detections():
    import numpy as np
    detections = np.array([[10, 20, 40, 60], [210, 20, 100, 120]])
    target = choose_target(detections, 320, 180)
    assert target is not None and target.x > 0.6
    assert choose_target(np.empty((0, 4)), 320, 180) is None
