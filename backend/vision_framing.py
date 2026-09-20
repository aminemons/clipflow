"""Small, offline content signals for safe automatic reframing.

This module intentionally stays model free.  A vertical crop is only useful when
there is a compact, reliable subject to follow.  Screen recordings, whiteboards,
slides, and diagrams usually have edges/text spread over the whole source; those
frames are safer when rendered as a full frame (optionally over a blurred backdrop).

The detector is a conservative heuristic built from OpenCV edges and a coarse grid.
It is a gate for the camera, not an OCR or object-recognition claim.  A future
provider may supply richer boxes, but a missing provider never turns into a fake
capability or a network request.
"""

from __future__ import annotations

from dataclasses import dataclass
import base64
import json
import math
import re
from typing import Iterable, Sequence

import httpx


SAFE_MODES = ("crop", "fit", "blur")
VISION_PROVIDERS = ("local", "gemini")


def vision_provider_capability(provider: str = "local") -> dict[str, object]:
    """Return a server-side capability projection without exposing credentials.

    Local analysis is always available when this module can import OpenCV at call
    time. Gemini is opt-in and only considered configured when the server has the
    existing ``GEMINI_API_KEY``. This helper does not perform a network request or
    upload media; callers still need an explicit user consent gate before adding a
    frame to a remote request.
    """

    provider = str(provider or "local").lower()
    if provider == "local":
        try:
            import cv2  # type: ignore  # noqa: F401
            available = True
        except Exception:
            available = False
        return {"provider": "local", "available": available, "configured": available}
    if provider == "gemini":
        try:
            from .config import value

            configured = bool(value("GEMINI_API_KEY"))
        except Exception:
            configured = False
        return {
            "provider": "gemini",
            "available": configured,
            "configured": configured,
            "upload_requires_consent": True,
        }
    return {"provider": provider, "available": False, "configured": False}


@dataclass(frozen=True)
class RemoteFramePlan:
    """Validated Gemini decision for one sampled source frame."""

    index: int
    mode: str
    protect_full_frame: bool
    faces: tuple[tuple[float, float, float, float], ...] = ()


def _json_object(text: str) -> dict:
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", str(text))
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("Gemini vision response must be an object")
    return value


def _normalized_box(raw: object) -> tuple[float, float, float, float] | None:
    if isinstance(raw, dict):
        raw = [raw.get("x"), raw.get("y"), raw.get("w", raw.get("width")), raw.get("h", raw.get("height"))]
    if not isinstance(raw, (list, tuple)) or len(raw) < 4:
        return None
    try:
        x, y, w, h = (float(item) for item in raw[:4])
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(item) for item in (x, y, w, h)) or w <= 0 or h <= 0:
        return None
    if x < 0 or y < 0 or x + w > 1 or y + h > 1:
        return None
    return (x, y, w, h)


def _validated_remote_plans(payload: dict, count: int) -> tuple[RemoteFramePlan, ...]:
    rows = payload.get("frames", payload.get("samples", []))
    if not isinstance(rows, list) or not rows:
        raise ValueError("Gemini vision response has no frame decisions")
    plans: list[RemoteFramePlan] = []
    for position, row in enumerate(rows[:count]):
        if not isinstance(row, dict):
            continue
        try:
            index = int(row.get("index", position))
        except (TypeError, ValueError):
            index = position
        if not 0 <= index < count:
            continue
        mode = str(row.get("mode", "fit")).lower()
        if mode not in {"crop", "fit", "blur"}:
            mode = "fit"
        raw_faces = row.get("faces", [])
        faces = tuple(box for value in (raw_faces if isinstance(raw_faces, list) else []) if (box := _normalized_box(value)) is not None)
        protect = bool(row.get("protect_full_frame", mode in {"fit", "blur"}))
        plans.append(RemoteFramePlan(index=index, mode=mode, protect_full_frame=protect, faces=faces[:12]))
    if not plans:
        raise ValueError("Gemini vision response has no valid frame decisions")
    return tuple(plans)


