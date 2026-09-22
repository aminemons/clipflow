import { useDialogFocus } from "./useDialogFocus";
import { useMemo, useState } from "react";
import {
  Archive,
  ArrowRight,
  Check,
  Film,
  Grid2X2,
  List,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import type { Job, Project } from "./editorTypes";

const time = (s: number) =>
  `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;
export type ProjectChanges = Partial<
  Pick<Project, "title" | "favorite" | "tags" | "archived">
>;

export default function ProjectsPage({
  projects,
  jobs,
  currentId,
  onOpen,
  onNew,
  onDemo,
  onUpdate,
  onDelete,
  busy,
}: {
  projects: Project[];
  jobs: Job[];
  currentId?: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDemo: () => void;
  onUpdate: (id: string, changes: ProjectChanges) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "favorites" | "archived">("all");
  const [sort, setSort] = useState("recent");
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    localStorage.getItem("clipflow:library-layout") === "list"
      ? "list"
      : "grid",
  );
  const [tag, setTag] = useState("");
  const [editing, setEditing] = useState<Project | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dialogRef = useDialogFocus<HTMLFormElement>(!!editing);
  const visible = useMemo(
    () =>
      projects
        .filter(
          (p) =>
            Boolean(p.archived) === (filter === "archived") &&
            (filter !== "favorites" || p.favorite) &&
            (!tag || p.tags?.includes(tag)) &&
            `${p.title} ${(p.tags || []).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "name"
            ? a.title.localeCompare(b.title)
            : sort === "duration"
              ? b.duration - a.duration
              : Date.parse(b.updated_at || b.created_at || "1970-01-01") -
                Date.parse(a.updated_at || a.created_at || "1970-01-01"),
        ),
    [projects, filter, tag, query, sort],
  );
  const allTags = [...new Set(projects.flatMap((p) => p.tags || []))].sort();
  const current = projects.find((p) => p.id === currentId && !p.archived);
  async function update(p: Project, patch: ProjectChanges) {
    try {
      setError("");
      await onUpdate(p.id, patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update project.");
    }
  }
  async function saveDetails() {
    if (!editing || !title.trim()) return;
    setSaving(true);
    try {
      await onUpdate(editing.id, {
        title: title.trim(),
        tags: [
          ...new Set(
            tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          ),
        ],
      });
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save project.");
    } finally {
      setSaving(false);
    }
  }
  async function deleteProject() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete project.");
    } finally {
      setDeleting(false);
    }
  }
  function setView(next: "grid" | "list") {
    setLayout(next);
    localStorage.setItem("clipflow:library-layout", next);
  }
  return (
    <main className="workspace-page projects-page">
      <header className="page-heading">
        <div>
          <h1>Your projects</h1>
          <p>One source, all your edits. Pick up where you left off.</p>
        </div>
        <button
          className="primary-action"
          data-tour="new-project"
          onClick={onNew}
        >
          <Plus size={18} />
          New project
        </button>
      </header>
      {current && filter === "all" && !query && !tag && (
        <section className="continue-project">
          <div className="continue-image">
            {current.thumbnail_url ? (
              <img src={current.thumbnail_url} alt="" />
            ) : (
              <Film size={30} />
            )}
            <span>{time(current.duration)}</span>
          </div>
          <div>
            <span>Continue editing</span>
            <h2>{current.title}</h2>
            <p>
              {current.clips.length}{" "}
              {current.clips.length === 1 ? "clip" : "clips"}{" "}
              <span aria-hidden="true">/</span>{" "}
              {current.clips.filter((c) => c.reviewed).length} reviewed
            </p>
          </div>
          <button
            className="secondary-action"
            onClick={() => onOpen(current.id)}
          >
            Open editor
            <ArrowRight size={17} />
          </button>
        </section>
      )}
      <section
        data-tour="project-library"
        className="project-library"
        aria-label="Project library"
      >
        <div className="library-topline">
          <div className="page-tabs" aria-label="Project filter">
            {(["all", "favorites", "archived"] as const).map((f) => (
              <button
                key={f}
                className={filter === f ? "is-active" : ""}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
              >
                {f === "all"
                  ? "All projects"
                  : f === "favorites"
                    ? "Favorites"
                    : "Archived"}
                <span>
                  {
                    projects.filter(
                      (p) =>
                        Boolean(p.archived) === (f === "archived") &&
                        (f !== "favorites" || p.favorite),
                    ).length
                  }
                </span>
              </button>
            ))}
          </div>
          <div className="view-switch" aria-label="Library layout">
            <button
              aria-label="Grid view"
              aria-pressed={layout === "grid"}
              onClick={() => setView("grid")}
            >
              <Grid2X2 size={17} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={layout === "list"}
              onClick={() => setView("list")}
            >
              <List size={19} />
            </button>
          </div>
        </div>
        <div className="library-controls">
          <label className="workspace-search">
            <Search size={18} />
            <input
              aria-label="Search projects"
              placeholder="Search projects or tags"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                aria-label="Clear project search"
                onClick={() => setQuery("")}
              >
                <X size={15} />
              </button>
            )}
          </label>
          <select
            aria-label="Filter by tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select
            aria-label="Sort projects"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Recently updated</option>
            <option value="name">Name A–Z</option>
            <option value="duration">Longest first</option>
          </select>
        </div>
        {error && (
          <p role="alert" className="workspace-error">
            {error}
          </p>
        )}
        {filter === "archived" && (
          <p className="page-hint">
            Archived projects keep their source videos, clips, and exports.
            Restore one to continue editing.
          </p>
        )}
        {visible.length === 0 ? (
          <div className="workspace-empty">
            <FolderArt />
            <h2>
              {query || tag
                ? "No matching projects"
                : filter === "archived"
                  ? "No archived projects"
                  : filter === "favorites"
                    ? "Your favorites go here"
                    : "Start with a video"}
            </h2>
            <p>
              {query || tag
                ? "Try another name or clear your filters."
                : filter === "favorites"
                  ? "Star a project to find it here."
                  : "Upload a video or import a YouTube link to make your first clips."}
            </p>
            {filter === "all" && !query && !tag && (
              <>
                <button className="primary-action" onClick={onNew}>
                  <Plus size={17} />
                  Add a video
                </button>
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={onDemo}
                >
                  Try a 12-second sample
                </button>
              </>
            )}
          </div>
        ) : (
          <div className={`project-collection view-${layout}`}>
            {visible.map((p) => {
              const activeJob = jobs.find(
                (j) =>
                  j.project_id === p.id &&
                  (j.status === "running" || j.status === "queued"),
              );
              const ready = !!p.duration;
              return (
                <article
                  className={`project-tile ${p.id === currentId ? "project-current" : ""}`}
                  key={p.id}
                >
                  <button
                    className="project-image"
                    aria-label={`Open ${p.title}`}
                    onClick={() => onOpen(p.id)}
                    disabled={p.archived}
                  >
                    {p.thumbnail_url && ready ? (
                      <img loading="lazy" src={p.thumbnail_url} alt="" />
                    ) : (
                      <Film size={34} />
                    )}
                    <span className="project-length">
                      {ready ? time(p.duration) : "Source unavailable"}
                    </span>
                    {p.id === currentId && (
                      <span className="project-open-label">Open in editor</span>
                    )}
                    <span className="project-play">
                      <Play size={22} fill="currentColor" />
                    </span>
                  </button>
                  <div className="project-info">
                    <div className="project-title-row">
                      <button
                        onClick={() => onOpen(p.id)}
                        disabled={p.archived}
                        title={p.title}
                      >
                        <h2>{p.title}</h2>
                      </button>
                      <button
                        className={`star-project ${p.favorite ? "starred" : ""}`}
                        aria-label={`${p.favorite ? "Unfavorite" : "Favorite"} ${p.title}`}
                        aria-pressed={!!p.favorite}
                        onClick={() => update(p, { favorite: !p.favorite })}
                      >
                        <Star
                          size={17}
                          fill={p.favorite ? "currentColor" : "none"}
                        />
                      </button>
                    </div>
                    <div className="project-detail">
                      <span>
                        {p.clips.length}{" "}
                        {p.clips.length === 1 ? "clip" : "clips"}
                      </span>
                      <span>
                        {p.width && p.height
                          ? `${p.width} × ${p.height}`
                          : "Import incomplete"}
                      </span>
                    </div>
                    {p.tags && p.tags.length > 0 && (
                      <div className="project-tags">
                        {p.tags.map((t) => (
                          <button key={t} onClick={() => setTag(t)}>
                            {t}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="project-card-foot">
                      <span className={activeJob ? "project-processing" : ""}>
                        {activeJob
                          ? `${activeJob.stage || "Processing"} ${Math.round(activeJob.progress || 0)}%`
                          : p.archived
                            ? "Archived"
                            : p.clips.some((c) => c.status === "exported")
                              ? "Has exports"
                              : ready
                                ? "Draft"
                                : "Needs a new source"}
                      </span>
                      <div>
                        <button
                          aria-label={`Edit details for ${p.title}`}
                          title="Rename and tags"
                          onClick={() => {
                            setEditing(p);
                            setTitle(p.title);
                            setTags((p.tags || []).join(", "));
                            setError("");
                          }}
                        >
                          <MoreHorizontal size={19} />
                        </button>
                        <button
                          aria-label={`${p.archived ? "Restore" : "Archive"} ${p.title}`}
                          title={
                            p.archived ? "Restore project" : "Archive project"
                          }
                          disabled={!!activeJob}
                          onClick={() => update(p, { archived: !p.archived })}
                        >
                          {p.archived ? (
                            <ArrowRight size={17} />
                          ) : (
                            <Archive size={17} />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      {editing && (
        <div
          className="workspace-modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && setEditing(null)}
        >
          <form
            ref={dialogRef}
            className="workspace-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="details-title"
            onSubmit={(e) => {
              e.preventDefault();
              void saveDetails();
            }}
            onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
          >
            <header>
              <h2 id="details-title">Project details</h2>
              <button
                type="button"
                aria-label="Close project details"
                onClick={() => setEditing(null)}
              >
                <X size={20} />
              </button>
            </header>
            <label>
              Project name
              <input
                autoFocus
                maxLength={120}
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Tags
              <input
                aria-label="Tags"
                maxLength={200}
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="Podcast, interview, episode 4"
              />
              <small>
                Separate tags with commas. Up to 8 tags, 24 characters each.
              </small>
            </label>
            {error && (
              <p role="alert" className="workspace-error">
                {error}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="secondary-action"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button
                className="primary-action"
                disabled={saving || !title.trim()}
              >
                <Check size={16} />
                {saving ? "Saving…" : "Save changes"}
              </button>
            </footer>
            <button
              type="button"
              className="danger-text-action"
              disabled={saving || deleting || busy}
              onClick={() => setDeleteTarget(editing)}
            >
              <Trash2 size={15} />
              Permanently delete project
            </button>
          </form>
        </div>
      )}
      {deleteTarget && (
        <div
          className="workspace-modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && !deleting && setDeleteTarget(null)}
        >
          <div className="workspace-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title">
            <h2 id="delete-project-title">Permanently delete “{deleteTarget.title}”?</h2>
            <p>
              This permanently removes the source video, {deleteTarget.clips.length} {deleteTarget.clips.length === 1 ? "clip" : "clips"}, transcript, and exports. You cannot undo this action.
            </p>
            <footer>
              <button type="button" className="secondary-action" disabled={deleting} onClick={() => setDeleteTarget(null)}>
                Keep project
              </button>
              <button type="button" className="danger-action" disabled={deleting} onClick={() => void deleteProject()}>
                {deleting ? "Deleting…" : "Delete permanently"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}
function FolderArt() {
  return (
    <div className="empty-folder-art" aria-hidden="true">
      <Film size={36} />
    </div>
  );
}
