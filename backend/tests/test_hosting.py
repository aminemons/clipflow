from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.hosting import (
    HostedAuthService,
    HostedConfig,
    HostedConfigurationError,
    LoginRateLimiter,
    SessionStore,
    install_hosted_security,
)


OWNER = "owner-user-id"
ORIGIN = "https://clipflow.example"


@dataclass
class FakeSupabase:
    user_id: str | None = OWNER
    calls: int = 0

    async def password_sign_in(self, email: str, password: str):
        self.calls += 1
        if email == "owner@example.com" and password == "correct":
            return {"user": {"id": self.user_id}} if self.user_id else None
        return None


def config() -> HostedConfig:
    return HostedConfig(
        mode="hosted",
        public_origin=ORIGIN,
        supabase_url="https://project.supabase.co",
        supabase_publishable_key="sb_publishable_test",
        owner_id=OWNER,
        session_ttl_seconds=900,
    )


def app_with_fake(fake: FakeSupabase | None = None):
    app = FastAPI()

    @app.get("/api/health")
    async def health():
        return {"ready": True, "ffmpeg": "ok"}

    @app.get("/api/private")
    async def private():
        return {"ok": True}

    @app.post("/api/private")
    async def private_mutation():
        return {"ok": True}

    @app.get("/media/demo.mp4")
    async def media():
        return {"ok": True}

    fake = fake or FakeSupabase()
    install_hosted_security(
        app,
        config(),
        sessions=SessionStore(),
        auth_service=HostedAuthService(config(), fake),
        limiter=LoginRateLimiter(limit=5, window_seconds=60),
    )
    return app, fake


def test_hosted_config_fails_closed_for_required_values():
    with pytest.raises(HostedConfigurationError):
        HostedConfig.from_env({"CLIPFLOW_MODE": "hosted"})

    base = {
        "CLIPFLOW_MODE": "hosted",
        "CLIPFLOW_PUBLIC_ORIGIN": "https://clipflow.example",
        "SUPABASE_URL": "https://project.supabase.co",
        "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_test",
        "CLIPFLOW_OWNER_ID": OWNER,
    }
    assert HostedConfig.from_env(base).hosted

    with pytest.raises(HostedConfigurationError):
        HostedConfig.from_env({**base, "CLIPFLOW_PUBLIC_ORIGIN": "http://clipflow.example"})
    with pytest.raises(HostedConfigurationError):
        HostedConfig.from_env({**base, "CLIPFLOW_PUBLIC_ORIGIN": "https://user:pass@clipflow.example"})
    with pytest.raises(HostedConfigurationError):
        HostedConfig.from_env({**base, "SUPABASE_URL": "https://project.supabase.co?x=1"})
    with pytest.raises(HostedConfigurationError):
        HostedConfig.from_env({k: v for k, v in base.items() if k != "CLIPFLOW_OWNER_ID"})


def test_local_mode_has_no_account_requirements():
    assert HostedConfig.from_env({"CLIPFLOW_MODE": "local"}) == HostedConfig(mode="local")

    app = FastAPI()
    install_hosted_security(app, HostedConfig(mode="local"))
    local_client = TestClient(app, base_url="http://127.0.0.1")
    assert local_client.get("/api/auth/session").json() == {
        "mode": "local",
        "authenticated": False,
    }


def test_owner_login_sets_secure_opaque_cookie_and_protects_api():
    app, fake = app_with_fake()
    client = TestClient(app, base_url=ORIGIN)

    assert client.get("/api/health").json() == {"ready": True}
    assert client.get("/api/private").status_code == 401
    assert client.get("/media/demo.mp4").status_code == 401
    assert client.get("/api/auth/session").json() == {
        "mode": "hosted",
        "authenticated": False,
    }

    response = client.post(
        "/api/auth/login",
        headers={"Origin": ORIGIN},
        json={"email": "owner@example.com", "password": "correct"},
    )
    assert response.status_code == 200
    assert response.json() == {"authenticated": True}
    cookie = response.headers["set-cookie"]
    assert "clipflow_session=" in cookie
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
    assert "owner-user-id" not in cookie
    assert fake.calls == 1

    assert client.get("/api/auth/session").json() == {
        "authenticated": True,
        "user_id": OWNER,
        "mode": "hosted",
    }
    assert client.get("/api/health").json() == {"ready": True, "ffmpeg": "ok"}
    assert client.get("/api/private").status_code == 200
    assert client.get("/media/demo.mp4").status_code == 200


def test_non_owner_and_wrong_origin_are_refused_without_account_disclosure():
    fake = FakeSupabase(user_id="another-user")
    app, _ = app_with_fake(fake)
    client = TestClient(app, base_url=ORIGIN)

    wrong_origin = client.post(
        "/api/auth/login",
        headers={"Origin": "https://evil.example"},
        json={"email": "owner@example.com", "password": "correct"},
    )
    assert wrong_origin.status_code == 403
    assert fake.calls == 0

    non_owner = client.post(
        "/api/auth/login",
        headers={"Origin": ORIGIN},
        json={"email": "owner@example.com", "password": "correct"},
    )
    assert non_owner.status_code == 401
    assert non_owner.json() == {"detail": "Invalid credentials."}
    assert "another-user" not in non_owner.text


def test_mutations_require_exact_origin_and_logout_revokes_session():
    app, _ = app_with_fake()
    client = TestClient(app, base_url=ORIGIN)
    client.post(
        "/api/auth/login",
        headers={"Origin": ORIGIN},
        json={"email": "owner@example.com", "password": "correct"},
    )

    assert client.post("/api/private", json={}).status_code == 403
    assert client.post(
        "/api/private", headers={"Origin": ORIGIN}, json={}
    ).status_code == 200
    assert client.post("/api/auth/logout", headers={"Origin": ORIGIN}).status_code == 200
    assert client.get("/api/private").status_code == 401


def test_docs_are_owner_only_and_api_responses_are_not_cacheable():
    app, _ = app_with_fake()
    client = TestClient(app, base_url=ORIGIN)
    assert client.get("/openapi.json").status_code == 401

    client.post(
        "/api/auth/login",
        headers={"Origin": ORIGIN},
        json={"email": "owner@example.com", "password": "correct"},
    )
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/openapi.json").headers["cache-control"] == "no-store"
    assert client.get("/api/private").headers["cache-control"] == "no-store"


def test_login_rate_limit_is_per_client():
    app, fake = app_with_fake()
    client = TestClient(app, base_url=ORIGIN)
    request = {
        "headers": {"Origin": ORIGIN, "X-Forwarded-For": "203.0.113.10"},
        "json": {"email": "owner@example.com", "password": "wrong"},
    }
    for _ in range(5):
        assert client.post("/api/auth/login", **request).status_code == 401
    limited = client.post("/api/auth/login", **request)
    assert limited.status_code == 429
    assert limited.headers["retry-after"]
    assert fake.calls == 5


def test_expired_server_session_is_not_accepted():
    now = [100.0]
    store = SessionStore(now=lambda: now[0])
    token, _ = store.create(OWNER, 10)
    assert store.get(token) is not None
    now[0] = 111.0
    assert store.get(token) is None