def gemini_vision_plans(
    frames: Sequence[object],
    *,
    model: str | None = None,
    timeout: float = 45.0,
    progress=None,
) -> tuple[RemoteFramePlan, ...]:
    """Ask Gemini about at most six sampled frames after explicit user selection.

    The caller controls whether this function runs. It performs no upload when the
    provider is not selected, and the renderer never calls it for the local default.
    Images are bounded JPEG inline parts, which keeps a clip analysis request small.
    """

    capability = vision_provider_capability("gemini")
    if not capability.get("available"):
        raise RuntimeError("Configure GEMINI_API_KEY before using Gemini framing.")
    if not frames:
        raise ValueError("Gemini framing needs at least one sampled frame")
    frames = list(frames[:6])
    try:
        from .config import value

        key = value("GEMINI_API_KEY")
        model_id = model or value("GEMINI_VISION_MODEL", "") or value("GEMINI_TEXT_MODEL", "gemini-3.8-flash")
    except Exception as exc:
        raise RuntimeError("Gemini framing configuration is unavailable.") from exc
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,150}", model_id):
        raise RuntimeError("Enter a Gemini model ID without a URL or path.")
    try:
        import cv2  # type: ignore
    except Exception as exc:
        raise RuntimeError("OpenCV is required to sample Gemini framing images.") from exc
    parts = [{"text": (
        "Analyze these ordered video frames for safe portrait reframing. Return ONLY JSON "
        "with frames: [{index, mode, protect_full_frame, faces}]. mode must be crop, fit, "
        "or blur. faces must contain normalized [x,y,width,height] boxes. Use protect_full_frame "
        "true for slides, diagrams, whiteboards, screen recordings, subtitles, or content "
        "spread across the frame; use crop only when a compact reliable subject exists. "
        "When multiple faces are present, include all of them and prefer fit/blur if one crop "
        "would cut any face."
    )}]
    for frame in frames:
        ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
        if not ok:
            raise RuntimeError("Could not encode a sampled frame for Gemini.")
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(encoded.tobytes()).decode("ascii")}})
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json", "maxOutputTokens": 2500},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
    last_error: Exception | None = None
    # A single bounded retry handles transient 429/5xx responses after explicit
    # provider selection. Parsing failures are not retried because they cannot be
    # repaired by spending another request.
    for attempt in range(2):
        try:
            with httpx.Client(timeout=timeout, follow_redirects=False) as client:
                response = client.post(url, headers={"Content-Type": "application/json", "x-goog-api-key": key}, json=body)
            if response.status_code in {429, 500, 502, 503, 504} and attempt == 0:
                continue
            if not response.is_success:
                raise RuntimeError(f"Gemini returned HTTP {response.status_code}.")
            payload = response.json()
            text = "".join(
                part.get("text", "")
                for part in payload.get("candidates", [])[0].get("content", {}).get("parts", [])
                if isinstance(part, dict) and not part.get("thought")
            )
            plans = _validated_remote_plans(_json_object(text), len(frames))
            if progress:
                progress("vision", 55)
            return plans
        except httpx.RequestError as exc:
            last_error = exc
            if attempt == 0:
                continue
            raise RuntimeError("Cannot reach Gemini for framing; using local safety fallback.") from exc
        except (ValueError, KeyError, TypeError, IndexError) as exc:
            raise RuntimeError("Gemini returned incomplete or invalid framing JSON; using local safety fallback.") from exc
    raise RuntimeError("Gemini framing request failed; using local safety fallback.") from last_error


@dataclass(frozen=True)
class FrameSignals:
    """Evidence used by the renderer to select a safe camera mode.

    Boxes are ``(x, y, width, height)`` in source pixel coordinates.  ``faces``
    is deliberately kept separate from generic content because faces are the one
    signal for which a crop is normally useful.
    """

    faces: tuple[tuple[int, int, int, int], ...] = ()
    text_boxes: tuple[tuple[int, int, int, int], ...] = ()
    edge_density: float = 0.0
    occupied_cells: int = 0
    content_span: float = 0.0
    distributed_content: bool = False

    @property
    def reliable_faces(self) -> bool:
        return bool(self.faces)

    def recommended_mode(self, requested: str = "fit") -> str:
        """Return a validated safe mode for content without reliable faces."""

        requested = str(requested or "fit").lower()
        if requested not in {"fit", "blur"}:
            requested = "fit"
        return "crop" if self.reliable_faces and not self.distributed_content else requested


