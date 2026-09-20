"""Deterministic, offline camera planning for vertical clip exports.

The module deliberately has no model or network dependency.  Detection is supplied by
the media renderer (OpenCV Haar faces and a conservative motion fallback), while this
file owns the camera behavior: keyframe interpolation, target association, dead zones,
and bounded movement.  Keeping those parts separate makes the behavior testable with
synthetic targets and keeps a detector from becoming a camera controller by accident.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Iterable, Mapping, Sequence


CAMERA_MOTIONS = ("steady", "smooth", "dynamic")
# ``adaptive`` is the safe automatic strategy: it follows reliable faces and
# switches to a full-frame treatment when the source looks like a diagram, slide,
# whiteboard, or screen recording.  ``follow`` preserves the historical detector
# behavior and ``manual`` leaves positions to keyframes/focus controls.
CAMERA_STRATEGIES = ("adaptive", "follow", "manual")
VISION_PROVIDERS = ("local", "gemini")


def _finite(value: object, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


@dataclass(frozen=True)
class CameraPoint:
    """A normalized camera center and crop zoom."""

    x: float
    y: float
    zoom: float = 1.0

    def bounded(self) -> "CameraPoint":
        return CameraPoint(clamp(self.x, 0.0, 1.0), clamp(self.y, 0.0, 1.0), clamp(self.zoom, 1.0, 1.5))


@dataclass(frozen=True)
class TrackedTarget:
    """A detector target in normalized coordinates.

    ``area`` is normalized image area and is used only as a weak tie breaker.  It must
    never outweigh spatial continuity, which prevents a second speaker or a bright
    background object from stealing the crop every detector pass.
    """

    x: float
    y: float
    area: float = 0.0
    box: tuple[float, float, float, float] | None = None

    @property
    def point(self) -> CameraPoint:
        return CameraPoint(self.x, self.y)


def camera_settings(clip: Mapping[str, object] | None) -> dict[str, object]:
    """Normalize camera options without changing historical clip defaults."""

    clip = clip or {}
    motion = str(clip.get("camera_motion", "smooth")).lower()
    if motion not in CAMERA_MOTIONS:
        motion = "smooth"
    strategy = str(clip.get("camera_strategy", "adaptive")).lower()
    if strategy not in CAMERA_STRATEGIES:
        strategy = "adaptive"
    provider = str(clip.get("vision_provider", "local")).lower()
    if provider not in VISION_PROVIDERS:
        provider = "local"
    safe_framing = str(clip.get("safe_framing", "fit")).lower()
    if safe_framing not in {"fit", "blur"}:
        safe_framing = "fit"
    return {
        "motion": motion,
        "strategy": strategy,
        "vision_provider": provider,
        "safe_framing": safe_framing,
        "zoom": clamp(_finite(clip.get("camera_zoom", 1.0), 1.0), 1.0, 1.5),
        "dead_zone": clamp(_finite(clip.get("camera_dead_zone", 0.08), 0.08), 0.0, 0.3),
        "auto_zoom": bool(clip.get("camera_auto_zoom", False)),
        "keyframes": normalize_keyframes(clip.get("camera_keyframes")),
    }


def normalize_keyframes(raw: object, *, limit: int = 50) -> list[CameraPoint | tuple[float, CameraPoint]]:
    """Return validated, time-sorted keyframes.

    The public storage format is ``{time, x, y, zoom}``; the internal tuple keeps time
    explicit while ``CameraPoint`` prevents accidental mutation during interpolation.
    Invalid rows are ignored.  Duplicate timestamps use the last row in input order,
    making edits deterministic and avoiding a zero-length interpolation interval.
    """

    if not isinstance(raw, (list, tuple)):
        return []
    parsed: list[tuple[float, CameraPoint, int]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            continue
        time = _finite(row.get("time"), float("nan"))
        if not math.isfinite(time) or time < 0:
            continue
        point = CameraPoint(
            clamp(_finite(row.get("x"), 0.5), 0.0, 1.0),
            clamp(_finite(row.get("y"), 0.5), 0.0, 1.0),
            clamp(_finite(row.get("zoom"), 1.0), 1.0, 1.5),
        )
        parsed.append((time, point, index))
    # Keep the last duplicate row, then sort by source time.  Capping after sorting
    # means a malformed/very long payload cannot make interpolation unpredictable.
    parsed.sort(key=lambda item: (item[0], item[2]))
    deduped: list[tuple[float, CameraPoint]] = []
    for time, point, _ in parsed:
        if deduped and time == deduped[-1][0]:
            deduped[-1] = (time, point)
        else:
            deduped.append((time, point))
    return deduped[: max(0, int(limit))]


def interpolate_keyframes(time: float, keyframes: object) -> CameraPoint | None:
    """Linearly interpolate manual camera keyframes at source ``time``.

    Values hold the first/last keyframe outside the authored range.  This function has
    no frame-rate dependence, so the same keyframes produce the same crop at preview
    and export rates.
    """

    frames = normalize_keyframes(keyframes) if not _is_normalized(keyframes) else list(keyframes)  # type: ignore[arg-type]
    if not frames:
        return None
    t = _finite(time, 0.0)
    if t <= frames[0][0]:
        return frames[0][1]
    if t >= frames[-1][0]:
        return frames[-1][1]
    for (a, first), (b, second) in zip(frames, frames[1:]):
        if a <= t <= b:
            ratio = 0.0 if b == a else (t - a) / (b - a)
            return CameraPoint(
                first.x + (second.x - first.x) * ratio,
                first.y + (second.y - first.y) * ratio,
                first.zoom + (second.zoom - first.zoom) * ratio,
            ).bounded()
    return frames[-1][1]


def _is_normalized(value: object) -> bool:
    if not isinstance(value, (list, tuple)) or not value:
        return False
    return all(
        isinstance(row, tuple)
        and len(row) == 2
        and isinstance(row[1], CameraPoint)
        for row in value
    )


def _target_from_box(box: Sequence[float], width: float, height: float) -> TrackedTarget | None:
    if len(box) < 4 or width <= 0 or height <= 0:
        return None
    x, y, w, h = (_finite(item, 0.0) for item in box[:4])
    if w <= 0 or h <= 0:
        return None
    return TrackedTarget(
        clamp((x + w / 2.0) / width, 0.0, 1.0),
        clamp((y + h / 2.0) / height, 0.0, 1.0),
        clamp((w * h) / (width * height), 0.0, 1.0),
        (x, y, w, h),
    )


def choose_target(
    boxes: Iterable[Sequence[float]] | None,
    width: float,
    height: float,
    previous: TrackedTarget | None = None,
    subject: str = "auto",
) -> TrackedTarget | None:
    """Choose a stable target with spatial hysteresis.

    Face detector boxes have no persistent IDs.  We associate a new box with the last
    target by distance first, and permit an area-based takeover only when the new box
    is substantially larger.  This is the same basic continuity principle used by
    tracking reframers while remaining deterministic and CPU-only.
    """

    candidates = [t for box in (boxes if boxes is not None else []) if (t := _target_from_box(box, width, height))]
    if not candidates:
        return None
    subject = subject if subject in {"auto", "left", "right"} else "auto"
    if subject == "left":
        return min(candidates, key=lambda item: (item.x, -item.area))
    if subject == "right":
        return max(candidates, key=lambda item: (item.x, item.area))
    if previous is None:
        return max(candidates, key=lambda item: (item.area, -item.x))
    def distance(item: TrackedTarget) -> float:
        return math.hypot(item.x - previous.x, item.y - previous.y)

    nearest = min(candidates, key=lambda item: (distance(item), -item.area))
    # A target remains associated through ordinary detector jitter.  A challenger can
    # take over only when it is clearly larger and the old target is no longer nearby.
    old_area = max(previous.area, 1e-6)
    challenger = max(candidates, key=lambda item: item.area)
    if challenger is not nearest and challenger.area > old_area * 1.8 and distance(nearest) > 0.22:
        return challenger
    return nearest


class CameraController:
    """Bounded-velocity camera motion with a configurable dead zone."""

    _PARAMS = {
        "steady": (1.25, 0.12, 0.35),
        "smooth": (0.55, 0.32, 0.90),
        "dynamic": (0.22, 0.72, 2.40),
    }

    def __init__(
        self,
        motion: str = "smooth",
        zoom: float = 1.0,
        dead_zone: float = 0.08,
        initial: CameraPoint | None = None,
    ) -> None:
        self.motion = motion if motion in CAMERA_MOTIONS else "smooth"
        self.base_zoom = clamp(_finite(zoom, 1.0), 1.0, 1.5)
        self.dead_zone = clamp(_finite(dead_zone, 0.08), 0.0, 0.3)
        point = (initial or CameraPoint(0.5, 0.5, 1.0)).bounded()
        self.point = point
        self._velocity = [0.0, 0.0, 0.0]

    def reset(self, target: CameraPoint | None = None) -> CameraPoint:
        self.point = (target or CameraPoint(0.5, 0.5, 1.0)).bounded()
        self._velocity[:] = [0.0, 0.0, 0.0]
        return self.point

    def _desired_center(self, target: CameraPoint | None) -> tuple[float, float]:
        if target is None:
            return self.point.x, self.point.y
        dx, dy = target.x - self.point.x, target.y - self.point.y
        distance = math.hypot(dx, dy)
        if distance <= self.dead_zone:
            return self.point.x, self.point.y
        # Move only the portion outside the dead zone, which stops tiny detector
        # changes from causing visible camera breathing.
        scale = (distance - self.dead_zone) / distance
        return self.point.x + dx * scale, self.point.y + dy * scale

    def update(
        self,
        target: CameraPoint | TrackedTarget | None,
        dt: float,
        *,
        scene_cut: bool = False,
        target_zoom: float | None = None,
    ) -> CameraPoint:
        if isinstance(target, TrackedTarget):
            target = target.point
        target = target.bounded() if target is not None else None
        dt = clamp(_finite(dt, 1.0 / 30.0), 1e-4, 1.0)
        if scene_cut:
            return self.reset(target or CameraPoint(0.5, 0.5, self.base_zoom))
        response, max_speed, acceleration = self._PARAMS[self.motion]
        desired_x, desired_y = self._desired_center(target)
        # A CameraPoint may carry an authored/derived zoom.  An explicit
        # ``target_zoom`` still wins for the renderer's fixed automatic zoom,
        # while direct controller users do not silently lose the point's zoom.
        zoom_goal = (
            target_zoom
            if target_zoom is not None
            else (target.zoom if target is not None else self.base_zoom)
        )
        desired_zoom = clamp(_finite(zoom_goal, self.base_zoom), 1.0, 1.5)
        desired = (desired_x, desired_y, desired_zoom)
        current = (self.point.x, self.point.y, self.point.zoom)
        next_values: list[float] = []
        for index, (now, want) in enumerate(zip(current, desired)):
            goal_velocity = clamp((want - now) / response, -max_speed, max_speed)
            # Zoom changes are intentionally slower than pan changes to avoid a
            # distracting punch-in when a detector box jitters.
            if index == 2:
                goal_velocity *= 0.55
            max_delta = acceleration * dt
            velocity = self._velocity[index] + clamp(goal_velocity - self._velocity[index], -max_delta, max_delta)
            value = now + velocity * dt
            self._velocity[index] = velocity
            next_values.append(value)
        self.point = CameraPoint(*next_values).bounded()
        return self.point
