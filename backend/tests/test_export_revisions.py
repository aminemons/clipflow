import pytest
from backend import app as api
from backend.store import Store


def test_plain_clips_are_not_highlight_suggestions():
    assert "suggestion_status" not in api.clip_defaults(0, 5, 0)


def test_export_queued_before_edit_does_not_render_new_revision(tmp_path, monkeypatch):
    store = Store(tmp_path)
    clip = api.clip_defaults(0, 5, 0)
    clip["revision"] = 2
    store.save({"id":"test", "duration":10, "clips":[clip]})
    monkeypatch.setattr(api, "store", store)
    monkeypatch.setattr(api, "source_path", lambda _: tmp_path / "source.mp4")
    with pytest.raises(RuntimeError, match="changed while export was queued"):
        api.export_job({"id":"job"}, "test", [clip["id"]], {clip["id"]:1})
