import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, Upload, X, Youtube } from "lucide-react";
import "./SourceImport.css";

export type YoutubeSourceInfo = {
  url: string;
  title: string;
  duration: number | string;
  width: number;
  height: number;
  qualities: number[];
};

type Props = {
  url: string;
  onUrl: (value: string) => void;
  onFile: (file?: File) => void;
  onInspect: (url: string, signal?: AbortSignal) => Promise<YoutubeSourceInfo>;
  onYoutube: (quality: number) => void;
  busy: boolean;
  uploading: boolean;
};

type InspectState = "idle" | "loading" | "success" | "error";

function defaultQuality(qualities: number[]) {
  const available = [...qualities].filter((quality) =>
    Number.isFinite(quality),
  );
  if (available.length === 0) return null;
  if (available.includes(720)) return 720;
  const below720 = available.filter((quality) => quality < 720);
  return below720.length > 0 ? Math.max(...below720) : Math.min(...available);
}

function formatDuration(duration: number | string) {
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return String(duration);
  }
  const totalSeconds = Math.max(0, Math.round(duration));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function inspectErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "We couldn't check that video. Check the URL and try again.";
}

/** Shared import choices for the empty workspace and the new-project dialog. */
export function SourceImport({
  url,
  onUrl,
  onFile,
  onInspect,
  onYoutube,
  busy,
  uploading,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const abortRequest = useRef<AbortController | null>(null);
  const [inspectState, setInspectState] = useState<InspectState>("idle");
  const [inspectError, setInspectError] = useState("");
  const [sourceInfo, setSourceInfo] = useState<YoutubeSourceInfo | null>(null);
  const [quality, setQuality] = useState<number | null>(null);

  const invalidateInspection = () => {
    requestId.current += 1;
    abortRequest.current?.abort();
    abortRequest.current = null;
    setInspectState("idle");
    setInspectError("");
    setSourceInfo(null);
    setQuality(null);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
      abortRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    // The URL is controlled by the parent, so invalidate metadata as soon as it changes.
    invalidateInspection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const inspect = async () => {
    const requestedUrl = url.trim();
    if (!requestedUrl || busy || inspectState === "loading") return;
    const currentRequest = ++requestId.current;
    abortRequest.current?.abort();
    const controller = new AbortController();
    abortRequest.current = controller;
    setInspectState("loading");
    setInspectError("");
    setSourceInfo(null);
    setQuality(null);
    try {
      const nextInfo = await onInspect(requestedUrl, controller.signal);
      if (
        !mounted.current ||
        currentRequest !== requestId.current ||
        controller.signal.aborted ||
        url.trim() !== requestedUrl
      ) {
        return;
      }
      setSourceInfo(nextInfo);
      setQuality(defaultQuality(nextInfo.qualities));
      setInspectState("success");
    } catch (error) {
      if (
        !mounted.current ||
        currentRequest !== requestId.current ||
        controller.signal.aborted
      ) {
        return;
      }
      setInspectError(inspectErrorMessage(error));
      setInspectState("error");
    } finally {
      if (currentRequest === requestId.current) abortRequest.current = null;
    }
  };

  const cancelInspection = () => {
    invalidateInspection();
  };

  const editLink = () => {
    invalidateInspection();
    requestAnimationFrame(() => urlInput.current?.focus());
  };

  return (
    <div className="source-import-choices">
      <button
        className="source-upload"
        type="button"
        disabled={busy || inspectState === "loading"}
        onClick={() => input.current?.click()}
      >
        <Upload size={22} />
        <strong>Upload a video</strong>
        <span>Choose a file or drop it here</span>
        <small>MP4, MOV, WebM · up to 500 MB</small>
      </button>
      <input
        ref={input}
        type="file"
        accept="video/*"
        aria-label="Video file"
        hidden
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          onFile(file);
        }}
      />
      <div className="or-rule">
        <span>or import a link</span>
      </div>
      <form
        className="source-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          void inspect();
        }}
      >
        <label>
          YouTube URL
          <div className="input-wrap">
            <Youtube size={18} />
            <input
              ref={urlInput}
              type="url"
              required
              value={url}
              disabled={busy}
              onChange={(event) => {
                if (event.target.value !== url) invalidateInspection();
                onUrl(event.target.value);
              }}
              placeholder="https://www.youtube.com/watch?v=…"
              aria-label="YouTube video URL"
            />
          </div>
        </label>
        <div className="source-link-actions">
          <button
            className="source-import-submit"
            type="submit"
            disabled={busy || !url.trim() || inspectState === "loading"}
          >
            {inspectState === "loading" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ArrowRight size={16} />
            )}
            {inspectState === "loading" ? "Checking video…" : "Check video"}
          </button>
          {inspectState === "loading" && (
            <button
              className="source-import-cancel"
              type="button"
              onClick={cancelInspection}
              aria-label="Cancel video check"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
      {inspectError && (
        <p className="source-import-error" role="alert">
          {inspectError}
        </p>
      )}
      {sourceInfo && inspectState === "success" && (
        <section
          className="source-video-details"
          aria-labelledby="source-video-title"
        >
          <div className="source-video-heading">
            <div>
              <h3 id="source-video-title">{sourceInfo.title}</h3>
              <p>
                {formatDuration(sourceInfo.duration)} · {sourceInfo.width} ×{" "}
                {sourceInfo.height}
              </p>
            </div>
            <button
              className="source-edit-link"
              type="button"
              onClick={editLink}
            >
              Edit link
            </button>
          </div>
          <label className="source-quality-field">
            Download quality
            <select
              value={quality ?? ""}
              onChange={(event) =>
                setQuality(
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              aria-label="Download quality"
              disabled={busy || uploading || sourceInfo.qualities.length === 0}
            >
              {sourceInfo.qualities.length === 0 ? (
                <option value="">No qualities available</option>
              ) : (
                sourceInfo.qualities.map((availableQuality) => (
                  <option key={availableQuality} value={availableQuality}>
                    {availableQuality}p
                  </option>
                ))
              )}
            </select>
          </label>
          <button
            className="source-import-submit source-import-video"
            type="button"
            disabled={busy || uploading || quality === null}
            onClick={() => quality !== null && onYoutube(quality)}
          >
            {uploading ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ArrowRight size={16} />
            )}
            {uploading
              ? "Starting import…"
              : `Import video at ${quality ?? "—"}p`}
          </button>
        </section>
      )}
      {busy && (
        <p className="source-import-status" role="status">
          {uploading
            ? "Uploading your source. Keep this page open."
            : "A video is processing. You can import another when it finishes."}
        </p>
      )}
      <p className="source-import-footer">
        Import the source, then configure moments, camera and captions before generating clips.
      </p>
    </div>
  );
}

export function NewProjectDialog({
  onClose,
  error,
  uploading,
  ...props
}: Props & { onClose: () => void; error: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const closeDialog = () => {
    if (!uploading) onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="new-project-dialog"
      aria-labelledby="new-project-title"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
    >
      <div className="new-project-heading">
        <div>
          <h2 id="new-project-title">New project</h2>
          <p>Start with a video file or a YouTube link.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Close new project"
          onClick={closeDialog}
          disabled={uploading}
        >
          <X size={20} />
        </button>
      </div>
      <SourceImport {...props} uploading={uploading} />
      {error && (
        <p className="source-import-error" role="alert">
          {error}
        </p>
      )}
      <p className="new-project-retained">
        Your existing projects remain in Projects.
      </p>
    </dialog>
  );
}
