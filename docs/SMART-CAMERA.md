# Smart camera

ClipFlow's `follow` framing is a local CPU pass. It detects faces with the OpenCV
Haar cascade when available, falls back to connected components from frame
difference, then sends normalized targets through `backend/camera.py`. No API key,
cloud model, or paid service is required.

The camera keeps the current target by spatial continuity. A new detector box must
be substantially larger and sufficiently far away before it can replace the active
track. The dead zone (default `0.08`) absorbs small detector changes, and each motion
preset limits velocity and acceleration:

- `steady`: slow pans for mostly static presenters;
- `smooth`: the default, with moderate easing;
- `dynamic`: faster movement for visibly moving subjects.

`camera_zoom` is bounded to `1.0..1.5`. `camera_keyframes` contains up to 50 rows of
`{time, x, y, zoom}`, where `time` is in source seconds and `x`/`y` are normalized
centers. Between rows, all values use deterministic linear interpolation; authored
keyframes bypass automatic tracking and easing. A detected hard scene cut releases
the previous identity and reacquires from the new scene.

The fallback is intentionally conservative. It follows coherent changed regions,
not arbitrary semantic objects, and can miss a static non-face subject or a heavily
occluded face. Haar detection is less robust than a modern learned detector. A future
optional detector can supply boxes to the same controller without changing export
behavior.

The design follows the public principles used by [OpenCV tracking](https://docs.opencv.org/5.0/tutorials_contrib/tracking/tutorial_introduction_to_tracker.html),
[MediaPipe face detection](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/python),
and [Google AutoFlip](https://research.google/blog/autoflip-an-open-source-framework-for-intelligent-video-reframing/).
The OpenShorts project describes a similar stabilized face-tracking crop in its
[feature overview](https://github.com/micronlogivdev/openshorts), while ClipFlow keeps
its implementation offline and dependency-light.
