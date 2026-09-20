import { useEffect, useState } from "react";
import {
  Check,
  Download,
  ExternalLink,
  Send,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Clip, Project } from "./editorTypes";
import { useDialogFocus } from "./useDialogFocus";
import "./PublishPage.css";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Approval = {
  clip_id: string;
  valid: boolean;
  status: string;
  revision: number;
  artifact_url?: string;
};
type Target = {
  clip_id: string;
  platform: string;
  account_id: string;
  account_label?: string;
  caption: string;
  privacy: string;
  artifact_url: string;
};
type Plan = {
  plan_id: string;
  confirmation_token: string;
  expires_at: string;
  targets: Target[];
};
type Attempt = {
  attempt_id: string;
  platform: string;
  account_id?: string;
  account_label?: string;
  clip_id: string;
  status: string;
  error?: string;
  result?: { url?: string; id?: string; publish_id?: string };
  created_at: string;
};
type Connections = {
  providers: Record<
    string,
    { configured: boolean; enabled: boolean; audit_approved?: boolean; accounts?: Array<{ id: string; label: string; configured: boolean; enabled: boolean; audit_approved?: boolean }> }
  >;
  notes: Record<string, string>;
};
const platforms = [
  ["youtube", "YouTube Shorts"],
  ["instagram", "Instagram Reels"],
  ["tiktok", "TikTok"],
] as const;

