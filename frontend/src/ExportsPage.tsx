import { useDialogFocus } from "./useDialogFocus";
import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Download,
  Film,
  LoaderCircle,
  Play,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import type { Job, Project } from "./editorTypes";

const names: Record<string, string> = {
  export_job: "Export",
  preview_job: "Render proof",
  youtube_job: "YouTube import",
  upload_job: "Upload",
  analyze_job: "Clip selection",
  transcribe_job: "Transcription",
  demo_job: "Demo",
  higgsfield_job: "B-roll",
};
export default function ExportsPage({
  jobs,
  projects,
  onOpen,
  onCancel,
  onRetry,
  onRefresh,
}: {
  jobs: Job[];
  projects: Project[];
  onOpen: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState("downloads");
  const [projectId, setProjectId] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Job | null>(null);
  const dialogRef = useDialogFocus<HTMLElement>(!!preview);
  const rows = useMemo(
    () =>
      jobs
        .filter(
          (j) =>
            (!projectId || j.project_id === projectId) &&
            (filter === "downloads"
              ? j.status === "done" && j.kind === "export_job"
              : filter === "processing"
                ? ["queued", "running"].includes(j.status)
                : filter === "failed"
                  ? ["error", "cancelled"].includes(j.status)
                  : true) &&
            `${j.clip_titles?.join(" ") || ""} ${projects.find((p) => p.id === j.project_id)?.title || ""} ${names[j.kind || ""] || ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")),
    [jobs, projects, projectId, query, filter],
  );
  return (
    <main className="workspace-page exports-page">
      <header className="page-heading">
        <div>
          <h1>Exports & activity</h1>
          <p>Finished clips and the work happening in the background.</p>
        </div>
        <button className="secondary-action" onClick={onRefresh}>
          <RotateCcw size={16} />
          Refresh
        </button>
      </header>
      <div className="library-topline">
        <div className="page-tabs">
          {[
            ["downloads", "Downloads"],
            ["processing", "Processing"],
            ["failed", "Needs attention"],
            ["all", "All activity"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={filter === key ? "is-active" : ""}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="library-controls">
        <label className="workspace-search">
          <Search size={18} />
          <input
            aria-label="Search exports"
            placeholder="Search clips or projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter exports by project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </div>
      {!rows.length ? (
        <div className="workspace-empty">
          <div className="empty-folder-art">
            <Download size={32} />
          </div>
          <h2>
            {filter === "downloads"
              ? "Your finished clips will appear here"
              : "Nothing to show here"}
          </h2>
          <p>
            {filter === "downloads"
              ? "Open a project, select your clips, and choose Export."
              : "Try another filter or start a new job in the editor."}
          </p>
        </div>
      ) : (
        <div className="export-table">
          {rows.map((j) => {
            const p = projects.find((p) => p.id === j.project_id);
            const running = ["queued", "running"].includes(j.status);
            const batch = (j.clip_titles?.length || 0) > 1;
            return (
              <article className="export-record" key={j.id}>
                <div className="export-media">
                  {p?.thumbnail_url ? (
                    <img src={p.thumbnail_url} alt="" />
                  ) : (
                    <Film size={24} />
                  )}
                </div>
                <div className="export-record-info">
                  <span className="record-kind">
                    {names[j.kind || ""] || "Job"}
                    {batch ? ` / ${j.clip_titles!.length} clips` : ""}
                  </span>
                  <h2>
                    {j.clip_titles?.join(", ") || p?.title || "Video job"}
                  </h2>
                  <p>
                    {p?.title}
                    {j.created_at
                      ? ` · ${new Date(j.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                      : ""}
                  </p>
                  {running && (
                    <>
                      <progress max={100} value={j.progress || 0} />
                      <small>
                        {j.stage || "Waiting"} — {Math.round(j.progress || 0)}%
                      </small>
                    </>
                  )}
                  {j.error && <p className="workspace-error">{j.error}</p>}
                  {j.warning && <p className="page-hint">{j.warning}</p>}
                </div>
                <div className="export-record-actions">
                  <span className={`record-status status-${j.status}`}>
                    {running ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : j.status === "done" ? (
                      <CheckCircle2 size={14} />
                    ) : null}
                    {j.status === "done"
                      ? "Completed"
                      : j.status === "error"
                        ? "Failed"
                        : j.status}
                  </span>
                  <div>
                    {p && (
                      <button
                        className="record-icon"
                        title="Open project"
                        aria-label={`Open project ${p.title}`}
                        onClick={() => onOpen(p.id)}
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    )}
                    {j.status === "done" && j.download_url && (
                      <>
                        {!batch && (
                          <button
                            className="secondary-action"
                            onClick={() => setPreview(j)}
                          >
                            <Play size={15} />
                            Preview
                          </button>
                        )}
                        <a
                          className="primary-action"
                          href={j.download_url}
                          download
                        >
                          <Download size={16} />
                          {batch ? "Download ZIP" : "Download"}
                        </a>
                      </>
                    )}
                    {running && (
                      <button
                        className="secondary-action"
                        onClick={() => onCancel(j.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {["error", "cancelled"].includes(j.status) && (
                      <button
                        className="secondary-action"
                        onClick={() => onRetry(j.id)}
                      >
                        <RotateCcw size={15} />
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {preview && (
        <div
          className="workspace-modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && setPreview(null)}
        >
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Export preview"
            className="export-preview-dialog"
            onKeyDown={(e) => e.key === "Escape" && setPreview(null)}
          >
            <header>
              <strong>
                {preview.clip_titles?.join(", ") || "Rendered clip"}
              </strong>
              <button
                autoFocus
                aria-label="Close export preview"
                onClick={() => setPreview(null)}
              >
                <X size={22} />
              </button>
            </header>
            <video src={preview.download_url} controls autoPlay playsInline />
            <a href={preview.download_url} download className="primary-action">
              <Download size={16} />
              Download this version
            </a>
          </section>
        </div>
      )}
    </main>
  );
}
