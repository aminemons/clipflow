"""Short-lived, single-use tickets for importing a desktop-downloaded video."""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import quote
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, UploadFile
from pydantic import BaseModel

from .source_probe import validate_youtube_url

TICKET_TTL = 60 * 60
MAX_ACTIVE = 1000


class TicketInput(BaseModel):
    url: str
    quality: Literal[360, 720, 1080]


class TicketStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self._connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS desktop_tickets (
                token_hash TEXT PRIMARY KEY, url TEXT NOT NULL, quality INTEGER NOT NULL,
                expires REAL NOT NULL, state TEXT NOT NULL DEFAULT 'new'
            )""")

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def create(self, url: str, quality: int, now: float | None = None) -> str:
        now = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        with self.lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM desktop_tickets WHERE expires <= ? OR state = 'used'", (now,))
            if db.execute("SELECT COUNT(*) FROM desktop_tickets").fetchone()[0] >= MAX_ACTIVE:
                db.rollback()
                raise RuntimeError("Too many active desktop imports.")
            db.execute("INSERT INTO desktop_tickets(token_hash,url,quality,expires,state) VALUES(?,?,?,?, 'new')",
                       (self.digest(token), url, quality, now + TICKET_TTL))
            db.commit()
        return token

    def get(self, token: str, now: float | None = None):
        now = time.time() if now is None else now
        with self.lock, self._connect() as db:
            row = db.execute("SELECT url,quality,expires,state FROM desktop_tickets WHERE token_hash=?",
                             (self.digest(token),)).fetchone()
        if not row or row["expires"] <= now or row["state"] == "used":
            return None
        return {"url": row["url"], "quality": row["quality"]}

    def claim(self, token: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self.lock, self._connect() as db:
            changed = db.execute("UPDATE desktop_tickets SET state='claimed' WHERE token_hash=? AND expires>? AND state='new'",
                                 (self.digest(token), now)).rowcount
        return changed == 1

    def finish(self, token: str, success: bool) -> None:
        with self.lock, self._connect() as db:
            db.execute("DELETE FROM desktop_tickets WHERE token_hash=? AND state='claimed'" if success else
                       "UPDATE desktop_tickets SET state='new' WHERE token_hash=? AND state='claimed'",
                       (self.digest(token),))


def _ticket_from_request(request: Request) -> str:
    if request.cookies:
        raise HTTPException(401, "Bearer ticket required.")
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or not auth[7:] or len(auth) > 256:
        raise HTTPException(401, "Bearer ticket required.")
    return auth[7:]


def register_desktop_import(app, *, ticket_store: TicketStore, worker_origin: str,
                            web_origin: str, require_owner, upload_file, submit_upload):
    router = APIRouter()

    @router.post("/api/desktop-import/tickets")
    def create_ticket(body: TicketInput, request: Request):
        require_owner(request)
        if not worker_origin:
            raise HTTPException(503, "Desktop import is not configured.")
        try:
            url = validate_youtube_url(body.url)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if urlsplit(url).scheme != "https":
            raise HTTPException(400, "Use an HTTPS YouTube video URL.")
        try:
            token = ticket_store.create(url, body.quality)
        except RuntimeError as exc:
            raise HTTPException(429, str(exc)) from exc
        return {"launch_url": f"clipflow://import?ticket={quote(token)}&server={quote(worker_origin, safe='')}"}

    @router.get("/api/desktop-import/ticket")
    def read_ticket(request: Request):
        token = _ticket_from_request(request)
        record = ticket_store.get(token)
        if not record:
            raise HTTPException(401, "Invalid or expired desktop import ticket.")
        return {**record, "web_origin": web_origin}

    @router.post("/api/desktop-import/upload")
    async def upload(request: Request):
        token = _ticket_from_request(request)
        if not ticket_store.claim(token):
            raise HTTPException(401, "Invalid, expired, or already used desktop import ticket.")
        try:
            form = await request.form()
            file = form.get("file")
            if file is None or not hasattr(file, "read") or not hasattr(file, "filename"):
                raise HTTPException(400, "Choose a video file to upload.")
            result = await upload_file(file)
            response = submit_upload(result)
            ticket_store.finish(token, True)
            return response
        except BaseException:
            ticket_store.finish(token, False)
            raise

    app.include_router(router)
