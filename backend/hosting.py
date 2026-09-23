"""Owner-only hosted mode security for the Clipflow API.

Local mode deliberately has no account dependency.  The root application can
call :func:`install_hosted_security` when ``CLIPFLOW_MODE=hosted`` to add the
small auth router and the request gate.  Hosted mode is intentionally a single
owner workspace; it is not a multi-tenant authorization layer.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import threading
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field


class HostedConfigurationError(RuntimeError):
    """Raised when hosted mode is enabled without its security settings."""


@dataclass(frozen=True)
class HostedConfig:
    mode: str
    public_origin: str = ""
    supabase_url: str = ""
    supabase_publishable_key: str = ""
    owner_id: str = ""
    session_ttl_seconds: int = 8 * 60 * 60
    worker_origin: str = ""

    @property
    def hosted(self) -> bool:
        return self.mode == "hosted"

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "HostedConfig":
        env = os.environ if environ is None else environ
        mode = env.get("CLIPFLOW_MODE", "local").strip().lower() or "local"
        if mode not in {"local", "hosted"}:
            raise HostedConfigurationError("CLIPFLOW_MODE must be 'local' or 'hosted'.")
        if mode == "local":
            return cls(mode="local")

        origin = env.get("CLIPFLOW_PUBLIC_ORIGIN", "").strip().rstrip("/")
        parsed_origin = urlsplit(origin)
        if (
            not origin
            or parsed_origin.scheme != "https"
            or not parsed_origin.netloc
            or parsed_origin.username is not None
            or parsed_origin.password is not None
            or parsed_origin.path not in {"", "/"}
            or parsed_origin.query
            or parsed_origin.fragment
        ):
            raise HostedConfigurationError(
                "Hosted mode requires CLIPFLOW_PUBLIC_ORIGIN to be an HTTPS origin."
            )

        worker_origin = env.get("CLIPFLOW_WORKER_ORIGIN", "").strip().rstrip("/")
        parsed_worker = urlsplit(worker_origin)
        if worker_origin and (
            parsed_worker.scheme != "https" or not parsed_worker.netloc
            or parsed_worker.username is not None or parsed_worker.password is not None
            or parsed_worker.path not in {"", "/"} or parsed_worker.query or parsed_worker.fragment
        ):
            raise HostedConfigurationError("CLIPFLOW_WORKER_ORIGIN must be an HTTPS origin.")

        supabase_url = env.get("SUPABASE_URL", "").strip().rstrip("/")
        parsed_supabase = urlsplit(supabase_url)
        if (
            not supabase_url
            or parsed_supabase.scheme != "https"
            or not parsed_supabase.netloc
            or parsed_supabase.username is not None
            or parsed_supabase.password is not None
            or parsed_supabase.path not in {"", "/"}
            or parsed_supabase.query
            or parsed_supabase.fragment
        ):
            raise HostedConfigurationError(
                "Hosted mode requires an HTTPS SUPABASE_URL."
            )

        # Supabase calls this the publishable key.  SUPABASE_ANON_KEY is
        # accepted as a compatibility alias for existing projects, but the
        # value is still sent only to Supabase and never returned to clients.
        publishable_key = (
            env.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
            or env.get("SUPABASE_ANON_KEY", "").strip()
        )
        owner_id = env.get("CLIPFLOW_OWNER_ID", "").strip()
        if not publishable_key:
            raise HostedConfigurationError(
                "Hosted mode requires SUPABASE_PUBLISHABLE_KEY."
            )
        if not owner_id:
            raise HostedConfigurationError("Hosted mode requires CLIPFLOW_OWNER_ID.")

        raw_ttl = env.get("CLIPFLOW_SESSION_TTL_SECONDS", str(8 * 60 * 60))
        try:
            ttl = int(raw_ttl)
        except (TypeError, ValueError) as exc:
            raise HostedConfigurationError(
                "CLIPFLOW_SESSION_TTL_SECONDS must be an integer."
            ) from exc
        if not 300 <= ttl <= 7 * 24 * 60 * 60:
            raise HostedConfigurationError(
                "CLIPFLOW_SESSION_TTL_SECONDS must be between 300 and 604800."
            )
        return cls(
            mode=mode,
            public_origin=origin,
            supabase_url=supabase_url,
            supabase_publishable_key=publishable_key,
            owner_id=owner_id,
            session_ttl_seconds=ttl,
            worker_origin=worker_origin,
        )


@dataclass(frozen=True)
class Session:
    user_id: str
    expires_at: float


class SessionStore:
    """In-memory server-side store for opaque, expiring session cookies."""

    def __init__(self, now: Callable[[], float] = time.time) -> None:
        self._now = now
        self._items: dict[str, Session] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def create(self, user_id: str, ttl_seconds: int) -> tuple[str, Session]:
        token = secrets.token_urlsafe(32)
        session = Session(user_id=user_id, expires_at=self._now() + ttl_seconds)
        with self._lock:
            self._purge_locked()
            self._items[self._digest(token)] = session
        return token, session

    def get(self, token: str | None) -> Session | None:
        if not token:
            return None
        with self._lock:
            self._purge_locked()
            return self._items.get(self._digest(token))

    def revoke(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._items.pop(self._digest(token), None)

    def _purge_locked(self) -> None:
        now = self._now()
        self._items = {
            token: session
            for token, session in self._items.items()
            if session.expires_at > now
        }


class SupabaseAuthClientProtocol(Protocol):
    async def password_sign_in(self, email: str, password: str) -> Mapping[str, Any] | None:
        ...


class SupabaseAuthClient:
    """Minimal REST client for Supabase password authentication."""

    def __init__(self, config: HostedConfig) -> None:
        self.config = config

    async def password_sign_in(self, email: str, password: str) -> Mapping[str, Any] | None:
        # Keep the password in the request body only.  Never log this payload.
        url = f"{self.config.supabase_url}/auth/v1/token?grant_type=password"
        headers = {
            "apikey": self.config.supabase_publishable_key,
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                url,
                headers=headers,
                json={"email": email, "password": password},
            )
        if response.status_code != 200:
            return None
        try:
            payload = response.json()
        except ValueError:
            return None
        return payload if isinstance(payload, Mapping) else None


class LoginPayload(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=4096)


class LoginRateLimiter:
    """Small fixed-window limiter for the password endpoint."""

    def __init__(
        self,
        limit: int = 5,
        window_seconds: int = 60,
        global_limit: int = 100,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.global_limit = global_limit
        self._now = now
        self._attempts: dict[str, list[float]] = {}
        self._lock = threading.RLock()

    def check(self, key: str) -> tuple[bool, int]:
        now = self._now()
        with self._lock:
            keys = ((key, self.limit), ("__global__", self.global_limit))
            refreshed: dict[str, list[float]] = {}
            allowed = True
            retry_after = 1
            for bucket, bucket_limit in keys:
                attempts = [
                    stamp
                    for stamp in self._attempts.get(bucket, [])
                    if stamp > now - self.window_seconds
                ]
                refreshed[bucket] = attempts
                if len(attempts) >= bucket_limit:
                    allowed = False
                    retry_after = max(1, int(self.window_seconds - (now - attempts[0])))
            # Count a request in both the peer and global buckets.  The peer
            # key comes from the socket address, never from a client supplied
            # X-Forwarded-For header.
            for bucket, attempts in refreshed.items():
                if allowed:
                    attempts.append(now)
                self._attempts[bucket] = attempts
            return allowed, retry_after


class HostedAuthService:
    def __init__(self, config: HostedConfig, client: SupabaseAuthClientProtocol | None = None) -> None:
        self.config = config
        self.client = client or SupabaseAuthClient(config)

    async def sign_in_owner(self, email: str, password: str) -> bool:
        payload = await self.client.password_sign_in(email, password)
        user = payload.get("user") if payload else None
        user_id = user.get("id") if isinstance(user, Mapping) else None
        return isinstance(user_id, str) and secrets.compare_digest(user_id, self.config.owner_id)


def _client_key(request: Request) -> str:
    # A client supplied X-Forwarded-For value is spoofable.  The direct peer
    # bucket is therefore always enforced; the limiter also has a global cap.
    return request.client.host if request.client else "unknown"


def _origin_is_allowed(request: Request, config: HostedConfig) -> bool:
    return request.headers.get("origin", "") == config.public_origin


def _set_session_cookie(response: Response, token: str, ttl_seconds: int) -> None:
    response.set_cookie(
        "clipflow_session",
        token,
        max_age=ttl_seconds,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )


def _no_store(response: Response) -> Response:
    """Prevent shared proxies from caching owner data or media responses."""

    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return response


def create_local_session_router() -> APIRouter:
    """Expose an explicit mode probe without adding local authentication."""

    router = APIRouter(prefix="/api/auth", tags=["auth"])

    @router.get("/session")
    async def local_session() -> dict[str, Any]:
        return {"mode": "local", "authenticated": False}

    return router


def create_auth_router(
    config: HostedConfig,
    sessions: SessionStore | None = None,
    auth_service: HostedAuthService | None = None,
    limiter: LoginRateLimiter | None = None,
) -> APIRouter:
    sessions = sessions or SessionStore()
    auth_service = auth_service or HostedAuthService(config)
    limiter = limiter or LoginRateLimiter()
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    @router.get("/session")
    async def session(request: Request) -> dict[str, Any]:
        current = sessions.get(request.cookies.get("clipflow_session"))
        if current is None:
            return {"mode": "hosted", "authenticated": False}
        return {"mode": "hosted", "authenticated": True, "user_id": current.user_id}

    @router.post("/login")
    async def login(payload: LoginPayload, request: Request) -> Response:
        if not _origin_is_allowed(request, config):
            return JSONResponse({"detail": "Origin not allowed."}, status_code=403)
        allowed, retry_after = limiter.check(_client_key(request))
        if not allowed:
            response = JSONResponse({"detail": "Too many login attempts."}, status_code=429)
            response.headers["Retry-After"] = str(retry_after)
            return response
        try:
            owner = await auth_service.sign_in_owner(payload.email, payload.password)
        except (httpx.HTTPError, asyncio.TimeoutError):
            owner = False
        except Exception:
            # Authentication failures are deliberately generic and fail closed;
            # do not turn provider responses or request data into API errors.
            owner = False
        if not owner:
            # Keep account existence and owner identity private.
            return JSONResponse({"detail": "Invalid credentials."}, status_code=401)
        token, _ = sessions.create(config.owner_id, config.session_ttl_seconds)
        response = JSONResponse({"authenticated": True})
        _set_session_cookie(response, token, config.session_ttl_seconds)
        return response

    @router.post("/logout")
    async def logout(request: Request) -> Response:
        if not _origin_is_allowed(request, config):
            return JSONResponse({"detail": "Origin not allowed."}, status_code=403)
        sessions.revoke(request.cookies.get("clipflow_session"))
        response = JSONResponse({"authenticated": False})
        response.delete_cookie("clipflow_session", path="/")
        return response

    return router


class HostedSecurityMiddleware(BaseHTTPMiddleware):
    """Require a valid owner session for API and media requests."""

    def __init__(self, app: Any, config: HostedConfig, sessions: SessionStore) -> None:
        super().__init__(app)
        self.config = config
        self.sessions = sessions

    async def dispatch(self, request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        path = request.url.path
        if not self.config.hosted:
            return await call_next(request)

        is_api = path == "/api" or path.startswith("/api/")
        is_media = path == "/media" or path.startswith("/media/")
        is_docs = path in {"/docs", "/redoc", "/openapi.json"} or path.startswith("/docs/")
        if not (is_api or is_media or is_docs):
            return await call_next(request)

        # These two exact desktop handoff endpoints use a one-use bearer ticket
        # validated by their handlers. They intentionally carry no browser cookie.
        desktop_ticket = path == "/api/desktop-import/ticket" and request.method == "GET"
        desktop_upload = path == "/api/desktop-import/upload" and request.method == "POST"
        if desktop_ticket or desktop_upload:
            auth = request.headers.get("authorization", "")
            if not auth.startswith("Bearer ") or request.cookies:
                return _no_store(JSONResponse({"detail": "Authentication required."}, status_code=401))
            return _no_store(await call_next(request))

        if path == "/api/health" and request.method in {"GET", "HEAD"}:
            current = self.sessions.get(request.cookies.get("clipflow_session"))
            if current is not None and current.user_id == self.config.owner_id:
                request.state.hosted_user_id = current.user_id
                return _no_store(await call_next(request))
            # Do not expose provider state, paths, versions, or configuration
            # through the unauthenticated hosted readiness probe.
            return _no_store(JSONResponse({"ready": True}))

        if request.method == "OPTIONS":
            if not _origin_is_allowed(request, self.config):
                return JSONResponse({"detail": "Origin not allowed."}, status_code=403)
            response = await call_next(request)
            response.headers["Access-Control-Allow-Origin"] = self.config.public_origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            return _no_store(response)

        is_auth_route = path.startswith("/api/auth/")
        is_mutation = request.method not in {"GET", "HEAD"}
        if is_mutation and not _origin_is_allowed(request, self.config):
            return _no_store(JSONResponse({"detail": "Origin not allowed."}, status_code=403))

        # The login/session/logout router is the only unauthenticated API area.
        if is_auth_route:
            return _no_store(await call_next(request))

        current = self.sessions.get(request.cookies.get("clipflow_session"))
        if current is None or current.user_id != self.config.owner_id:
            return _no_store(JSONResponse({"detail": "Authentication required."}, status_code=401))
        request.state.hosted_user_id = current.user_id
        return _no_store(await call_next(request))


def require_hosted_owner(request: Request) -> str:
    """Dependency helper for routes that need an explicit owner identity."""

    owner_id = getattr(request.state, "hosted_user_id", None)
    if not isinstance(owner_id, str) or not owner_id:
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="Authentication required.")
    return owner_id


def install_hosted_security(
    app: FastAPI,
    config: HostedConfig | None = None,
    *,
    sessions: SessionStore | None = None,
    auth_service: HostedAuthService | None = None,
    limiter: LoginRateLimiter | None = None,
) -> HostedConfig:
    """Install the hosted gate and auth routes; local mode is a no-op.

    The application should call this during startup before serving requests.
    In hosted mode, configuration errors intentionally abort startup.
    """

    config = config or HostedConfig.from_env()
    if not config.hosted:
        app.include_router(create_local_session_router())
        return config
    sessions = sessions or SessionStore()
    app.add_middleware(HostedSecurityMiddleware, config=config, sessions=sessions)
    app.include_router(create_auth_router(config, sessions, auth_service, limiter))
    return config


__all__ = [
    "HostedAuthService",
    "HostedConfig",
    "HostedConfigurationError",
    "HostedSecurityMiddleware",
    "LoginRateLimiter",
    "SessionStore",
    "create_auth_router",
    "create_local_session_router",
    "install_hosted_security",
    "require_hosted_owner",
]
