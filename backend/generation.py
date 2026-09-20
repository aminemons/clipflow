"""Optional, server-side Higgsfield B-roll generation. No requests without opt-in."""

from __future__ import annotations

import ipaddress
import socket
import time
import uuid
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field

from .config import public_capabilities, value

BASE = "https://api.higgsfield.ai"
MODEL_PATH = "/kling-video/v2.5-turbo/pro/text-to-video"


class GenerationInput(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    duration: Literal[5, 10] = 5


def public_output_url(url: str) -> str:
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise RuntimeError("The generation provider returned an invalid download URL.")
    addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(
        not ipaddress.ip_address(address[4][0]).is_global for address in addresses
    ):
        raise RuntimeError(
            "The generation provider returned a non-public download URL."
        )
    return url


def _json(response: httpx.Response) -> dict:
    if response.status_code in (401, 403):
        raise RuntimeError(
            "Higgsfield rejected the credentials. Check HF_API_KEY and HF_API_SECRET in .env."
        )
    if response.status_code in (402, 429):
        raise RuntimeError(
            "Higgsfield credits or request limits were reached. Check your provider account."
        )
    if not response.is_success:
        raise RuntimeError(
            f"Higgsfield request failed (HTTP {response.status_code}). Retry from the job panel."
        )
    return response.json()


def generate_source(body: dict, output: Path, progress) -> None:
    headers = {"Authorization": f"Key {value('HF_API_KEY')}:{value('HF_API_SECRET')}"}
    request_id = None
    completed = False
    try:
        with httpx.Client(timeout=httpx.Timeout(90, connect=20)) as client:
            progress("Submitting B-roll to Higgsfield", 3)
            result = _json(
                client.post(
                    BASE + MODEL_PATH,
                    headers=headers,
                    json={
                        "prompt": body["prompt"],
                        "duration": body["duration"],
                        "cfg_scale": 0.5,
                    },
                )
            )
            request_id = str(result.get("request_id", ""))
            # Only a request identifier is used; never send credentials to a response-provided URL.
            if not request_id or any(
                c
                not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
                for c in request_id
            ):
                raise RuntimeError(
                    "Higgsfield did not return a valid request identifier."
                )
            deadline = time.monotonic() + 1200
            while time.monotonic() < deadline:
                result = _json(
                    client.get(f"{BASE}/requests/{request_id}/status", headers=headers)
                )
                status = result.get("status", "queued")
                if status == "completed":
                    completed = True
                    break
                if status in {"failed", "canceled", "cancelled", "nsfw"}:
                    raise RuntimeError(
                        f"Higgsfield generation ended with status: {status}."
                    )
                progress(
                    (
                        "Higgsfield is generating your B-roll"
                        if status != "queued"
                        else "Waiting for Higgsfield"
                    ),
                    10,
                )
                time.sleep(2)
            else:
                raise RuntimeError("Higgsfield generation timed out after 20 minutes.")
            url = public_output_url(str(result.get("video", {}).get("url", "")))
            progress("Downloading generated video", 70)
            with client.stream("GET", url) as response:
                if not response.is_success:
                    raise RuntimeError(
                        "The generated video could not be downloaded. Retry generation from the job panel."
                    )
                total = 0
                with output.open("wb") as destination:
                    for chunk in response.iter_bytes(1024 * 256):
                        total += len(chunk)
                        if total > 256 * 1024 * 1024:
                            raise RuntimeError(
                                "Generated video exceeded the 256 MB download limit."
                            )
                        destination.write(chunk)
                        progress("Downloading generated video", 75)
    except BaseException:
        output.unlink(missing_ok=True)
        if request_id and not completed:
            try:
                with httpx.Client(timeout=10) as client:
                    client.post(f"{BASE}/requests/{request_id}/cancel", headers=headers)
            except Exception:
                pass
        raise


def register(app, submit, store, create_project, analyze_job, update):
    def higgsfield_job(item, body):
        output = store.files / f"generated-{uuid.uuid4().hex}.mp4"
        try:
            generate_source(
                body, output, lambda stage, percent: update(item, stage, percent)
            )
            project = create_project(output, "B-roll: " + body["prompt"][:60])
            item["project_id"] = project["id"]
            analyze_job(item, project["id"], body["duration"])
            return {"project_id": project["id"]}
        except httpx.RequestError as exc:
            raise RuntimeError(
                "Could not reach Higgsfield. Check your connection and retry."
            ) from exc
        finally:
            output.unlink(missing_ok=True)

    @app.post("/api/generations")
    def generate(body: GenerationInput):
        if not public_capabilities()["higgsfield"]["configured"]:
            raise HTTPException(
                503,
                "Add HF_API_KEY and HF_API_SECRET to .env and restart to enable Higgsfield.",
            )
        return submit(None, higgsfield_job, body.model_dump())

    return higgsfield_job
