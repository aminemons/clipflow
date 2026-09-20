from __future__ import annotations

import time
import json
from pathlib import Path

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.export_artifacts import finalize_exports
from backend.publishing import UncertainPublish, PublishingSettings, register
from backend.publishing import ProviderError
from backend.publishing_providers import InstagramProvider, TikTokProvider, YouTubeProvider
from backend.store import Store


class FakeProvider:
    calls = []

    def publish(self, **kwargs):
        self.calls.append(kwargs)
        return {"remote_id": "fake-1"}


class UncertainProvider:
    def publish(self, **kwargs):
        raise UncertainPublish("request outcome is unknown")


class AccountProvider:
    def __init__(self, failing=None):
        self.calls = []
        self.failing = failing

    def publish(self, **kwargs):
        self.calls.append(kwargs)
        if self.failing and kwargs["target"].get("account_id") == self.failing:
            raise ProviderError("account rejected the post")
        return {"remote_id": f"remote-{kwargs['target'].get('account_id')}"}


def _app(tmp_path, provider=None):
    store = Store(tmp_path)
    rendered = tmp_path / "render.mp4"
    rendered.write_bytes(b"immutable export")
    clip = {"id": "clip-a", "title": "A clip", "revision": 2, "status": "exported"}
    artifact = finalize_exports(store, "project-a", "job-a", [(clip, rendered)])
    clip["download_url"] = artifact["artifact_urls"]["clip-a"]
    store.save({"id": "project-a", "clips": [clip], "edit_revision": 1})
    app = FastAPI()
    service = register(app, store, context={"providers": {"youtube": provider}} if provider else None)
    return app, store, service


def _configure(client):
    response = client.put(
        "/api/publishing/settings",
        json={"youtube": {"enabled": True, "access_token": "test-token"}},
    )
    assert response.status_code == 200


def _prepare(client):
    return client.post(
        "/api/projects/project-a/publish/prepare",
        json={"clip_ids": ["clip-a"], "platforms": ["youtube"], "captions": {"youtube": "A caption"}, "privacy": {"youtube": "private"}},
    )


def test_approval_is_separate_and_binds_exact_export_revision(tmp_path):
    app, store, _ = _app(tmp_path)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    assert _prepare(client).status_code == 409
    approved = client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]})
    assert approved.status_code == 200
    assert approved.json()["approved"][0]["revision"] == 2
    project = store.get("project-a")
    project["clips"][0]["revision"] = 3
    store.save(project)
    rows = client.get("/api/projects/project-a/approvals").json()["approvals"]
    assert rows[0]["valid"] is False
    assert _prepare(client).status_code == 409


def test_prepare_then_explicit_confirm_publishes_once(tmp_path):
    provider = FakeProvider()
    app, _, _ = _app(tmp_path, provider)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    _configure(client)
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    plan = _prepare(client)
    assert plan.status_code == 200
    body = plan.json()
    assert body["targets"][0]["artifact_url"].endswith("/exports/job-a/clip-a/download")
    assert client.post("/api/publishing/confirm", json={"plan_id": body["plan_id"], "confirmation": "NO", "confirmation_token": body["confirmation_token"]}).status_code == 400
    confirmed = client.post("/api/publishing/confirm", json={"plan_id": body["plan_id"], "confirmation": "PUBLISH", "confirmation_token": body["confirmation_token"]})
    assert confirmed.status_code == 200
    assert confirmed.json()["attempts"][0]["status"] in {"queued", "running", "succeeded"}
    assert client.post("/api/publishing/confirm", json={"plan_id": body["plan_id"], "confirmation": "PUBLISH", "confirmation_token": body["confirmation_token"]}).status_code == 409
    for _ in range(30):
        history = client.get("/api/publishing/history").json()["attempts"]
        if history and history[0]["status"] == "succeeded":
            break
        time.sleep(0.01)
    assert history[0]["status"] == "succeeded"
    assert len(provider.calls) == 1


def test_confirm_rejects_edit_after_prepare(tmp_path):
    app, store, _ = _app(tmp_path)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    _configure(client)
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    body = _prepare(client).json()
    project = store.get("project-a")
    project["clips"][0]["revision"] = 4
    store.save(project)
    response = client.post("/api/publishing/confirm", json={"plan_id": body["plan_id"], "confirmation": "PUBLISH", "confirmation_token": body["confirmation_token"]})
    assert response.status_code == 409


