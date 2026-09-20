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
