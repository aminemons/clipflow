import json

from backend.store import Store


def test_legacy_migration_keeps_original_and_unknown_fields(tmp_path):
    store = Store(tmp_path)
    original = {"id": "legacy", "clips": [{"id": "one", "start": 1, "end": 4}], "custom": {"keep": True}}
    path = store.projects / "legacy.json"
    path.write_text(json.dumps(original), encoding="utf-8")
    loaded = store.get("legacy")
    assert loaded["schema_version"] == 2
    assert loaded["clips"][0]["reviewed"] is False
    assert json.loads(path.read_text()) == original  # Reading is non-destructive.
    store.save(loaded)
    assert json.loads(path.with_suffix(".json.v1.bak").read_text()) == original
    assert store.get("legacy")["custom"] == {"keep": True}


def test_broken_save_recovers_previous_version_without_erasing_it(tmp_path):
    store = Store(tmp_path)
    store.save({"id": "project", "clips": [], "title": "Original"})
    store.save({"id": "project", "clips": [], "title": "Edited"})
    path = store.projects / "project.json"
    path.write_text('{"id":', encoding="utf-8")
    recovered = store.get("project")
    assert recovered["title"] == "Original"
    store.save(recovered)
    assert store.get("project")["title"] == "Original"
    assert len(store.list()) == 1


def test_jobs_reject_malformed_entries_and_recover_corrupt_file(tmp_path):
    store = Store(tmp_path)
    store.save_jobs({"okay": {"status": "done"}, "bad": None, "../escape": {}})
    assert store.load_jobs() == {"okay": {"status": "done"}}
    store.save_jobs({"new": {"status": "running"}})
    store.jobs_path.write_text("broken", encoding="utf-8")
    assert store.load_jobs() == {"okay": {"status": "done"}}
