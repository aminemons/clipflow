import os

import pytest
from dotenv import dotenv_values
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import settings, media


@pytest.fixture
def configured(monkeypatch, tmp_path):
    path = tmp_path / ".env"
    path.write_text("# Keep this comment\nUNRELATED=keep\n")
    monkeypatch.setattr(settings, "ENV_PATH", path)
    for name in set(settings.FIELDS.values()) | settings.KEYS:
        monkeypatch.delenv(name, raising=False)
    app = FastAPI()
    settings.register(app, lambda: False)
    return TestClient(app, base_url="http://127.0.0.1:8767"), path


def test_keys_are_write_only_persist_and_can_be_removed(configured):
    client, path = configured
    saved = client.put(
        "/api/settings",
        json={
            "highlight_provider": "groq",
            "credentials": {"GROQ_API_KEY": "secret-with-'quote"},
        },
    )
    assert saved.status_code == 200
    assert saved.json()["keys"]["GROQ_API_KEY"] is True
    assert "secret-with" not in saved.text + client.get("/api/settings").text
    assert dotenv_values(path)["GROQ_API_KEY"] == "secret-with-'quote"
    assert dotenv_values(path)["UNRELATED"] == "keep"
    assert "# Keep this comment" in path.read_text()
    client.put("/api/settings", json={"credentials": {"GROQ_API_KEY": ""}})
    assert os.environ["GROQ_API_KEY"] == "secret-with-'quote"
    cleared = client.put(
        "/api/settings",
        json={"clear_keys": ["GROQ_API_KEY"], "highlight_provider": "local"},
    )
    assert not cleared.json()["keys"]["GROQ_API_KEY"]
    assert dotenv_values(path)["GROQ_API_KEY"] == ""


def test_foreign_origins_and_env_injection_are_rejected(configured):
    client, path = configured
    original = path.read_text()
    assert (
        client.put(
            "/api/settings", headers={"Origin": "https://untrusted.example"}, json={}
        ).status_code
        == 403
    )
    assert (
        client.put(
            "/api/settings", json={"credentials": {"GROQ_API_KEY": "key\nOTHER=value"}}
        ).status_code
        == 400
    )
    assert (
        client.put(
            "/api/settings", json={"credentials": {"ARBITRARY_ENV": "key"}}
        ).status_code
        == 400
    )
    assert path.read_text() == original


def test_caption_mouse_coordinates_and_disable(tmp_path):
    clip = {"caption_text": "Caption", "caption_x": 0.4, "caption_y": 0.9}
    ass = media._caption_ass(tmp_path / "clip.mp4", clip)
    assert "{\\an5\\pos(288,1152)}Caption" in ass.read_text()
    clip["caption_enabled"] = False
    assert media._caption_ass(tmp_path / "hidden.mp4", clip) is None
