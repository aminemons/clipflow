import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  LoaderCircle,
  RefreshCw,
  Upload,
  X,
  Youtube,
} from "lucide-react";
import { ApiError } from "./apiClient";
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
  hosted?: boolean;
  onDesktopImport?: (url: string, quality: number) => Promise<string>;
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

type InspectFailure = {
  title: string;
  message: string;
  retryable: boolean;
};

function inspectFailure(error: unknown): InspectFailure {
  if (error instanceof ApiError) {
    return {
      title:
        error.code === "youtube_anti_bot"
          ? "YouTube blocked this connection"
          : "We couldn't check this video",
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    title: "We couldn't check this video",
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : "Check the URL and try again.",
    retryable: true,
  };
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
  hosted = false,
  onDesktopImport,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const abortRequest = useRef<AbortController | null>(null);
  const [inspectState, setInspectState] = useState<InspectState>("idle");
  const [inspectError, setInspectError] = useState<InspectFailure | null>(null);
  const [sourceInfo, setSourceInfo] = useState<YoutubeSourceInfo | null>(null);
  const [quality, setQuality] = useState<number | null>(null);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopError, setDesktopError] = useState("");
  const [desktopStarted, setDesktopStarted] = useState(false);
  const [desktopLaunchUrl, setDesktopLaunchUrl] = useState("");

  const invalidateInspection = () => {
    requestId.current += 1;
    abortRequest.current?.abort();
    abortRequest.current = null;
    setInspectState("idle");
    setInspectError(null);
    setSourceInfo(null);
    setQuality(null);
    setDesktopError("");
    setDesktopStarted(false);
    setDesktopLaunchUrl("");
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
    setInspectError(null);
    setSourceInfo(null);
    setQuality(null);
    setDesktopError("");
    setDesktopLaunchUrl("");
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
      setInspectError(inspectFailure(error));
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

  const importWithDesktop = async () => {
    if (!onDesktopImport || !url.trim() || desktopBusy) return;
    setDesktopBusy(true);
    setDesktopError("");
    try {
      const launchUrl = await onDesktopImport(url.trim(), quality ?? 720);
      const target = new URL(launchUrl);
      if (target.protocol !== "clipflow:" || target.hostname !== "import") {
        throw new Error("Clipflow returned an invalid desktop link. Please try again.");
      }
      setDesktopLaunchUrl(launchUrl);
      setDesktopStarted(true);
      window.location.assign(launchUrl);
    } catch (error) {
      setDesktopError(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Couldn't prepare the desktop import. Please try again.",
      );
    } finally {
      setDesktopBusy(false);
    }
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
        <div className="source-import-error" role="alert">
          <h3>{inspectError.title}</h3>
          <p>{inspectError.message}</p>
          <div className="source-error-actions">
            {inspectError.retryable && (
              <button
                className="source-import-cancel"
                type="button"
                disabled={busy}
                onClick={() => void inspect()}
              >
                <RefreshCw size={15} /> Retry
              </button>
            )}
            <button
              className="source-import-submit"
              type="button"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload size={16} /> Upload a video
            </button>
          </div>
          <small>
            On the web, YouTube may reject requests from shared servers. The
            desktop app uses your own connection and may work when the web app
            cannot.
          </small>
          {hosted && inspectError.title === "YouTube blocked this connection" && (
            <div className="source-desktop-import">
              <label className="source-quality-field">
                Desktop download quality
                <select
                  value={quality ?? 720}
                  onChange={(event) => setQuality(Number(event.target.value))}
                  aria-label="Desktop download quality"
                  disabled={desktopBusy}
                >
                  {[360, 720, 1080].map((value) => (
                    <option key={value} value={value}>{value}p</option>
                  ))}
                </select>
              </label>
              <p>Install or open Clipflow Desktop. It downloads the source on your computer and sends it back to this hosted workspace when finished. If the desktop app does not open, use Upload a video above.</p>
              <button
                className="source-import-submit"
                type="button"
                disabled={desktopBusy || busy}
                onClick={() => void importWithDesktop()}
              >
                {desktopBusy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}
                {desktopBusy ? "Preparing desktop import…" : "Import with desktop"}
              </button>
              {desktopError && <p className="source-desktop-error" role="alert">{desktopError}</p>}
              {desktopStarted && <p className="source-desktop-status" role="status">Opening Clipflow Desktop. If your browser blocks the automatic launch, use the button below.</p>}
              {desktopLaunchUrl && <a className="source-import-submit" href={desktopLaunchUrl}>Open Clipflow Desktop</a>}
            </div>
          )}
        </div>
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
        Import the source, then configure moments, camera and captions before
        generating clips.
      </p>
    </div>
  );
}

export function NewProjectDialog({
  onClose,
  error,
  uploading,
  hosted,
  onDesktopImport,
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
      <SourceImport {...props} uploading={uploading} hosted={hosted} onDesktopImport={onDesktopImport} />
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
