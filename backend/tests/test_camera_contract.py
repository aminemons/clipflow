from fastapi.testclient import TestClient
import pytest

from backend import app as api
from backend.store import Store


@pytest.fixture()
def camera_project(monkeypatch, tmp_path):
    monkeypatch.setattr(api, "store", Store(tmp_path))
    clip = api.clip_defaults(0, 5, 0)
    api.store.save({"id": "camera-contract", "duration": 10, "clips": [clip]})
    return TestClient(api.app), api.store, clip


def test_legacy_clip_without_camera_fields_can_be_read_and_camera_edited(camera_project):
    client, store, clip = camera_project
    project = store.get("camera-contract")
    for field in ("camera_motion", "camera_zoom", "camera_dead_zone", "camera_keyframes"):
        project["clips"][0].pop(field, None)
    store.save(project)

    response = client.patch(
        f"/api/projects/camera-contract/clips/{clip['id']}",
        json={"camera_zoom": 1.25},
    )
    assert response.status_code == 200
    value = response.json()
    assert value["camera_zoom"] == 1.25
    assert "camera_motion" not in value
    assert value["revision"] == 2


@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_nonfinite_camera_keyframes_are_rejected_without_mutating_clip(camera_project, token):
    client, store, clip = camera_project
    before = store.get("camera-contract")["clips"][0]
    response = client.patch(
        f"/api/projects/camera-contract/clips/{clip['id']}",
        content=(
            '{"camera_keyframes":[{"time":%s,"x":0.5,"y":0.5,"zoom":1.0}]}'
            % token
        ),
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 400
    assert store.get("camera-contract")["clips"][0] == before


@pytest.mark.parametrize(
    "keyframes",
    [
        [
            {"time": 1.0, "x": 0.2, "y": 0.5, "zoom": 1.0},
            {"time": 1.0, "x": 0.8, "y": 0.5, "zoom": 1.0},
        ],
        [{"time": 1.0, "x": 0.5, "y": 0.5, "zoom": 1.0, "unknown": True}],
    ],
)
def test_duplicate_or_unknown_camera_keyframes_are_rejected_without_mutation(camera_project, keyframes):
    client, store, clip = camera_project
    before = store.get("camera-contract")["clips"][0]
    response = client.patch(
        f"/api/projects/camera-contract/clips/{clip['id']}",
        json={"camera_keyframes": keyframes},
    )
    assert response.status_code == 400
    assert store.get("camera-contract")["clips"][0] == before


def test_camera_edit_invalidates_export_revision(camera_project):
    client, store, clip = camera_project
    project = store.get("camera-contract")
    project["clips"][0].update(
        status="exported", download_url="/old.mp4", preview_revision=1
    )
    store.save(project)

    response = client.patch(
        f"/api/projects/camera-contract/clips/{clip['id']}",
        json={"camera_motion": "dynamic", "camera_dead_zone": 0.12},
    )
    assert response.status_code == 200
    value = response.json()
    assert value["revision"] == 2
    assert value["status"] == "draft"
    assert "download_url" not in value
    assert "preview_revision" not in value
    assert store.get("camera-contract")["edit_revision"] == 1
