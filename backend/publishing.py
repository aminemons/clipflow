"""Human approval and explicit publishing workflow.

Publishing is deliberately kept separate from clip review and export selection.
An approval binds a clip revision to an immutable export snapshot.  A publish
plan binds those approvals to captions/privacy and has to be explicitly
confirmed with the ``PUBLISH`` phrase before any provider is contacted.

The module has no dependency on the application singleton.  ``register`` is
called by the root application with its Store and optionally shared locks or a
provider context.  Network providers live in :mod:`publishing_providers` and
are disabled until the owner supplies credentials.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import secrets
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from .export_artifacts import export_location, export_url
from .store import utc_now
from .config import value


PLATFORMS = ("youtube", "instagram", "tiktok")
PLAN_TTL_SECONDS = 15 * 60
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CONFIRMATION = "PUBLISH"


class PublishingError(RuntimeError):
    """Base class for errors that are safe to show to a local operator."""


class ProviderDisabled(PublishingError):
    """The provider is not configured or is policy-disabled."""


class ProviderError(PublishingError):
    """A provider rejected a request before a post was created."""


class UncertainPublish(PublishingError):
    """The request may have reached a provider; never retry automatically."""


def _safe_id(value: Any, label: str = "identifier") -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise HTTPException(400, f"Invalid {label}.")
    return value


def _iso_after(seconds: int) -> str:
    return datetime.fromtimestamp(time.time() + seconds, timezone.utc).isoformat()


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _account_fingerprint(settings: "PublishingSettings", platform: str, account_id: str | None) -> str:
    """Bind a review plan to the selected account's current credentials/config."""
    account = settings.provider(platform, account_id)
    return _hash(json.dumps(account, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def _atomic_json(path: Path, value: Mapping[str, Any], mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(name)
    try:
        os.chmod(temporary, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        try:
            os.chmod(path, mode)
        except OSError:
            pass
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else copy.deepcopy(default)
    except (OSError, ValueError, TypeError):
        backup = path.with_suffix(path.suffix + ".bak")
        try:
            value = json.loads(backup.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else copy.deepcopy(default)
        except (OSError, ValueError, TypeError):
            return copy.deepcopy(default)


class PublishingState:
    """Atomic state for approvals, plans, and attempts.

    The state file is separate from projects/jobs so a project backup restore
    cannot silently re-enable an old approval or duplicate a post.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.path = self.root / "publishing_state.json"
        self.lock = threading.RLock()
        self.data = _read_json(
            self.path,
            {"version": 1, "approvals": {}, "plans": {}, "attempts": []},
        )
        self.data.setdefault("version", 1)
        self.data.setdefault("approvals", {})
        self.data.setdefault("plans", {})
        self.data.setdefault("attempts", [])
        changed = False
        for attempt in self.data["attempts"]:
            if isinstance(attempt, dict) and attempt.get("status") in {"queued", "running"}:
                attempt.update({"status": "uncertain", "finished_at": utc_now(), "error": "server restarted while publish was in progress; inspect provider before any manual action", "retry_allowed": False})
                changed = True
        if changed:
            self.save()

    def save(self) -> None:
        with self.lock:
            if self.path.exists():
                try:
                    previous = _read_json(self.path, {})
                    if previous:
                        _atomic_json(self.path.with_suffix(self.path.suffix + ".bak"), previous)
                except OSError:
                    pass
            _atomic_json(self.path, self.data)


class PublishingSettings:
    """Write-only provider secrets with safe, account-aware projections.

    The first version of Clipflow stored one mapping per platform.  Accounts
    are now stored under ``accounts`` while the old top-level mapping remains
    as a compatibility shadow for older hosts and callers.  A legacy mapping
    is promoted to ``legacy-{platform}`` on load, so upgrades never discard a
    saved token.
    """

    def __init__(self, root: str | Path):
        self.path = Path(root) / "publishing_settings.json"
        self.lock = threading.RLock()
        self.data = _read_json(self.path, {})
        self._migrate()

    @staticmethod
    def _account_id(platform: str, value: Any) -> str:
        candidate = str(value or "").strip()
        if not candidate:
            return f"legacy-{platform}"
        if not IDENTIFIER.fullmatch(candidate):
            raise ValueError(f"{platform} account id must use letters, numbers, _ or -.")
        return candidate

    def _accounts_from(self, platform: str, raw: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        value = raw if raw is not None else self.data.get(platform, {})
        if not isinstance(value, Mapping):
            return []
        accounts = value.get("accounts")
        if isinstance(accounts, list):
            result = []
            seen: set[str] = set()
            for item in accounts:
                if not isinstance(item, Mapping):
                    continue
                item = dict(item)
                account_id = self._account_id(platform, item.get("id"))
                if account_id in seen:
                    raise ValueError(f"Duplicate {platform} account id: {account_id}")
                seen.add(account_id)
                item["id"] = account_id
                item["label"] = str(item.get("label") or account_id)[:100]
                result.append(item)
            return result
        # A pre-account installation is a valid single account.  Empty
        # settings stay empty so the UI can show an unconfigured provider.
        legacy = {key: value.get(key) for key in _SETTING_KEYS[platform] if key in value}
        if not legacy:
            return []
        legacy["id"] = f"legacy-{platform}"
        legacy["label"] = str(value.get("label") or platform.title())[:100]
        return [legacy]

    def _migrate(self) -> None:
        changed = False
        for platform in PLATFORMS:
            raw = self.data.get(platform)
            if not isinstance(raw, Mapping):
                continue
            accounts = self._accounts_from(platform, raw)
            if accounts and not isinstance(raw.get("accounts"), list):
                updated = dict(raw)
                updated["accounts"] = accounts
                self.data[platform] = updated
                changed = True
        if changed:
            _atomic_json(self.path, self.data)

    def accounts(self, platform: str) -> list[dict[str, Any]]:
        with self.lock:
            return copy.deepcopy(self._accounts_from(platform))

    @staticmethod
    def _validate_value(platform: str, key: str, value: Any) -> None:
        if isinstance(value, str) and len(value) > 20000:
            raise ValueError(f"{platform}.{key} is too long")
        if key in {"enabled", "audit_approved", "disable_duet", "disable_comment", "disable_stitch"} and not isinstance(value, bool):
            raise ValueError(f"{platform}.{key} must be a boolean")
        if key == "privacy_default" and value not in {"private", "unlisted", "public"}:
            raise ValueError("youtube.privacy_default must be private, unlisted, or public")
        if key == "public_base_url":
            parsed = urlsplit(str(value).strip().rstrip("/"))
            if parsed.scheme != "https" or not parsed.netloc:
                raise ValueError(f"{platform}.public_base_url must be an HTTPS URL")

    def _merge_account(self, platform: str, current: Mapping[str, Any], supplied: Mapping[str, Any]) -> dict[str, Any]:
        account = dict(current)
        account_id = self._account_id(platform, supplied.get("id", current.get("id")))
        account["id"] = account_id
        if "label" in supplied:
            label = supplied.get("label")
            if not isinstance(label, str) or not label.strip() or len(label.strip()) > 100:
                raise ValueError(f"{platform}.account label must be 1 to 100 characters")
            account["label"] = label.strip()
        account.setdefault("label", account_id)
        for key, item in supplied.items():
            if key in {"id", "label", "accounts"} or key not in _SETTING_KEYS[platform]:
                continue
            if key in _SECRET_KEYS[platform] and item in (None, "", "********"):
                continue
            self._validate_value(platform, key, item)
            account[key] = item
        return account

    def save(self, supplied: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(supplied, Mapping):
            raise ValueError("settings must be an object")
        allowed = set(PLATFORMS)
        incoming = {name: supplied[name] for name in allowed if name in supplied}
        with self.lock:
            updated = copy.deepcopy(self.data)
            for platform, raw in incoming.items():
                if raw is None:
                    continue
                if not isinstance(raw, Mapping):
                    raise ValueError(f"{platform} settings must be an object")
                existing = self._accounts_from(platform, updated.get(platform, {}))
                if "accounts" in raw:
                    supplied_accounts = raw.get("accounts")
                    if not isinstance(supplied_accounts, list):
                        raise ValueError(f"{platform}.accounts must be a list")
                    by_id = {str(item.get("id")): item for item in existing}
                    accounts = []
                    seen: set[str] = set()
                    for item in supplied_accounts:
                        if not isinstance(item, Mapping):
                            raise ValueError(f"{platform} account must be an object")
                        account_id = self._account_id(platform, item.get("id"))
                        if account_id in seen:
                            raise ValueError(f"Duplicate {platform} account id: {account_id}")
                        seen.add(account_id)
                        accounts.append(self._merge_account(platform, by_id.get(account_id, {}), item))
                else:
                    current = existing[0] if existing else {"id": f"legacy-{platform}", "label": platform.title()}
                    accounts = [self._merge_account(platform, current, raw)]
                # Keep the first account mirrored at the old top level.  This
                # lets older embedded clients continue to read provider().
                if accounts:
                    first = dict(accounts[0])
                    shadow = {key: value for key, value in first.items() if key not in {"id", "label"}}
                    shadow["accounts"] = accounts
                    updated[platform] = shadow
                else:
                    updated[platform] = {"accounts": []}
            _atomic_json(self.path, updated)
            self.data = updated
        return self.public()

    def public(self) -> dict[str, Any]:
        with self.lock:
            result: dict[str, Any] = {"providers": {}, "notes": PROVIDER_NOTES}
            for platform in PLATFORMS:
                accounts = self._accounts_from(platform)
                raw = accounts[0] if accounts else {}
                projection = self._public_account(platform, raw)
                projection["accounts"] = [self._public_account(platform, account) for account in accounts]
                result["providers"][platform] = projection
            return result

    def _public_account(self, platform: str, raw: Mapping[str, Any]) -> dict[str, Any]:
        projection: dict[str, Any] = {
            "id": str(raw.get("id") or ""),
            "label": str(raw.get("label") or raw.get("id") or platform.title()),
            "enabled": bool(raw.get("enabled", False)),
            "configured": self._configured_raw(platform, raw),
            "status": "ready" if bool(raw.get("enabled", False)) and self._configured_raw(platform, raw) else ("disabled" if self._configured_raw(platform, raw) else "not_configured"),
        }
        for key in _SECRET_KEYS[platform]:
            projection[f"has_{key}"] = bool(raw.get(key))
        if platform == "instagram":
            projection["public_base_url_configured"] = bool(raw.get("public_base_url"))
            projection["account_id"] = str(raw.get("account_id") or "")
            projection["public_base_url"] = str(raw.get("public_base_url") or "")
        if platform == "youtube":
            projection["privacy_default"] = str(raw.get("privacy_default", "private"))
        if platform == "tiktok":
            projection["audit_approved"] = bool(raw.get("audit_approved", False))
            projection["public_base_url_configured"] = bool(raw.get("public_base_url"))
            projection["public_base_url"] = str(raw.get("public_base_url") or "")
            projection["disable_duet"] = bool(raw.get("disable_duet", False))
            projection["disable_comment"] = bool(raw.get("disable_comment", False))
            projection["disable_stitch"] = bool(raw.get("disable_stitch", False))
        return projection

    def _configured_raw(self, platform: str, raw: Mapping[str, Any]) -> bool:
        if platform == "youtube":
            return bool(raw.get("access_token") or (raw.get("refresh_token") and raw.get("client_id") and raw.get("client_secret")))
        if platform == "instagram":
            return bool(raw.get("account_id") and raw.get("access_token") and raw.get("public_base_url"))
        if platform == "tiktok":
            return bool(raw.get("access_token") and raw.get("client_key"))
        return False

    def configured(self, platform: str, account_id: str | None = None) -> bool:
        accounts = self.accounts(platform)
        if account_id is None:
            return any(self._configured_raw(platform, account) for account in accounts)
        account = next((item for item in accounts if item.get("id") == account_id), None)
        return bool(account and self._configured_raw(platform, account))

    def provider(self, platform: str, account_id: str | None = None) -> dict[str, Any]:
        accounts = self.accounts(platform)
        if account_id is None:
            raw = accounts[0] if accounts else None
        else:
            raw = next((item for item in accounts if item.get("id") == account_id), None)
        return dict(raw or {})


_SECRET_KEYS = {
    "youtube": {"access_token", "refresh_token", "client_id", "client_secret"},
    "instagram": {"access_token"},
    "tiktok": {"access_token", "client_key"},
}
_SETTING_KEYS = {
    "youtube": _SECRET_KEYS["youtube"] | {"enabled", "privacy_default"},
    "instagram": _SECRET_KEYS["instagram"] | {"enabled", "account_id", "public_base_url"},
    "tiktok": _SECRET_KEYS["tiktok"] | {"enabled", "audit_approved", "public_base_url", "disable_duet", "disable_comment", "disable_stitch"},
}
PROVIDER_NOTES = {
    "youtube": "OAuth access or refresh token with youtube.upload; videos.insert uses a resumable upload and the requested privacy status.",
    "instagram": "Professional Instagram account linked to a Facebook Page, publishing permission, and HTTPS public_base_url reachable by Meta for video_url.",
    "tiktok": "Direct Post requires Content Posting API approval/audit and video.publish scope. Before audit, use TikTok's supported upload or manual delivery flow; this app never fakes a post.",
}


def _artifact_for(store: Any, project_id: str, clip: Mapping[str, Any]) -> dict[str, Any] | None:
    clip_id = clip.get("id")
    url = clip.get("download_url")
    if not isinstance(clip_id, str) or not isinstance(url, str):
        return None
    match = re.fullmatch(
        rf"/api/projects/{re.escape(project_id)}/exports/([A-Za-z0-9_-]{{1,64}})/{re.escape(clip_id)}/download",
        url,
    )
    if not match or clip.get("status") != "exported":
        return None
    job_id = match.group(1)
    try:
        path = export_location(store, project_id, job_id, clip_id)
        root = Path(store.files).resolve()
        if path.resolve().relative_to(root) is None or not path.is_file():
            return None
        return {
            "url": export_url(project_id, job_id, clip_id),
            "job_id": job_id,
            "path": str(path.resolve()),
            "size": path.stat().st_size,
        }
    except (ValueError, OSError):
        return None


def _provider_for(platform: str, settings: PublishingSettings, context: Any = None, account_id: str | None = None):
    # Tests and embedding applications can inject a provider without changing
    # credentials or contacting an external service.
    if isinstance(context, Mapping):
        providers = context.get("providers")
        if isinstance(providers, Mapping):
            candidate = providers.get(f"{platform}:{account_id}")
            if candidate is None:
                candidate = providers.get(platform)
            if isinstance(candidate, Mapping):
                candidate = candidate.get(account_id) or candidate.get("default")
            if candidate is None:
                candidate = None
            if candidate is not None:
                config = settings.provider(platform, account_id)
                if callable(candidate) and not hasattr(candidate, "publish"):
                    return candidate(config)
                return candidate
    from .publishing_providers import PROVIDER_CLASSES
    cls = PROVIDER_CLASSES[platform]
    return cls(settings.provider(platform, account_id))


def _requested_platforms(body: Mapping[str, Any]) -> list[str]:
    raw = body.get("platforms", [])
    if isinstance(raw, Mapping):
        values = list(raw.keys())
    elif isinstance(raw, list):
        values = raw
    else:
        raise HTTPException(400, "platforms must be a list or object")
    out: list[str] = []
    for value in values:
        if value not in PLATFORMS:
            raise HTTPException(400, f"Unsupported publishing platform: {value}")
        if value not in out:
            out.append(value)
    if not out:
        raise HTTPException(400, "Choose at least one publishing platform.")
    return out


def _requested_destinations(body: Mapping[str, Any], settings: PublishingSettings) -> list[dict[str, str]]:
    """Normalize the multi-account destination contract and old platform list."""
    raw = body.get("destinations")
    if raw is None:
        result = []
        for platform in _requested_platforms(body):
            accounts = settings.accounts(platform)
            if not accounts:
                raise HTTPException(409, f"No {platform} publishing account is configured.")
            result.append({"platform": platform, "account_id": str(accounts[0].get("id"))})
        return result
    if isinstance(raw, Mapping):
        expanded: list[dict[str, Any]] = []
        for platform, account_ids in raw.items():
            values = account_ids if isinstance(account_ids, list) else [account_ids]
            expanded.extend({"platform": platform, "account_id": account_id} for account_id in values)
        raw = expanded
    if not isinstance(raw, list):
        raise HTTPException(400, "destinations must be a list")
    result: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in raw:
        if isinstance(item, str):
            if ":" not in item:
                raise HTTPException(400, "Each destination needs a platform and account_id.")
            platform, account_id = item.split(":", 1)
        elif isinstance(item, Mapping):
            platform = item.get("platform")
            account_id = item.get("account_id", item.get("id"))
        else:
            raise HTTPException(400, "Each destination must be an object.")
        if platform not in PLATFORMS:
            raise HTTPException(400, f"Unsupported publishing platform: {platform}")
        if not isinstance(account_id, str) or not IDENTIFIER.fullmatch(account_id):
            raise HTTPException(400, "Each destination needs a valid account_id.")
        account = next((row for row in settings.accounts(platform) if row.get("id") == account_id), None)
        if account is None:
            raise HTTPException(400, f"Unknown {platform} publishing account: {account_id}")
        key = (str(platform), account_id)
        if key not in seen:
            seen.add(key)
            result.append({"platform": str(platform), "account_id": account_id})
    if not result:
        raise HTTPException(400, "Choose at least one publishing destination.")
    return result


def _caption_for(body: Mapping[str, Any], platform: str, clip: Mapping[str, Any], account_id: str | None = None) -> str:
    captions = body.get("captions", {})
    value: Any = ""
    if isinstance(captions, Mapping):
        platform_value = captions.get(platform, "")
        if isinstance(platform_value, Mapping):
            account_value = platform_value.get(account_id, platform_value) if account_id else platform_value
            if isinstance(account_value, Mapping):
                value = account_value.get(str(clip.get("id")), account_value.get("default", ""))
            else:
                value = account_value
        else:
            value = platform_value
    if not value and isinstance(body.get("caption"), str):
        value = body.get("caption")
    if not value:
        value = clip.get("caption_text", "") or clip.get("title", "")
    if not isinstance(value, str) or len(value) > 5000:
        raise HTTPException(400, f"Caption for {platform} is invalid or too long.")
    return value


def _privacy_for(body: Mapping[str, Any], platform: str, settings: PublishingSettings, account_id: str | None = None) -> str:
    raw = body.get("privacy", {})
    value: Any = raw.get(platform) if isinstance(raw, Mapping) else raw
    if isinstance(value, Mapping):
        value = value.get(account_id, value.get("default", "")) if account_id else value.get("default", "")
    if value is None or value == "":
        value = settings.provider(platform, account_id).get("privacy_default", "private") if platform == "youtube" else ""
    if platform == "youtube":
        if value not in {"private", "unlisted", "public"}:
            raise HTTPException(400, "YouTube privacy must be private, unlisted, or public.")
        return str(value)
    return str(value or "")


def register(app: Any, store: Any, locks: Any = None, context: Any = None) -> dict[str, Any]:
    """Register publishing routes and return the service context.

    ``context`` may contain ``providers`` for deterministic integration tests.
    The returned dictionary is also useful to a host UI for service status.
    """
    def store_value():
        return store() if callable(store) else store

    root = Path(store_value().root)
    state = PublishingState(root)
    settings = PublishingSettings(root)
    local_lock = threading.RLock()
    if isinstance(locks, Mapping) and locks.get("publishing") is not None:
        local_lock = locks["publishing"]
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="clipflow-publish")
    service = {"state": state, "settings": settings, "executor": executor}

    def check_origin(request: Request) -> None:
        """Reject browser cross-site mutations in local mode.

        Hosted mode's middleware performs owner/session and exact-origin checks
        before this router. Requests without an Origin (CLI/local TestClient)
        remain valid.
        """
        if value("CLIPFLOW_MODE", "local").lower() == "hosted":
            from .hosting import require_hosted_owner
            require_hosted_owner(request)
            return
        # Starlette's default TestClient host is ``testserver``; allow that
        # synthetic host only when no browser Origin is present.
        origin = request.headers.get("origin")
        if request.url.hostname not in {"127.0.0.1", "localhost", "::1"} and not (request.url.hostname == "testserver" and not origin):
            raise HTTPException(403, "Open publishing controls from the Clipflow editor.")
        if not origin:
            return
        parsed = urlsplit(origin)
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.scheme not in {"http", "https"} or parsed.port not in {request.url.port, 5173}:
            raise HTTPException(403, "Open publishing controls from the Clipflow editor.")

    def project_or_404(project_id: str) -> dict[str, Any]:
        _safe_id(project_id, "project identifier")
        project = store_value().get(project_id)
        if not project:
            raise HTTPException(404, "project not found")
        return project

    def approval_rows(project_id: str, project: Mapping[str, Any]) -> list[dict[str, Any]]:
        with local_lock:
            rows = state.data["approvals"].get(project_id, {})
            if not isinstance(rows, Mapping):
                return []
            result = []
            for clip in project.get("clips", []):
                if not isinstance(clip, Mapping) or clip.get("id") not in rows:
                    continue
                if not isinstance(rows[clip["id"]], Mapping):
                    continue
                row = dict(rows[clip["id"]])
                artifact = _artifact_for(store_value(), project_id, clip)
                row.update({"clip_id": clip["id"], "current_revision": int(clip.get("revision", 1)), "valid": bool(artifact and row.get("revision") == int(clip.get("revision", 1)) and row.get("artifact_url") == artifact["url"]), "artifact_url": artifact["url"] if artifact else None})
                result.append(row)
            return result

    @app.get("/api/publishing/settings")
    def get_publishing_settings():
        return settings.public()

    @app.put("/api/publishing/settings")
    def put_publishing_settings(body: dict[str, Any], request: Request):
        check_origin(request)
        try:
            return settings.save(body)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(500, "Could not save publishing settings.") from exc

    @app.post("/api/projects/{project_id}/approvals")
    def approve_clips(project_id: str, body: dict[str, Any], request: Request):
        check_origin(request)
        project = project_or_404(project_id)
        clip_ids = body.get("clip_ids") if isinstance(body, Mapping) else None
        if not isinstance(clip_ids, list) or not clip_ids:
            raise HTTPException(400, "clip_ids must contain at least one clip.")
        clips = {str(c.get("id")): c for c in project.get("clips", []) if isinstance(c, Mapping)}
        approved: dict[str, Any] = {}
        action = body.get("action", "approve")
        if action not in {"approve", "revoke"}:
            raise HTTPException(400, "action must be approve or revoke")
        with local_lock:
            project_rows = state.data["approvals"].setdefault(project_id, {})
            if action == "revoke":
                normalized = [_safe_id(raw_id, "clip identifier") for raw_id in clip_ids]
                for clip_id in normalized:
                    project_rows.pop(clip_id, None)
                state.save()
                return {"project_id": project_id, "revoked": normalized, "approvals": approval_rows(project_id, project)}
            candidates: list[tuple[str, Mapping[str, Any], dict[str, Any]]] = []
            for raw_id in clip_ids:
                clip_id = _safe_id(raw_id, "clip identifier")
                clip = clips.get(clip_id)
                artifact = _artifact_for(store_value(), project_id, clip or {})
                if not clip or not artifact:
                    raise HTTPException(409, f"Clip {clip_id} needs a completed export before approval.")
                candidates.append((clip_id, clip, artifact))
            # Validate every member before changing any row in a bulk request.
            for clip_id, clip, artifact in candidates:
                revision = int(clip.get("revision", 1))
                row = {"clip_id": clip_id, "revision": revision, "artifact_url": artifact["url"], "artifact_job_id": artifact["job_id"], "approved_at": utc_now(), "status": "approved"}
                project_rows[clip_id] = row
                approved[clip_id] = row
            state.save()
        return {"project_id": project_id, "approved": list(approved.values()), "approvals": approval_rows(project_id, project)}

    @app.get("/api/projects/{project_id}/approvals")
    def get_approvals(project_id: str):
        project = project_or_404(project_id)
        return {"project_id": project_id, "approvals": approval_rows(project_id, project)}

    @app.post("/api/projects/{project_id}/publish/prepare")
    def prepare_publish(project_id: str, body: dict[str, Any], request: Request):
        check_origin(request)
        project = project_or_404(project_id)
        destinations = _requested_destinations(body, settings)
        clip_ids = body.get("clip_ids")
        if not isinstance(clip_ids, list) or not clip_ids:
            raise HTTPException(400, "clip_ids must contain at least one approved clip.")
        clip_ids = list(dict.fromkeys(clip_ids))
        clips = {str(c.get("id")): c for c in project.get("clips", []) if isinstance(c, Mapping)}
        targets: list[dict[str, Any]] = []
        blockers: list[dict[str, str]] = []
        with local_lock:
            approvals = state.data["approvals"].get(project_id, {})
            for raw_id in clip_ids:
                clip_id = _safe_id(raw_id, "clip identifier")
                clip = clips.get(clip_id)
                approval = approvals.get(clip_id) if isinstance(approvals, Mapping) else None
                artifact = _artifact_for(store_value(), project_id, clip or {})
                if not clip or not isinstance(approval, Mapping) or approval.get("status") != "approved":
                    blockers.append({"clip_id": clip_id, "reason": "clip is not human-approved"})
                    continue
                if int(approval.get("revision", -1)) != int(clip.get("revision", 1)) or approval.get("artifact_url") != (artifact or {}).get("url") or not artifact:
                    blockers.append({"clip_id": clip_id, "reason": "approval or immutable export is stale"})
                    continue
                for destination in destinations:
                    platform = destination["platform"]
                    account_id = destination["account_id"]
                    account = settings.provider(platform, account_id)
                    titles = body.get("titles", {})
                    title = titles.get(clip_id, clip.get("title", "Clip")) if isinstance(titles, Mapping) else clip.get("title", "Clip")
                    targets.append({"platform": platform, "account_id": account_id, "account_label": str(account.get("label") or account_id), "account_fingerprint": _account_fingerprint(settings, platform, account_id), "revision": int(clip.get("revision", 1)), "duration": max(0.0, float(clip.get("end", 0)) - float(clip.get("start", 0))), "artifact_url": artifact["url"], "artifact_job_id": artifact["job_id"], "artifact_path": artifact["path"], "title": str(title)[:100], "caption": _caption_for(body, platform, clip, account_id), "privacy": _privacy_for(body, platform, settings, account_id), "clip_id": clip_id})
            if blockers:
                raise HTTPException(409, {"message": "Every requested clip must have a current approval and completed immutable export.", "blockers": blockers})
            token = secrets.token_urlsafe(32)
            plan_id = uuid.uuid4().hex
            plan = {"plan_id": plan_id, "token_hash": _hash(token), "project_id": project_id, "created_at": utc_now(), "expires_at": _iso_after(PLAN_TTL_SECONDS), "status": "pending", "targets": targets, "destinations": destinations, "platforms": list(dict.fromkeys(item["platform"] for item in destinations))}
            state.data["plans"][plan_id] = plan
            state.save()
        # Keep the token only as a hash on disk. It must be supplied with the
        # explicit confirmation request and is never logged or returned again.
        review_targets = [{k: v for k, v in target.items() if k != "artifact_path"} for target in targets]
        return {"plan_id": plan_id, "confirmation_token": token, "expires_at": plan["expires_at"], "status": "pending", "targets": review_targets, "destinations": destinations, "platforms": plan["platforms"], "provider_settings": settings.public()}

    def run_attempt(attempt_id: str, plan: dict[str, Any], target: dict[str, Any]):
        with local_lock:
            attempt = next((a for a in state.data["attempts"] if a.get("attempt_id") == attempt_id), None)
            if not attempt or attempt.get("status") != "queued":
                return
            attempt.update({"status": "running", "started_at": utc_now()})
            state.save()
        try:
            account_id = str(target.get("account_id") or "") or None
            account_config = settings.provider(target["platform"], account_id)
            if target.get("account_fingerprint") and target["account_fingerprint"] != _account_fingerprint(settings, target["platform"], account_id):
                raise ProviderError("publishing account changed after confirmation; no post was sent")
            if not account_config.get("enabled", False) or not settings.configured(target["platform"], account_id):
                raise ProviderDisabled(f"{target['platform']} publishing account is disabled or not configured")
            provider = _provider_for(target["platform"], settings, context, account_id)
            # A provider factory can perform setup, so bind again at the call
            # boundary. This keeps a rotation between queueing and network I/O
            # from sending with a stale or redirected account.
            if target.get("account_fingerprint") and target["account_fingerprint"] != _account_fingerprint(settings, target["platform"], account_id):
                raise ProviderError("publishing account changed before provider call; no post was sent")
            result = provider.publish(path=target["artifact_path"], artifact_url=target["artifact_url"], caption=target["caption"], privacy=target["privacy"], target=target)
            if not isinstance(result, Mapping):
                result = {"provider_result": str(result)}
            with local_lock:
                final_status = "processing" if result.get("status") in {"processing", "pending"} else "succeeded"
                attempt.update({"status": final_status, "finished_at": utc_now(), "result": dict(result)})
                state.save()
        except UncertainPublish as exc:
            with local_lock:
                attempt.update({"status": "uncertain", "finished_at": utc_now(), "error": str(exc), "retry_allowed": False})
                state.save()
        except ProviderDisabled as exc:
            with local_lock:
                attempt.update({"status": "disabled", "finished_at": utc_now(), "error": str(exc), "retry_allowed": False})
                state.save()
        except Exception as exc:
            with local_lock:
                attempt.update({"status": "failed", "finished_at": utc_now(), "error": str(exc)[:2000], "retry_allowed": False})
                state.save()

    @app.post("/api/publishing/confirm")
    def confirm_publish(body: dict[str, Any], request: Request):
        check_origin(request)
        if not isinstance(body, Mapping) or body.get("confirmation") != CONFIRMATION:
            raise HTTPException(400, 'Explicit confirmation must be exactly "PUBLISH".')
        plan_id = body.get("plan_id")
        if not isinstance(plan_id, str) or not IDENTIFIER.fullmatch(plan_id):
            raise HTTPException(400, "Invalid plan_id.")
        with local_lock:
            plan = state.data["plans"].get(plan_id)
            if not isinstance(plan, dict):
                raise HTTPException(404, "publish plan not found")
            supplied_token = body.get("confirmation_token")
            if not isinstance(supplied_token, str) or not secrets.compare_digest(_hash(supplied_token), str(plan.get("token_hash", ""))):
                raise HTTPException(403, "confirmation token is invalid")
            if plan.get("status") != "pending":
                raise HTTPException(409, "publish plan was already confirmed or is no longer active")
            if time.time() > datetime.fromisoformat(str(plan.get("expires_at")).replace("Z", "+00:00")).timestamp():
                plan["status"] = "expired"
                state.save()
                raise HTTPException(410, "publish plan expired; prepare a new plan")
            project = project_or_404(str(plan.get("project_id")))
            clips = {str(c.get("id")): c for c in project.get("clips", []) if isinstance(c, Mapping)}
            for target in plan.get("targets", []):
                clip = clips.get(target.get("clip_id"), {})
                approval_rows_for_project = state.data["approvals"].get(plan["project_id"], {})
                approval = approval_rows_for_project.get(target.get("clip_id"), {}) if isinstance(approval_rows_for_project, Mapping) else {}
                artifact = _artifact_for(store_value(), plan["project_id"], clip)
                if int(clip.get("revision", -1)) != int(target.get("revision", -2)) or approval.get("status") != "approved" or int(approval.get("revision", -1)) != int(target.get("revision", -2)) or not artifact or artifact["url"] != target.get("artifact_url"):
                    raise HTTPException(409, "A clip or export changed after review; prepare a new publish plan.")
                account_id = str(target.get("account_id") or "") or None
                provider_config = settings.provider(target["platform"], account_id)
                if target.get("account_fingerprint") and target["account_fingerprint"] != _account_fingerprint(settings, target["platform"], account_id):
                    raise HTTPException(409, "A publishing account changed after review; prepare a new publishing plan.")
                if not provider_config.get("enabled", False) or not settings.configured(target["platform"], account_id):
                    if target["platform"] == "tiktok" and not provider_config.get("audit_approved", False):
                        reason = PROVIDER_NOTES["tiktok"]
                    else:
                        reason = f"{target['platform']} account {target.get('account_label') or account_id or 'default'} is disabled or not configured"
                    raise HTTPException(409, reason)
                if target["platform"] == "tiktok" and not provider_config.get("audit_approved", False):
                    raise HTTPException(409, PROVIDER_NOTES["tiktok"])
            plan["status"] = "confirmed"
            plan["confirmed_at"] = utc_now()
            attempts = []
            for target in plan["targets"]:
                attempt_id = uuid.uuid4().hex
                attempt = {"attempt_id": attempt_id, "plan_id": plan_id, "project_id": plan["project_id"], "platform": target["platform"], "account_id": target.get("account_id"), "account_label": target.get("account_label"), "clip_id": target["clip_id"], "revision": target["revision"], "artifact_url": target["artifact_url"], "status": "queued", "created_at": utc_now(), "retry_allowed": False}
                state.data["attempts"].append(attempt)
                attempts.append(attempt)
            state.save()
        for target, attempt in zip(plan["targets"], attempts):
            executor.submit(run_attempt, attempt["attempt_id"], copy.deepcopy(plan), copy.deepcopy(target))
        return {"plan_id": plan_id, "status": "confirmed", "attempts": attempts}

    @app.get("/api/publishing/history")
    def publishing_history(project_id: str | None = None):
        with local_lock:
            rows = copy.deepcopy(state.data.get("attempts", []))
        if project_id:
            _safe_id(project_id, "project identifier")
            rows = [row for row in rows if row.get("project_id") == project_id]
        return {"attempts": rows}

    @app.post("/api/publishing/history/{attempt_id}/refresh")
    def refresh_publishing_attempt(attempt_id: str, request: Request):
        check_origin(request)
        _safe_id(attempt_id, "attempt identifier")
        with local_lock:
            attempt = next((row for row in state.data.get("attempts", []) if row.get("attempt_id") == attempt_id), None)
            if not isinstance(attempt, dict):
                raise HTTPException(404, "publishing attempt not found")
            if attempt.get("platform") != "tiktok" or attempt.get("status") not in {"processing", "uncertain"}:
                raise HTTPException(409, "Only an active TikTok attempt can be refreshed.")
            publish_id = (attempt.get("result") or {}).get("publish_id")
            if not publish_id:
                raise HTTPException(409, "This attempt has no provider status id.")
        try:
            result = _provider_for("tiktok", settings, context, attempt.get("account_id")).refresh_status(str(publish_id))
        except UncertainPublish as exc:
            with local_lock:
                attempt.update({"status": "uncertain", "error": str(exc), "retry_allowed": False, "updated_at": utc_now()})
                state.save()
            return copy.deepcopy(attempt)
        except ProviderDisabled as exc:
            raise HTTPException(409, str(exc)) from exc
        with local_lock:
            attempt.update({"status": result.get("status", "processing"), "result": {**(attempt.get("result") or {}), **dict(result)}, "updated_at": utc_now()})
            state.save()
            return copy.deepcopy(attempt)

    return service


__all__ = [
    "CONFIRMATION",
    "PLATFORMS",
    "ProviderDisabled",
    "ProviderError",
    "PublishingError",
    "UncertainPublish",
    "register",
]
