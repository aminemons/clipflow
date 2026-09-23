import numpy as np

from backend import media


class _FakeStdout:
    def __init__(self):
        self._reads = [bytes(np.zeros(160 * 90, dtype=np.uint8)), b""]

    def read(self, _size):
        return self._reads.pop(0)

    def close(self):
        pass


class _FakeProcess:
    def __init__(self):
        self.stdout = _FakeStdout()

    def wait(self, **_kwargs):
        return 0

    def poll(self):
        return 0

    def kill(self):
        pass


def test_scene_probe_decodes_intermediate_frames(monkeypatch, tmp_path):
    calls = []

    def fake_popen(args, **_kwargs):
        calls.append(args)
        return _FakeProcess()

    monkeypatch.setattr(media.subprocess, "Popen", fake_popen)
    media._scene_points(tmp_path / "source.mp4", 3.0, 30.0)

    assert calls
    args = calls[0]
    assert "-skip_frame" not in args
    assert "fps=1,scale=160:90:flags=fast_bilinear,format=gray" in args


def test_analyze_segments_absorbs_tiny_tail_and_covers_source(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "metadata", lambda _path: (10.6, 1920, 1080, 30.0))
    monkeypatch.setattr(media, "_scene_points", lambda *_args: [])
    monkeypatch.setattr(media, "detect_silence", lambda *_args: [])

    segments = media.analyze_segments(tmp_path / "source.mp4", target=5.0)

    assert segments == [(0.0, 5.0), (5.0, 10.6)]
    assert segments[0][0] == 0.0
    assert segments[-1][1] == 10.6
    assert all(left[1] == right[0] for left, right in zip(segments, segments[1:]))


def test_analyze_segments_keeps_source_shorter_than_one_second(monkeypatch, tmp_path):
    monkeypatch.setattr(media, "metadata", lambda _path: (0.6, 1920, 1080, 30.0))
    monkeypatch.setattr(media, "_scene_points", lambda *_args: [])
    monkeypatch.setattr(media, "detect_silence", lambda *_args: [])

    assert media.analyze_segments(tmp_path / "source.mp4", target=5.0) == [(0.0, 0.6)]
