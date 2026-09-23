from __future__ import annotations

import sqlite3
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.desktop_import import TicketStore, register_desktop_import


def make_client(tmp_path):
    app = FastAPI()
    tickets = TicketStore(tmp_path / "desktop.sqlite3")

    async def save_file(file):
        assert file.filename == "clip.mp4"
        return {"id": "project-1"}

    def submit(project):
        return {"project_id": project["id"], "job_id": "job-1"}

    register_desktop_import(
        app, ticket_store=tickets, worker_origin="https://worker.example",
        web_origin="https://clipflow.example", require_owner=lambda _r: "owner",
        upload_file=save_file, submit_upload=submit,
    )
    return TestClient(app), tickets


def create(client, url="https://www.youtube.com/watch?v=aqz-KE-bpKQ", quality=720):
    return client.post("/api/desktop-import/tickets", json={"url": url, "quality": quality})


def ticket_from(response):
    return parse_qs(urlsplit(response.json()["launch_url"]).query)["ticket"][0]


def test_ticket_creation_validates_input_and_persists_only_hash(tmp_path):
    client, tickets = make_client(tmp_path)
    assert create(client, "https://example.com/video").status_code == 400
    assert create(client, quality=1081).status_code == 422
    assert create(client, quality=480).status_code == 422
    assert create(client, url="http://www.youtube.com/watch?v=aqz-KE-bpKQ").status_code == 400
    launch = create(client).json()["launch_url"]
    query = parse_qs(urlsplit(launch).query)
    token = query["ticket"][0]
    assert launch.startswith("clipflow://import?")
    assert query["server"] == ["https://worker.example"]
    row = sqlite3.connect(tickets.path).execute("SELECT token_hash,url,quality FROM desktop_tickets").fetchone()
    assert row[0] != token
    assert len(row[0]) == 64 and row[2] == 720
    assert client.get("/api/desktop-import/ticket", headers={"Authorization": f"Bearer {token}"}).json() == {
        "url": "https://www.youtube.com/watch?v=aqz-KE-bpKQ", "quality": 720,
        "web_origin": "https://clipflow.example",
    }


def test_wrong_cookie_expiry_and_one_use_upload(tmp_path):
    client, tickets = make_client(tmp_path)
    token = ticket_from(create(client))
    assert client.get("/api/desktop-import/ticket", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/desktop-import/ticket", headers={"Authorization": f"Bearer {token}", "Cookie": "clipflow_session=x"}).status_code == 401
    with tickets._connect() as db:
        db.execute("UPDATE desktop_tickets SET expires=0")
    assert client.get("/api/desktop-import/ticket", headers={"Authorization": f"Bearer {token}"}).status_code == 401

    fresh = ticket_from(create(client))
    response = client.post("/api/desktop-import/upload", headers={"Authorization": f"Bearer {fresh}"}, files={"file": ("clip.mp4", b"video")})
    assert response.status_code == 200
    assert response.json() == {"project_id": "project-1", "job_id": "job-1"}
    assert client.post("/api/desktop-import/upload", headers={"Authorization": f"Bearer {fresh}"}, files={"file": ("clip.mp4", b"video")}).status_code == 401


def test_failed_upload_releases_claim(tmp_path):
    client, tickets = make_client(tmp_path)
    token = tickets.create("https://www.youtube.com/watch?v=aqz-KE-bpKQ", 720)
    # Exercise the atomic claim/release semantics used when parsing or storage fails.
    assert tickets.claim(token)
    assert not tickets.claim(token)
    tickets.finish(token, False)
    assert tickets.claim(token)
