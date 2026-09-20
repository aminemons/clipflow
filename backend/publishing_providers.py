"""Small stdlib HTTP adapters for supported publishing providers.

The adapters intentionally do not retry.  A timeout after a request has been
sent is recorded as ``uncertain`` by the publishing worker so an operator can
check the provider before taking any further action.
"""

from __future__ import annotations

import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping

from .publishing import ProviderDisabled, ProviderError, UncertainPublish


def _request(method: str, url: str, *, headers: Mapping[str, str] | None = None, data: bytes | None = None, form: Mapping[str, Any] | None = None, timeout: int = 45) -> tuple[int, Mapping[str, str], bytes]:
    payload = data
    request_headers = {"User-Agent": "Clipflow local publisher/1.0"}
    request_headers.update(headers or {})
    if form is not None:
        payload = urllib.parse.urlencode({k: str(v) for k, v in form.items()}).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    request = urllib.request.Request(url, data=payload, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as exc:
        body = exc.read() if hasattr(exc, "read") else b""
        if 500 <= int(exc.code) < 600:
            raise UncertainPublish(f"provider returned HTTP {exc.code}; inspect provider before retrying") from exc
        raise ProviderError(f"provider rejected request (HTTP {exc.code})") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise UncertainPublish("network failure may have occurred after provider request; inspect provider before retrying") from exc


def _json(status: int, body: bytes) -> Mapping[str, Any]:
    try:
        value = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise ProviderError(f"provider returned an invalid response (HTTP {status})") from exc
    if not isinstance(value, Mapping):
        raise ProviderError("provider returned an unexpected response")
    return value


class YouTubeProvider:
    """YouTube Data API ``videos.insert`` resumable upload."""

    token_url = "https://oauth2.googleapis.com/token"
    upload_url = "https://www.googleapis.com/upload/youtube/v3/videos"

    def __init__(self, config: Mapping[str, Any]):
        self.config = dict(config)
        self.account_id = str(self.config.get("id") or "")

    def _access_token(self) -> str:
        access = str(self.config.get("access_token") or "").strip()
        if access:
            return access
        refresh = str(self.config.get("refresh_token") or "").strip()
        client_id = str(self.config.get("client_id") or "").strip()
        client_secret = str(self.config.get("client_secret") or "").strip()
        if not (refresh and client_id and client_secret):
            raise ProviderDisabled("YouTube needs an access token or refresh token plus OAuth client id/secret.")
        status, _, body = _request("POST", self.token_url, form={"client_id": client_id, "client_secret": client_secret, "refresh_token": refresh, "grant_type": "refresh_token"})
        value = _json(status, body)
        token = str(value.get("access_token") or "")
        if not token:
            raise ProviderError("YouTube OAuth token refresh did not return an access token.")
        return token

    def publish(self, *, path: str, artifact_url: str, caption: str, privacy: str, target: Mapping[str, Any]) -> Mapping[str, Any]:
        file_path = Path(path)
        if not file_path.is_file():
            raise ProviderError("immutable export artifact is missing")
        token = self._access_token()
        size = file_path.stat().st_size
        title = str(target.get("title") or (caption.strip().splitlines() or [target.get("clip_id", "Clip")])[0])[:100] or "Clipflow clip"
        body = json.dumps({"snippet": {"title": title, "description": caption}, "status": {"privacyStatus": privacy or "private"}}).encode("utf-8")
        init = f"{self.upload_url}?uploadType=resumable&part=snippet,status"
        status, headers, response = _request("POST", init, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": str(size), "X-Upload-Content-Type": mimetypes.guess_type(str(file_path))[0] or "video/mp4"}, data=body)
        location = next((value for key, value in headers.items() if key.lower() == "location"), "")
        parsed_location = urllib.parse.urlsplit(location)
        if not location or parsed_location.scheme != "https" or not parsed_location.hostname or not parsed_location.hostname.lower().endswith(".googleapis.com"):
            raise ProviderError("YouTube did not return a resumable upload URL.")
        with file_path.open("rb") as stream:
            content = stream.read()
        status, _, response = _request("PUT", location, headers={"Authorization": f"Bearer {token}", "Content-Type": "video/mp4", "Content-Length": str(size), "Content-Range": f"bytes 0-{max(0, size - 1)}/{size}"}, data=content)
        result = _json(status, response)
        video_id = str(result.get("id") or "")
        if not video_id:
            raise ProviderError("YouTube upload completed without a video id.")
        return {"remote_id": video_id, "url": f"https://www.youtube.com/watch?v={video_id}", "privacy": privacy or "private", "account_id": self.account_id}


class InstagramProvider:
    """Instagram Graph API two-step Reel container publishing."""

    def __init__(self, config: Mapping[str, Any]):
        self.config = dict(config)
        self.account_id = str(self.config.get("id") or "")

    def publish(self, *, path: str, artifact_url: str, caption: str, privacy: str, target: Mapping[str, Any]) -> Mapping[str, Any]:
        account = str(self.config.get("account_id") or "").strip()
        token = str(self.config.get("access_token") or "").strip()
        base = str(self.config.get("public_base_url") or "").strip().rstrip("/")
        if not (account and token and base):
            raise ProviderDisabled("Instagram needs a professional account id, access token, and HTTPS public_base_url.")
        parsed = urllib.parse.urlsplit(base)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ProviderDisabled("Instagram public_base_url must be an HTTPS URL reachable by Meta.")
        public_url = base + "/" + artifact_url.lstrip("/")
        graph = str(self.config.get("graph_version") or "v21.0")
        url = f"https://graph.facebook.com/{graph}/{urllib.parse.quote(account, safe='')}/media"
        status, _, response = _request("POST", url, form={"media_type": "REELS", "video_url": public_url, "caption": caption, "access_token": token})
        creation_id = str(_json(status, response).get("id") or "")
        if not creation_id:
            raise ProviderError("Instagram did not return a Reel container id.")
        status_url = f"https://graph.facebook.com/{graph}/{urllib.parse.quote(creation_id, safe='')}?fields=status_code&access_token={urllib.parse.quote(token, safe='')}"
        timeout_at = time.monotonic() + float(self.config.get("container_timeout_seconds", 30))
        interval = max(0.0, min(5.0, float(self.config.get("container_poll_seconds", 1))))
        while True:
            check_status, _, check_body = _request("GET", status_url)
            status_code = str(_json(check_status, check_body).get("status_code") or "").upper()
            if status_code == "FINISHED":
                break
            if status_code in {"ERROR", "EXPIRED"}:
                raise ProviderError(f"Instagram Reel container is {status_code.lower()}.")
            if time.monotonic() >= timeout_at:
                raise UncertainPublish("Instagram Reel container is still processing; inspect the account before retrying.")
            time.sleep(interval)
        publish_url = f"https://graph.facebook.com/{graph}/{urllib.parse.quote(account, safe='')}/media_publish"
        status, _, response = _request("POST", publish_url, form={"creation_id": creation_id, "access_token": token})
        media_id = str(_json(status, response).get("id") or "")
        if not media_id:
            raise ProviderError("Instagram did not return a published media id.")
        permalink_url = f"https://graph.facebook.com/{graph}/{urllib.parse.quote(media_id, safe='')}?fields=permalink&access_token={urllib.parse.quote(token, safe='')}"
        permalink_status, _, permalink_body = _request("GET", permalink_url)
        permalink = str(_json(permalink_status, permalink_body).get("permalink") or "")
        return {"remote_id": media_id, "container_id": creation_id, "url": permalink or None, "account_id": self.account_id}


class TikTokProvider:
    """TikTok Content Posting API Direct Post with policy gate."""

    def __init__(self, config: Mapping[str, Any]):
        self.config = dict(config)
        self.account_id = str(self.config.get("id") or "")

    def refresh_status(self, publish_id: str) -> Mapping[str, Any]:
        token = str(self.config.get("access_token") or "").strip()
        if not token or not publish_id:
            raise ProviderDisabled("TikTok status checks need the saved access token and publish id.")
        url = "https://open.tiktokapis.com/v2/post/publish/status/fetch/"
        status, _, body = _request("POST", url, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=UTF-8"}, data=json.dumps({"publish_id": publish_id}).encode("utf-8"))
        data = _json(status, body).get("data")
        state = str(data.get("status") if isinstance(data, Mapping) else "").upper()
        if state == "PUBLISH_COMPLETE":
            return {"status": "succeeded", "publish_id": publish_id, "status_url": url, "account_id": self.account_id}
        if state in {"FAILED", "ERROR"}:
            return {"status": "failed", "publish_id": publish_id, "status_url": url, "account_id": self.account_id}
        return {"status": "processing", "publish_id": publish_id, "status_url": url, "account_id": self.account_id}

    def publish(self, *, path: str, artifact_url: str, caption: str, privacy: str, target: Mapping[str, Any]) -> Mapping[str, Any]:
        token = str(self.config.get("access_token") or "").strip()
        client_key = str(self.config.get("client_key") or "").strip()
        if not token or not client_key:
            raise ProviderDisabled("TikTok needs an access token and client key.")
        if not bool(self.config.get("audit_approved", False)):
            raise ProviderDisabled("TikTok Direct Post is disabled until Content Posting API audit approval; use TikTok's supported upload/manual delivery flow.")
        base = str(self.config.get("public_base_url") or "").strip().rstrip("/")
        if not base or urllib.parse.urlsplit(base).scheme != "https":
            raise ProviderDisabled("TikTok Direct Post needs an HTTPS public_base_url for PULL_FROM_URL, or a separate approved file upload flow.")
        auth = {"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=UTF-8"}
        status, _, response = _request("POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", headers=auth, data=b"{}")
        creator = _json(status, response).get("data")
        if not isinstance(creator, Mapping):
            raise ProviderError("TikTok creator_info did not return creator data.")
        max_duration = creator.get("max_video_post_duration_sec")
        if max_duration is not None and target.get("duration") and float(target["duration"]) > float(max_duration):
            raise ProviderError("TikTok creator_info rejected this clip duration.")
        privacy = privacy or "PUBLIC_TO_EVERYONE"
        allowed_privacy = creator.get("privacy_level_options")
        if isinstance(allowed_privacy, list) and privacy not in {str(item) for item in allowed_privacy}:
            raise ProviderError("TikTok creator settings do not allow the requested privacy level.")
        public_url = base + "/" + str(target.get("artifact_url", artifact_url)).lstrip("/")
        payload = {"post_info": {"title": caption, "privacy_level": privacy, "disable_duet": bool(self.config.get("disable_duet", False) or creator.get("duet_disabled", False)), "disable_comment": bool(self.config.get("disable_comment", False) or creator.get("comment_disabled", False)), "disable_stitch": bool(self.config.get("disable_stitch", False) or creator.get("stitch_disabled", False))}, "source_info": {"source": "PULL_FROM_URL", "video_url": public_url}}
        status, _, response = _request("POST", "https://open.tiktokapis.com/v2/post/publish/video/init/", headers=auth, data=json.dumps(payload).encode("utf-8"))
        result = _json(status, response).get("data")
        if not isinstance(result, Mapping) or not result.get("publish_id"):
            raise ProviderError("TikTok did not return a publish id.")
        publish_id = str(result["publish_id"])
        status_url = "https://open.tiktokapis.com/v2/post/publish/status/fetch/"
        attempts = max(1, min(5, int(self.config.get("status_poll_attempts", 2))))
        for index in range(attempts):
            check_status, _, check_body = _request("POST", status_url, headers=auth, data=json.dumps({"publish_id": publish_id}).encode("utf-8"))
            check_data = _json(check_status, check_body).get("data")
            state = str(check_data.get("status") if isinstance(check_data, Mapping) else "").upper()
            if state == "PUBLISH_COMPLETE":
                return {"publish_id": publish_id, "status_url": status_url, "status": "succeeded", "account_id": self.account_id}
            if state in {"FAILED", "ERROR"}:
                raise ProviderError("TikTok reported that the post failed.")
            if index < attempts - 1:
                time.sleep(max(0.0, min(5.0, float(self.config.get("status_poll_seconds", 1)))))
        return {"publish_id": publish_id, "status_url": status_url, "status": "processing", "account_id": self.account_id}


PROVIDER_CLASSES = {
    "youtube": YouTubeProvider,
    "instagram": InstagramProvider,
    "tiktok": TikTokProvider,
}


__all__ = ["InstagramProvider", "PROVIDER_CLASSES", "TikTokProvider", "YouTubeProvider"]
