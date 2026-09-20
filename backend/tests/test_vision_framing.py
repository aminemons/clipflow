import cv2
import numpy as np
from pathlib import Path

from backend import media
from backend.vision_framing import (
    analyze_frame,
    boxes_fit_viewport,
    full_frame_view,
    gemini_vision_plans,
    RemoteFramePlan,
    safe_zoom_for_boxes,
)
import backend.vision_framing as framing


def test_distributed_diagram_text_requests_full_frame_mode():
    frame = np.full((720, 1280, 3), 255, dtype=np.uint8)
    for row in range(9):
        cv2.putText(
            frame,
            f"DIAGRAM LABEL {row}",
            (20, 60 + row * 75),
            cv2.FONT_HERSHEY_SIMPLEX,
            1,
            (0, 0, 0),
            2,
        )
    signals = analyze_frame(frame)
    assert signals.distributed_content
    assert signals.recommended_mode("fit") == "fit"

    rendered = full_frame_view(frame, 120, 214, "fit")
    assert rendered.shape == (214, 120, 3)
    # The fitted landscape remains visible between the portrait letterbox bars.
    assert rendered[107].mean() > 20
    assert rendered[0].mean() == 0


def test_multiple_faces_get_a_zoom_cap_that_keeps_the_group_in_view():
    # Two far apart faces cannot safely use the user's 1.5x ceiling in a portrait
    # crop.  The cap is intentionally computed from the union plus a margin.
    cap = safe_zoom_for_boxes(
        [(40, 180, 100, 160), (940, 180, 100, 160)],
        1280,
        720,
        405,
        720,
        1.5,
    )
    assert 1.0 <= cap < 1.5
    assert not boxes_fit_viewport(
        [(40, 180, 100, 160), (940, 180, 100, 160)],
        437,
        0,
        405,
        720,
    )


def test_face_signal_prevents_distributed_text_fallback():
    frame = np.full((360, 640, 3), 255, dtype=np.uint8)
    for row in range(6):
        cv2.putText(frame, "SLIDE TEXT", (10, 45 + row * 50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    signals = analyze_frame(frame, faces=[(280, 100, 80, 120)])
    assert signals.reliable_faces
    assert not signals.distributed_content


def test_gemini_plans_are_bounded_validated_and_retry_transient_response(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("GEMINI_TEXT_MODEL", "gemini-test")

    class Response:
        def __init__(self, status, payload):
            self.status_code = status
            self._payload = payload
            self.is_success = 200 <= status < 300

        def json(self):
            return self._payload

    payload = {
        "candidates": [{
            "content": {"parts": [{"text": '{"frames":[{"index":0,"mode":"fit","protect_full_frame":true,"faces":[[0.1,0.2,0.2,0.3]]}]}'}]}
        }]
    }
    responses = iter([Response(503, {}), Response(200, payload)])
    calls = []

    class Client:
        def __init__(self, **kwargs):
            calls.append(kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, headers, json):
            assert "gemini-test" in url
            assert headers["x-goog-api-key"] == "test-key"
            assert len(json["contents"][0]["parts"]) == 2
            assert len(json["contents"][0]["parts"][1]["inline_data"]["data"]) < 50000
            return next(responses)

    monkeypatch.setattr(framing.httpx, "Client", Client)
    plans = gemini_vision_plans([np.zeros((180, 320, 3), dtype=np.uint8)])
    assert len(calls) == 2
    assert plans[0].protect_full_frame and plans[0].mode == "fit"
    assert plans[0].faces == ((0.1, 0.2, 0.2, 0.3),)


def test_selected_gemini_plan_drives_full_frame_renderer(monkeypatch, tmp_path: Path):
    source, output = tmp_path / "source.mp4", tmp_path / "out.mp4"
    media.make_demo(source)
    monkeypatch.setattr(
        media,
        "_gemini_clip_plans",
        lambda *_args: (RemoteFramePlan(0, "fit", True),),
    )
    seen = {"count": 0}
    original = media.full_frame_view

    def wrapped(frame, width, height, mode="fit"):
        seen["count"] += 1
        return original(frame, width, height, mode)

    monkeypatch.setattr(media, "full_frame_view", wrapped)
    media.render_clip(
        source,
        {
            "start": 0,
            "end": 0.5,
            "resolution": 120,
            "framing": "follow",
            "aspect_ratio": "9:16",
            "camera_strategy": "adaptive",
            "vision_provider": "gemini",
            "safe_framing": "fit",
        },
        output,
    )
    assert output.exists() and seen["count"] > 0

def test_opencv_numpy_face_detections_are_accepted():
    import numpy as np
    from backend.vision_framing import analyze_frame
    frame = np.zeros((180, 320, 3), dtype=np.uint8)
    detections = np.array([[12, 20, 35, 40], [220, 20, 35, 40]])
    signals = analyze_frame(frame, faces=detections)
    assert len(signals.faces) == 2
