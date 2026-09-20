import {
  FormEvent,
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import "./HostedGate.css";

type HostedStatus = "checking" | "signed-out" | "signed-in" | "unavailable";
type RuntimeMode = "unknown" | "local" | "hosted";

type HostedAuthContextValue = {
  hosted: boolean;
  status: HostedStatus;
  userId: string | null;
  logoutError: string;
  logout: () => Promise<void>;
};

const HostedAuthContext = createContext<HostedAuthContextValue | null>(null);

const forcedHostedMode = import.meta.env.VITE_CLIPFLOW_MODE === "hosted";

async function readSession(): Promise<{
  mode: "local" | "hosted";
  authenticated: boolean;
  user_id?: string;
}> {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
  });
  // A missing probe is the expected signal from an unmodified local worker.
  if (response.status === 404 && !forcedHostedMode)
    return { mode: "local", authenticated: false };
  if (!response.ok)
    throw new Error(`session endpoint returned ${response.status}`);
  const payload = (await response.json()) as {
    mode?: "local" | "hosted";
    authenticated?: boolean;
    user_id?: string;
  };
  const mode = payload.mode ?? (forcedHostedMode ? "hosted" : "local");
  if (forcedHostedMode && mode !== "hosted")
    throw new Error("hosted session endpoint is not installed");
  if (typeof payload.authenticated !== "boolean")
    throw new Error("invalid session response");
  return {
    mode,
    authenticated: payload.authenticated,
    user_id: payload.user_id,
  };
}

export function useHostedAuth(): HostedAuthContextValue {
  const value = useContext(HostedAuthContext);
  if (!value) throw new Error("useHostedAuth must be used inside HostedGate");
  return value;
}

function LoginPanel({
  onSignedIn,
}: {
  onSignedIn: (userId: string | null) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        setError(
          response.status >= 500
            ? "The hosted worker is unavailable."
            : response.status === 429
              ? "Too many attempts. Try again shortly."
              : "Sign-in failed.",
        );
        return;
      }
      const session = await readSession();
      if (session.mode !== "hosted" || !session.authenticated) {
        setError("Sign-in failed.");
        return;
      }
      setPassword("");
      onSignedIn(session.user_id ?? null);
    } catch {
      setError("The hosted worker is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="hosted-gate hosted-gate-login">
      <section
        className="hosted-login-card"
        aria-labelledby="hosted-login-title"
      >
        <span className="hosted-eyebrow">Private workspace</span>
        <h1 id="hosted-login-title">Sign in to Clipflow</h1>
        <p>Use the owner account to open this hosted workspace.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && (
            <p className="hosted-form-error" role="alert">
              {error}
            </p>
          )}
          <button disabled={busy} type="submit">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

export function HostedGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<RuntimeMode>(
    forcedHostedMode ? "hosted" : "unknown",
  );
  const [status, setStatus] = useState<HostedStatus>("checking");
  const [userId, setUserId] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    let active = true;
    readSession()
      .then((session) => {
        if (!active) return;
        setMode(session.mode);
        setUserId(session.user_id ?? null);
        setStatus(session.authenticated ? "signed-in" : "signed-out");
      })
      .catch(() => {
        // An unavailable worker is different from an unauthenticated owner;
        // never send the user to a login screen because of a network failure.
        if (active) setStatus("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  const logout = async () => {
    if (mode !== "hosted") return;
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("logout failed");
      setUserId(null);
      setStatus("signed-out");
    } catch {
      setLogoutError(
        "Sign out failed. Check the worker connection and try again.",
      );
    }
  };

  const value = useMemo(
    () => ({ hosted: mode === "hosted", status, userId, logoutError, logout }),
    [mode, status, userId, logoutError],
  );

  if (mode === "local") {
    return (
      <HostedAuthContext.Provider value={value}>
        {children}
      </HostedAuthContext.Provider>
    );
  }
  if (status === "checking") {
    return (
      <main className="hosted-gate hosted-gate-loading">
        <span>Checking workspace session…</span>
      </main>
    );
  }
  if (status === "signed-out") {
    return (
      <HostedAuthContext.Provider value={value}>
        <LoginPanel
          onSignedIn={(nextUserId) => {
            setUserId(nextUserId);
            setStatus("signed-in");
          }}
        />
      </HostedAuthContext.Provider>
    );
  }
  if (status === "unavailable") {
    return (
      <main className="hosted-gate hosted-gate-loading">
        <span>The hosted worker is unavailable.</span>
        <button type="button" onClick={() => window.location.reload()}>
          Retry
        </button>
      </main>
    );
  }
  return (
    <HostedAuthContext.Provider value={value}>
      <div className="hosted-app-shell">
        <div className="hosted-session-bar">
          <span>Owner workspace</span>
          <button type="button" onClick={logout}>
            Sign out
          </button>
          {logoutError && <span role="alert">{logoutError}</span>}
        </div>
        {children}
      </div>
    </HostedAuthContext.Provider>
  );
}
