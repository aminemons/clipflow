import { useEffect, useState, type ReactNode } from "react";
import { HardDrive, HelpCircle, RotateCcw, Trash2 } from "lucide-react";
import type { Health, Project } from "./editorTypes";
type Storage = {
  used: {
    source_bytes: number;
    export_bytes: number;
    media_bytes: number;
    model_bytes: number;
    total_bytes: number;
  };
  free_bytes: number;
  cached_at: string;
};
const bytes = (n: number) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
export default function SettingsPage({
  api,
  health,
  projects,
  onTour,
  onNotice,
  onPreviewsCleared,
  children,
  publishing,
  initialTab = "processing",
}: {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  health: Health;
  projects: Project[];
  onTour: () => void;
  onNotice: (message: string) => void;
  onPreviewsCleared: (projectId: string) => void;
  children: ReactNode;
  publishing: ReactNode;
  initialTab?: string;
}) {
  const [tab, setTab] = useState(initialTab);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  async function load() {
    setError("");
    try {
      setStorage(await api<Storage>("/storage"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Storage is unavailable.");
    }
  }
  useEffect(() => {
    if (tab === "storage") void load();
  }, [tab]);
  async function clean(id: string) {
    setBusy(id);
    setError("");
    try {
      const result = await api<{ freed_bytes: number; removed_count: number }>(
        `/projects/${id}/cleanup`,
        { method: "POST" },
      );
      onNotice(
        `Removed ${result.removed_count} rendered previews (${bytes(result.freed_bytes)}).`,
      );
      onPreviewsCleared(id);
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove previews.");
    } finally {
      setBusy("");
    }
  }
  return (
    <main className="workspace-page settings-page">
      <header className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>
            Processing preferences, storage, and a little help when you need it.
          </p>
        </div>
        <button className="secondary-action" onClick={onTour}>
          <HelpCircle size={17} />
          Take a tour
        </button>
      </header>
      <div className="library-topline">
        <div className="page-tabs">
          {[
            ["processing", "Processing & providers"],
            ["publishing", "Publishing accounts"],
            ["storage", "Storage"],
            ["help", "Getting started"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "is-active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-page-content">
        <div hidden={tab !== "processing"}>{children}</div>
        <div hidden={tab !== "publishing"}>{publishing}</div>
        {tab === "storage" && (
          <section className="storage-panel">
            <h2>
              <HardDrive size={21} /> Storage on this computer
            </h2>
            <p>
              Source files and exports are kept separately. Archiving a project
              hides it from the library; it does not free disk space.
            </p>
            {error && (
              <p className="workspace-error" role="alert">
                {error}
              </p>
            )}
            {storage ? (
              <>
                <div className="storage-breakdown">
                  <div>
                    <span>Original videos</span>
                    <strong>{bytes(storage.used.source_bytes)}</strong>
                  </div>
                  <div>
                    <span>Finished exports</span>
                    <strong>{bytes(storage.used.export_bytes)}</strong>
                  </div>
                  <div>
                    <span>Previews & other media</span>
                    <strong>{bytes(storage.used.media_bytes)}</strong>
                  </div>
                </div>
                <p>
                  Speech models:{" "}
                  <strong>{bytes(storage.used.model_bytes)}</strong>. Free on
                  the video drive: <strong>{bytes(storage.free_bytes)}</strong>.
                </p>
              </>
            ) : (
              <p>Reading storage usage…</p>
            )}
            <button className="secondary-action" onClick={load}>
              <RotateCcw size={15} />
              Refresh storage
            </button>
            <h3>Clear rendered previews</h3>
            <p>
              Remove temporary proof videos when you need space. Original
              videos, edits, captions, and exported files are preserved. You can
              render a proof again.
            </p>
            {projects
              .filter((p) => p.duration > 0)
              .map((p) => (
                <div key={p.id}>
                  <div className="storage-cleanup-row">
                    <span>{p.title}</span>
                    <button
                      className="secondary-action"
                      disabled={!!busy}
                      onClick={() => setConfirm(p.id)}
                    >
                      <Trash2 size={14} />
                      {busy === p.id ? "Removing…" : "Clear previews"}
                    </button>
                  </div>
                  {confirm === p.id && (
                    <div className="inline-confirm">
                      <p>Remove the rendered previews for “{p.title}”?</p>
                      <button disabled={!!busy} onClick={() => clean(p.id)}>
                        Remove previews
                      </button>
                      <button onClick={() => setConfirm(null)}>Cancel</button>
                    </div>
                  )}
                </div>
              ))}
          </section>
        )}
        {tab === "help" && (
          <section className="help-panel">
            <h2>From a video to finished clips</h2>
            <p>
              Start with the free tools. Optional providers can be connected
              whenever you need them.
            </p>
            <button className="primary-action" onClick={onTour}>
              <HelpCircle size={17} />
              Start the interactive tour
            </button>
            <div className="help-steps">
              <div>
                <h3>1. Add a source</h3>
                <p>
                  Choose New project, upload a video, or paste a YouTube URL.
                  Import creates a separate project and keeps the original
                  video.
                </p>
              </div>
              <div>
                <h3>2. Choose your clips</h3>
                <p>
                  Full video covers the entire source. Smart highlights suggests
                  selected passages around your target length. Review the
                  reasons, keep the useful clips, and discard the rest.
                </p>
              </div>
              <div>
                <h3>3. Make the edit</h3>
                <p>
                  Use the Layout, Captions, and Audio tabs. Drag timeline
                  handles or type start and end times. Zoom into short moments.
                  Editing one clip does not change the export checkboxes.
                </p>
              </div>
              <div>
                <h3>4. Check a proof, then export</h3>
                <p>
                  Source playback is an editing approximation. Render proof
                  shows the final framing, captions, speed and audio effects.
                  Export a clip or select several for a ZIP; previous versions
                  stay in Exports.
                </p>
              </div>
            </div>
            <h3>Keyboard shortcuts in the editor</h3>
            <div className="shortcut-table">
              {[
                ["Play / pause", "Space"],
                ["Set start", "I"],
                ["Set end", "O"],
                ["Undo", "Ctrl / ⌘ Z"],
                ["Redo", "Ctrl / ⌘ Y"],
                ["Seek", "← / →"],
                ["Larger seek", "Shift + ← / →"],
                ["Close expanded preview", "Esc"],
              ].map(([name, key]) => (
                <div key={name}>
                  <span>{name}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
            <p>
              FFmpeg: {health.ffmpeg ? "available" : "unavailable"} ·
              Transcription:{" "}
              {health.transcription ? "available" : "check installation"}
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