def test_uncertain_attempt_is_persisted_without_retry(tmp_path):
    app, _, _ = _app(tmp_path, UncertainProvider())
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    _configure(client)
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    body = _prepare(client).json()
    confirmed = client.post("/api/publishing/confirm", json={"plan_id": body["plan_id"], "confirmation": "PUBLISH", "confirmation_token": body["confirmation_token"]})
    assert confirmed.status_code == 200
    for _ in range(30):
        history = client.get("/api/publishing/history").json()["attempts"]
        if history and history[0]["status"] == "uncertain":
            break
        time.sleep(0.01)
    assert history[0]["status"] == "uncertain"
    assert history[0]["retry_allowed"] is False


def test_youtube_rejects_untrusted_resumable_location(tmp_path, monkeypatch):
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"video")
    def fake_request(method, url, **kwargs):
        return 200, {"Location": "https://evil.example/upload"}, b""
    monkeypatch.setattr("backend.publishing_providers._request", fake_request)
    with pytest.raises(ProviderError, match="resumable upload URL"):
        YouTubeProvider({"access_token": "token"}).publish(path=str(media), artifact_url="/x", caption="", privacy="private", target={})


def test_instagram_waits_for_finished_and_reads_permalink(tmp_path, monkeypatch):
    calls = []
    def fake_request(method, url, **kwargs):
        calls.append((method, url))
        if method == "POST" and url.endswith("/media"):
            return 200, {}, b'{"id":"container-1"}'
        if method == "GET" and "container-1" in url:
            return 200, {}, b'{"status_code":"FINISHED"}'
        if method == "POST" and url.endswith("/media_publish"):
            return 200, {}, b'{"id":"media-1"}'
        return 200, {}, b'{"permalink":"https://instagram.com/reel/real-link/"}'
    monkeypatch.setattr("backend.publishing_providers._request", fake_request)
    result = InstagramProvider({"account_id":"ig", "access_token":"token", "public_base_url":"https://media.example", "container_poll_seconds":0}).publish(path=str(tmp_path / "missing.mp4"), artifact_url="/api/video.mp4", caption="caption", privacy="", target={})
    assert result["url"].endswith("real-link/")
    assert [method for method, _ in calls] == ["POST", "GET", "POST", "GET"]


def test_tiktok_uses_creator_privacy_flags_and_final_status(monkeypatch):
    payloads = []
    def fake_request(method, url, **kwargs):
        payloads.append(kwargs.get("data"))
        if url.endswith("creator_info/query/"):
            return 200, {}, b'{"data":{"privacy_level_options":["SELF_ONLY"]}}'
        if url.endswith("video/init/"):
            return 200, {}, b'{"data":{"publish_id":"publish-1"}}'
        return 200, {}, b'{"data":{"status":"PUBLISH_COMPLETE"}}'
    monkeypatch.setattr("backend.publishing_providers._request", fake_request)
    result = TikTokProvider({"access_token":"token", "client_key":"key", "audit_approved":True, "public_base_url":"https://media.example", "disable_duet":True, "disable_comment":True, "disable_stitch":False}).publish(path="missing.mp4", artifact_url="/api/video.mp4", caption="caption", privacy="SELF_ONLY", target={})
    assert result["status"] == "succeeded"
    init = next(json.loads(raw.decode()) for raw in payloads if raw and b"post_info" in raw)
    assert init["post_info"]["privacy_level"] == "SELF_ONLY"
    assert init["post_info"]["disable_duet"] is True
    assert init["post_info"]["disable_comment"] is True


def test_legacy_settings_are_migrated_and_secrets_stay_redacted(tmp_path):
    path = tmp_path / "publishing_settings.json"
    path.write_text(json.dumps({"youtube": {"enabled": True, "access_token": "secret-token"}}), encoding="utf-8")
    settings = PublishingSettings(tmp_path)
    public = settings.public()
    account = public["providers"]["youtube"]["accounts"][0]
    assert account["id"] == "legacy-youtube"
    assert account["configured"] is True
    assert account["has_access_token"] is True
    assert "secret-token" not in json.dumps(public)