def _box_tuple(box: Sequence[float], width: int, height: int) -> tuple[int, int, int, int] | None:
    if len(box) < 4 or width <= 0 or height <= 0:
        return None
    try:
        x, y, w, h = (float(value) for value in box[:4])
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(value) for value in (x, y, w, h)) or w <= 0 or h <= 0:
        return None
    x = max(0.0, min(float(width), x))
    y = max(0.0, min(float(height), y))
    w = max(0.0, min(float(width) - x, w))
    h = max(0.0, min(float(height) - y, h))
    return (int(round(x)), int(round(y)), int(round(w)), int(round(h))) if w > 1 and h > 1 else None


def _textlike_boxes(gray, cv2, width: int, height: int) -> tuple[tuple[int, int, int, int], ...]:
    """Find coarse groups of high frequency marks, without claiming OCR."""

    # Text and diagrams tend to produce short, repeated edges.  Close small gaps,
    # then retain connected regions that are neither single-pixel noise nor a whole
    # frame.  All thresholds scale with the sampled frame, keeping this cheap.
    edges = cv2.Canny(gray, 70, 160)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    joined = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=1)
    contours, _ = cv2.findContours(joined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    result: list[tuple[int, int, int, int]] = []
    image_area = float(max(1, width * height))
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = (w * h) / image_area
        if w >= 4 and h >= 3 and 0.00005 <= area <= 0.18:
            result.append((x, y, w, h))
    return tuple(result[:200])


def analyze_frame(
    frame,
    *,
    faces: Iterable[Sequence[float]] | None = None,
    grid: int = 4,
) -> FrameSignals:
    """Extract conservative distributed-content signals from one BGR frame.

    OpenCV and NumPy are imported lazily so importing the backend remains possible
    in environments that only use metadata or audio features.
    """

    try:
        import cv2  # type: ignore
    except Exception:
        return FrameSignals()
    if frame is None or not hasattr(frame, "shape") or len(frame.shape) < 2:
        return FrameSignals()
    height, width = int(frame.shape[0]), int(frame.shape[1])
    if width < 8 or height < 8:
        return FrameSignals()
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if len(frame.shape) == 3 else frame
    edges = cv2.Canny(gray, 70, 160)
    edge_density = float((edges > 0).mean())
    text_boxes = _textlike_boxes(gray, cv2, width, height)
    face_boxes = tuple(
        item for box in (faces if faces is not None else ()) if (item := _box_tuple(box, width, height)) is not None
    )

    cells = max(2, int(grid))
    occupied = 0
    # A cell needs enough edges to be meaningful, but the threshold is low enough
    # for fine handwriting on slides after the 320px analysis resize.
    cell_edges = []
    for row in range(cells):
        for col in range(cells):
            x0, x1 = width * col // cells, width * (col + 1) // cells
            y0, y1 = height * row // cells, height * (row + 1) // cells
            density = float((edges[y0:y1, x0:x1] > 0).mean()) if x1 > x0 and y1 > y0 else 0.0
            cell_edges.append(density)
            if density >= 0.018:
                occupied += 1
    active = [index for index, value in enumerate(cell_edges) if value >= 0.018]
    if active:
        rows = [index // cells for index in active]
        cols = [index % cells for index in active]
        span_x = (max(cols) - min(cols) + 1) / cells
        span_y = (max(rows) - min(rows) + 1) / cells
        content_span = min(1.0, math.sqrt(span_x * span_y))
    else:
        content_span = 0.0

    # Require both coverage and span. A local talking head or a bright object should
    # not disable tracking merely because it has a few edges.
    # Text lines often occupy a central band rather than all four corners.  The
    # crop itself may be only a third of a landscape source, so a span around half
    # the frame is already enough evidence that a portrait crop could remove useful
    # labels.  Requiring repeated connected marks keeps a plain wall from matching.
    distributed = (
        not face_boxes
        and occupied >= max(4, cells)
        and content_span >= 0.45
        and (edge_density >= 0.010 or len(text_boxes) >= 12)
    )
    return FrameSignals(
        faces=face_boxes,
        text_boxes=text_boxes,
        edge_density=edge_density,
        occupied_cells=occupied,
        content_span=content_span,
        distributed_content=distributed,
    )


def full_frame_view(frame, width: int, height: int, mode: str = "fit"):
    """Render a source frame without cropping into the target aspect ratio.

    ``fit`` adds black bars. ``blur`` uses a softened, enlarged backdrop and keeps
    the complete source frame sharp in the center.  The returned image is BGR.
    """

    import cv2  # type: ignore

    import numpy as np  # type: ignore

    mode = mode if mode in {"fit", "blur"} else "fit"
    source_h, source_w = int(frame.shape[0]), int(frame.shape[1])
    scale = min(width / max(1, source_w), height / max(1, source_h))
    fit_w, fit_h = max(1, int(round(source_w * scale))), max(1, int(round(source_h * scale)))
    fitted = cv2.resize(frame, (fit_w, fit_h), interpolation=cv2.INTER_AREA)
    if mode == "fit":
        canvas = np.zeros((height, width, 3), dtype=frame.dtype)
    else:
        back_scale = max(width / max(1, source_w), height / max(1, source_h))
        back = cv2.resize(
            frame,
            (max(1, int(round(source_w * back_scale))), max(1, int(round(source_h * back_scale)))),
            interpolation=cv2.INTER_AREA,
        )
        y0 = max(0, (back.shape[0] - height) // 2)
        x0 = max(0, (back.shape[1] - width) // 2)
        canvas = back[y0:y0 + height, x0:x0 + width]
        if canvas.shape[0] != height or canvas.shape[1] != width:
            canvas = cv2.resize(canvas, (width, height), interpolation=cv2.INTER_AREA)
        canvas = cv2.GaussianBlur(canvas, (0, 0), 18)
    x0, y0 = (width - fit_w) // 2, (height - fit_h) // 2
    canvas[y0:y0 + fit_h, x0:x0 + fit_w] = fitted
    return canvas


def safe_zoom_for_boxes(
    boxes: Iterable[Sequence[float]],
    source_width: int,
    source_height: int,
    crop_width: int,
    crop_height: int,
    ceiling: float,
    *,
    margin: float = 0.12,
) -> float:
    """Cap zoom so all reliable boxes remain inside one camera viewport."""

    try:
        limit = float(ceiling)
    except (TypeError, ValueError):
        limit = 1.0
    limit = max(1.0, min(1.5, limit))
    normalized = []
    for box in boxes:
        item = _box_tuple(box, source_width, source_height)
        if item:
            normalized.append(item)
    if not normalized or crop_width <= 0 or crop_height <= 0:
        return 1.0
    left = min(x for x, _y, _w, _h in normalized)
    top = min(y for _x, y, _w, _h in normalized)
    right = max(x + w for x, _y, w, _h in normalized)
    bottom = max(y + h for _x, y, _w, h in normalized)
    pad_x = max(2.0, (right - left) * max(0.0, margin))
    pad_y = max(2.0, (bottom - top) * max(0.0, margin))
    needed_w = max(2.0, right - left + 2.0 * pad_x)
    needed_h = max(2.0, bottom - top + 2.0 * pad_y)
    available = min(crop_width / needed_w, crop_height / needed_h)
    if not math.isfinite(available):
        return 1.0
    return max(1.0, min(limit, available))


def boxes_fit_viewport(
    boxes: Iterable[Sequence[float]],
    viewport_x: float,
    viewport_y: float,
    viewport_width: float,
    viewport_height: float,
    *,
    margin: float = 0.0,
) -> bool:
    """Check whether every reliable box is inside a source-pixel viewport."""

    if viewport_width <= 0 or viewport_height <= 0:
        return False
    normalized = []
    for box in boxes:
        if not isinstance(box, (list, tuple)) or len(box) < 4:
            continue
        try:
            x, y, width, height = (float(value) for value in box[:4])
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (x, y, width, height)) or width <= 0 or height <= 0:
            continue
        normalized.append((x, y, width, height))
    if not normalized:
        return True
    pad_x = max(0.0, float(margin))
    pad_y = max(0.0, float(margin))
    left = viewport_x + pad_x
    top = viewport_y + pad_y
    right = viewport_x + viewport_width - pad_x
    bottom = viewport_y + viewport_height - pad_y
    return all(
        x >= left and y >= top and x + width <= right and y + height <= bottom
        for x, y, width, height in normalized
    )