export default function PublishPage({
  api,
  projects,
  currentId,
  onOpen,
  onSettings,
  onNotice,
}: {
  api: Api;
  projects: Project[];
  currentId?: string;
  onOpen: (id: string) => void;
  onSettings: () => void;
  onNotice: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState(
    currentId || projects.find((p) => !p.archived)?.id || "",
  );
  const [project, setProject] = useState<Project | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [connections, setConnections] = useState<Connections | null>(null);
  const [history, setHistory] = useState<Attempt[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<Array<{ platform: string; account_id: string }>>([]);
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [privacy, setPrivacy] = useState("private");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [phrase, setPhrase] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Clip | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>(!!plan || !!preview);
  const valid = (clip: Clip) =>
    approvals.some(
      (a) => a.clip_id === clip.id && a.valid && a.status === "approved",
    );
  const ready = (clip: Clip) =>
    clip.status === "exported" && !!clip.download_url?.includes("/exports/");
  const eligible = project?.clips.filter(ready) || [];

  // Read-only polling keeps completed renders and remote publishing attempts visible.
  useEffect(() => {
    let cancelled = false;
    setProject(null);
    setApprovals([]);
    setPicked([]);
    setPlan(null);
    setError("");
    async function refresh() {
      if (!projectId) return;
      try {
        const [p, a, c, h] = await Promise.all([
          api<Project>(`/projects/${projectId}`),
          api<{ approvals: Approval[] }>(`/projects/${projectId}/approvals`),
          api<Connections>("/publishing/settings"),
          api<{ attempts: Attempt[] }>(
            `/publishing/history?project_id=${projectId}`,
          ),
        ]);
        if (!cancelled) {
          setProject(p);
          setApprovals(a.approvals);
          setConnections(c);
          setHistory(h.attempts);
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Could not load publishing.",
          );
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  async function approve(
    ids: string[],
    action: "approve" | "revoke" = "approve",
  ) {
    if (!ids.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ approvals: Approval[] }>(
        `/projects/${projectId}/approvals`,
        { method: "POST", body: JSON.stringify({ clip_ids: ids, action }) },
      );
      setApprovals(result.approvals);
      setPlan(null);
      onNotice(
        action === "approve"
          ? `${ids.length} clip${ids.length === 1 ? "" : "s"} approved for publishing.`
          : "Approval removed.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }
  async function render() {
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      await api(`/projects/${project.id}/export`, {
        method: "POST",
        body: JSON.stringify({
          clip_ids: project.clips.filter((c) => !ready(c)).map((c) => c.id),
        }),
      });
      onNotice("Rendering clips for review. Progress is in Exports.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not render clips.");
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const result = await api<Plan>(`/projects/${projectId}/publish/prepare`, {
        method: "POST",
        body: JSON.stringify({
          clip_ids: picked,
          destinations,
          captions: Object.fromEntries(
            destinations.map((d) => [
              d.platform,
              Object.fromEntries(
                (project?.clips || [])
                  .filter((c) => picked.includes(c.id))
                  .map((c) => [c.id, captions[c.id] ?? c.title]),
              ),
            ]),
          ),
          privacy: { youtube: privacy, tiktok: "SELF_ONLY" },
        }),
      });
      setPlan(result);
      setPhrase("");
      setConsent(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare posts.");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!plan || !consent || phrase !== "PUBLISH") return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ attempts: Attempt[] }>("/publishing/confirm", {
        method: "POST",
        body: JSON.stringify({
          plan_id: plan.plan_id,
          confirmation_token: plan.confirmation_token,
          confirmation: phrase,
        }),
      });
      setHistory((h) => [...result.attempts, ...h]);
      setPlan(null);
      setPicked([]);
      onNotice("Publishing started. Check the delivery status below.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publishing failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspace-page publish-page">
      <header className="page-heading">
        <div>
          <h1>Review & publish</h1>
          <p>
            Review the rendered files, approve your choices, then confirm where
            they go.
          </p>
        </div>
        <button className="secondary-action" onClick={onSettings}>
          Connect accounts
        </button>
      </header>
      <label className="publish-project-picker">
        Project
        <select
          aria-label="Publishing project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="" disabled>
            Choose a project
          </option>
          {projects
            .filter((p) => !p.archived)
            .map((p) => (
              <option value={p.id} key={p.id}>
                {p.title}
              </option>
            ))}
        </select>
      </label>
      {error && !plan && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
      {!project ? (
        <div className="workspace-empty">
          <h2>
            {projectId ? "Loading project…" : "Choose a project to begin"}
          </h2>
        </div>
      ) : (
        <>
          <section className="publish-section">
            <header>
              <div>
                <h2>1. Approve rendered clips</h2>
                <p>
                  Approval belongs to this exact export. Changing the clip
                  requires a new export and approval.
                </p>
              </div>
              <div className="publish-inline-actions">
                <button
                  className="secondary-action"
                  disabled={busy || !project.clips.some((c) => !ready(c))}
                  onClick={render}
                >
                  Render unfinished clips
                </button>
                <button
                  className="primary-action"
                  disabled={busy || !eligible.length}
                  onClick={() => approve(eligible.map((c) => c.id))}
                >
                  <ShieldCheck size={16} />
                  Approve all {eligible.length} ready clip
                  {eligible.length === 1 ? "" : "s"}
                </button>
              </div>
            </header>
            {!project.clips.length ? (
              <p>
                No clips yet.{" "}
                <button
                  className="text-action"
                  onClick={() => onOpen(project.id)}
                >
                  Open editor
                </button>
              </p>
            ) : (
              <div className="approval-list">
                {project.clips.map((clip) => (
                  <article
                    key={clip.id}
                    className={valid(clip) ? "is-approved" : ""}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Publish ${clip.title}`}
                      disabled={!valid(clip) || busy}
                      checked={picked.includes(clip.id)}
                      onChange={(e) => {
                        setPicked((ids) =>
                          e.target.checked
                            ? [...ids, clip.id]
                            : ids.filter((id) => id !== clip.id),
                        );
                        setPlan(null);
                      }}
                    />
                    <div className="approval-clip-name">
                      <strong>{clip.title}</strong>
                      <span>
                        {clip.start.toFixed(1)}–{clip.end.toFixed(1)}s ·{" "}
                        {valid(clip)
                          ? "Approved"
                          : ready(clip)
                            ? "Needs approval"
                            : "Render required"}
                      </span>
                    </div>
                    <div className="publish-inline-actions">
                      {ready(clip) && (
                        <button
                          className="secondary-action"
                          onClick={() => setPreview(clip)}
                        >
                          Watch export
                        </button>
                      )}
                      <button
                        className={
                          valid(clip) ? "text-action" : "secondary-action"
                        }
                        disabled={!ready(clip) || busy}
                        onClick={() =>
                          approve([clip.id], valid(clip) ? "revoke" : "approve")
                        }
                      >
                        {valid(clip) ? "Revoke approval" : "Approve"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <button
              className="text-action"
              onClick={() =>
                setPicked(project.clips.filter(valid).map((c) => c.id))
              }
              disabled={busy || !project.clips.some(valid)}
            >
              Select approved clips for posting
            </button>
          </section>
          <section className="publish-section">
            <h2>2. Prepare posts</h2>
            <p>
              {picked.length} clip{picked.length === 1 ? "" : "s"} selected.
              Nothing is uploaded until the final confirmation.
            </p>
            <div className="publish-destinations">
              {platforms.flatMap(([id, label]) => {
                const provider = connections?.providers[id];
                const accounts = provider?.accounts?.length
                  ? provider.accounts
                  : provider
                    ? [{ id: `${id}-legacy`, label, configured: provider.configured, enabled: provider.enabled, audit_approved: provider.audit_approved }]
                    : [];
                return accounts.map((account) => {
                  const eligible = !!account.enabled && !!account.configured && (id !== "tiktok" || !!account.audit_approved);
                  const checked = destinations.some((d) => d.platform === id && d.account_id === account.id);
                  return <label key={`${id}:${account.id}`}>
                    <input type="checkbox" checked={checked} disabled={!eligible || busy} onChange={(e) => setDestinations((items) => e.target.checked ? [...items, { platform: id, account_id: account.id }] : items.filter((d) => !(d.platform === id && d.account_id === account.id)))} />
                    <div><strong>{label} · {account.label}</strong><small>{eligible ? "Connected" : id === "tiktok" ? "Requires an audited, eligible app" : "Configure in Settings"}</small></div>
                  </label>;
                });
              })}
            </div>
            {destinations.some((d) => d.platform === "youtube") && (
              <label className="settings-field">
                YouTube visibility
                <select
                  value={privacy}
                  onChange={(e) => setPrivacy(e.target.value)}
                >
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </label>
            )}
            {destinations.some((d) => d.platform === "instagram") && (
              <p className="page-hint">
                Instagram publishes to your professional account. Its servers
                must be able to download the approved video from your configured
                public media URL.
              </p>
            )}
            {destinations.some((d) => d.platform === "tiktok") && (
              <p className="page-hint">
                TikTok posts use Only me visibility. Direct posting requires
                platform review; personal utility apps may not qualify.
              </p>
            )}
            {project.clips
              .filter((c) => picked.includes(c.id))
              .map((c) => (
                <label key={c.id} className="settings-field">
                  Post text · {c.title}
                  <textarea
                    maxLength={2200}
                    value={captions[c.id] ?? c.title}
                    onChange={(e) =>
                      setCaptions((all) => ({ ...all, [c.id]: e.target.value }))
                    }
                  />
                </label>
              ))}
            <button
              className="primary-action"
              disabled={
                busy ||
                !picked.length ||
                !destinations.length ||
                picked.some(
                  (id) => !project.clips.some((c) => c.id === id && valid(c)),
                )
              }
              onClick={prepare}
            >
              <Send size={16} />
              Review publishing plan
            </button>
          </section>
          <section className="publish-section">
            <h2>3. Delivery history</h2>
            {!history.length ? (
              <p>No posts sent from this project.</p>
            ) : (
              <div className="publish-history">
                {history.map((a) => (
                  <article key={a.attempt_id}>
                    <strong>
                      {platforms.find(([id]) => id === a.platform)?.[1] || a.platform}
                      {a.account_label ? ` · ${a.account_label}` : a.account_id ? ` · ${a.account_id}` : ""}
                    </strong>
                    <span>
                      {project.clips.find((c) => c.id === a.clip_id)?.title ||
                        a.clip_id}
                    </span>
                    <b>{a.status.replace(/_/g, " ")}</b>
                    {a.platform === "tiktok" &&
                      ["processing", "uncertain"].includes(a.status) &&
                      a.result?.publish_id && (
                        <button
                          className="secondary-action"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              const row = await api<Attempt>(
                                `/publishing/history/${a.attempt_id}/refresh`,
                                { method: "POST" },
                              );
                              setHistory((rows) =>
                                rows.map((item) =>
                                  item.attempt_id === row.attempt_id
                                    ? row
                                    : item,
                                ),
                              );
                            } catch (e) {
                              setError(
                                e instanceof Error
                                  ? e.message
                                  : "Could not check delivery.",
                              );
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Check delivery
                        </button>
                      )}
                    {a.error && <p className="workspace-error">{a.error}</p>}
                    {a.result?.url && (
                      <a href={a.result.url} target="_blank" rel="noreferrer">
                        Open post
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {(plan || preview) && (
        <div className="workspace-modal-backdrop">
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={plan ? "Confirm publishing" : "Review exported clip"}
            className="publish-review-dialog"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !busy) {
                setPlan(null);
                setPreview(null);
              }
            }}
          >
            <header>
              <h2>{plan ? "Confirm publishing" : "Review exported clip"}</h2>
              <button
                aria-label="Close publishing review"
                disabled={busy}
                onClick={() => {
                  setPlan(null);
                  setPreview(null);
                }}
              >
                <X size={21} />
              </button>
            </header>
            {preview && (
              <>
                <h3>{preview.title}</h3>
                <video src={preview.download_url} controls playsInline />
                <a
                  href={preview.download_url}
                  download
                  className="secondary-action"
                >
                  <Download size={16} />
                  Download export
                </a>
              </>
            )}
            {plan && (
              <>
                <p>
                  These approved files and post details will be sent to the
                  selected accounts.
                </p>
                <div className="publish-plan-targets">
                  {plan.targets.map((t) => (
                    <article key={`${t.clip_id}-${t.platform}`}>
                      <strong>
                        {platforms.find(([id]) => id === t.platform)?.[1]} · {t.account_label || t.account_id} ·{" "}
                        {t.privacy || "Account visibility"}
                      </strong>
                      <video
                        src={t.artifact_url}
                        controls
                        preload="metadata"
                        playsInline
                      />
                      <p dir="auto">{t.caption}</p>
                    </article>
                  ))}
                </div>
                <label className="publish-consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  I reviewed these clips and authorize sending these posts.
                </label>
                <label className="settings-field">
                  Type PUBLISH to confirm
                  <input
                    value={phrase}
                    onChange={(e) => setPhrase(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                {error && (
                  <p className="workspace-error" role="alert">
                    {error}
                  </p>
                )}
                <button
                  className="primary-action"
                  disabled={busy || !consent || phrase !== "PUBLISH"}
                  onClick={confirm}
                >
                  <Check size={16} />
                  {busy
                    ? "Sending…"
                    : `Publish ${plan.targets.length} post${plan.targets.length === 1 ? "" : "s"}`}
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