def test_prepare_and_confirm_can_target_two_accounts(tmp_path):
    provider = FakeProvider()
    provider.calls = []
    app, _, _ = _app(tmp_path, provider)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    configured = client.put("/api/publishing/settings", json={"youtube": {"accounts": [
        {"id": "channel-a", "label": "Main channel", "enabled": True, "access_token": "token-a"},
        {"id": "channel-b", "label": "Second channel", "enabled": True, "access_token": "token-b"},
    ]}})
    assert configured.status_code == 200
    projection = configured.json()["providers"]["youtube"]
    assert [row["id"] for row in projection["accounts"]] == ["channel-a", "channel-b"]
    assert "token-a" not in json.dumps(projection)
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    prepared = client.post("/api/projects/project-a/publish/prepare", json={
        "clip_ids": ["clip-a"],
        "destinations": [{"platform": "youtube", "account_id": "channel-a"}, {"platform": "youtube", "account_id": "channel-b"}],
        "captions": {"youtube": "A caption"},
    })
    assert prepared.status_code == 200
    plan = prepared.json()
    assert [(target["account_id"], target["account_label"]) for target in plan["targets"]] == [("channel-a", "Main channel"), ("channel-b", "Second channel")]
    confirmed = client.post("/api/publishing/confirm", json={"plan_id": plan["plan_id"], "confirmation": "PUBLISH", "confirmation_token": plan["confirmation_token"]})
    assert confirmed.status_code == 200
    for _ in range(40):
        history = client.get("/api/publishing/history").json()["attempts"]
        if len(history) == 2 and all(row["status"] == "succeeded" for row in history):
            break
        time.sleep(0.01)
    assert {row["account_id"] for row in history} == {"channel-a", "channel-b"}
    assert len(provider.calls) == 2


def test_unknown_destination_account_is_rejected(tmp_path):
    app, _, _ = _app(tmp_path)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    _configure(client)
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    response = client.post("/api/projects/project-a/publish/prepare", json={"clip_ids": ["clip-a"], "destinations": [{"platform": "youtube", "account_id": "missing"}]})
    assert response.status_code == 400


def test_duplicate_destinations_are_deduplicated(tmp_path):
    provider = AccountProvider()
    app, _, _ = _app(tmp_path, provider)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    assert client.put("/api/publishing/settings", json={"youtube": {"accounts": [{"id": "channel-a", "label": "Main", "enabled": True, "access_token": "token"}]}}).status_code == 200
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    plan = client.post("/api/projects/project-a/publish/prepare", json={"clip_ids": ["clip-a"], "destinations": [{"platform": "youtube", "account_id": "channel-a"}, {"platform": "youtube", "account_id": "channel-a"}]}).json()
    assert len(plan["targets"]) == 1


def test_account_change_after_review_invalidates_plan(tmp_path):
    provider = AccountProvider()
    app, _, _ = _app(tmp_path, provider)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    assert client.put("/api/publishing/settings", json={"youtube": {"accounts": [{"id": "channel-a", "label": "Main", "enabled": True, "access_token": "token"}]}}).status_code == 200
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    plan = client.post("/api/projects/project-a/publish/prepare", json={"clip_ids": ["clip-a"], "destinations": [{"platform": "youtube", "account_id": "channel-a"}]}).json()
    assert client.put("/api/publishing/settings", json={"youtube": {"accounts": [{"id": "channel-a", "label": "Main", "enabled": True, "access_token": "rotated-token"}]}}).status_code == 200
    response = client.post("/api/publishing/confirm", json={"plan_id": plan["plan_id"], "confirmation": "PUBLISH", "confirmation_token": plan["confirmation_token"]})
    assert response.status_code == 409
    assert not provider.calls


def test_same_platform_accounts_report_partial_failure_without_retry(tmp_path):
    provider = AccountProvider(failing="channel-b")
    app, _, _ = _app(tmp_path, provider)
    client = TestClient(app, base_url="http://127.0.0.1:8000")
    assert client.put("/api/publishing/settings", json={"youtube": {"accounts": [
        {"id": "channel-a", "label": "Main", "enabled": True, "access_token": "token-a"},
        {"id": "channel-b", "label": "Second", "enabled": True, "access_token": "token-b"},
    ]}}).status_code == 200
    assert client.post("/api/projects/project-a/approvals", json={"clip_ids": ["clip-a"]}).status_code == 200
    plan = client.post("/api/projects/project-a/publish/prepare", json={"clip_ids": ["clip-a"], "destinations": [{"platform": "youtube", "account_id": "channel-a"}, {"platform": "youtube", "account_id": "channel-b"}]}).json()
    assert client.post("/api/publishing/confirm", json={"plan_id": plan["plan_id"], "confirmation": "PUBLISH", "confirmation_token": plan["confirmation_token"]}).status_code == 200
    for _ in range(40):
        history = client.get("/api/publishing/history").json()["attempts"]
        if len(history) == 2 and all(row["status"] in {"succeeded", "failed"} for row in history):
            break
        time.sleep(0.01)
    assert {row["account_id"]: row["status"] for row in history} == {"channel-a": "succeeded", "channel-b": "failed"}
    assert all(row["retry_allowed"] is False for row in history)
