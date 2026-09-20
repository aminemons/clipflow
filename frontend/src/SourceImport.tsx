import { useEffect, useRef } from "react";
import { ArrowRight, LoaderCircle, Upload, X, Youtube } from "lucide-react";
import "./SourceImport.css";

type Props = {
  url: string;
  onUrl: (value: string) => void;
  onFile: (file?: File) => void;
  onYoutube: () => void;
  busy: boolean;
  uploading: boolean;
};

/** Shared import choices for the empty workspace and the new-project dialog. */
export function SourceImport({
  url,
  onUrl,
  onFile,
  onYoutube,
  busy,
  uploading,
}: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="source-import-choices">
      <button
        className="source-upload"
        disabled={busy}
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
          if (!busy) onYoutube();
        }}
      >
        <label>
          YouTube URL
          <div className="input-wrap">
            <Youtube size={18} />
            <input
              type="url"
              required
              value={url}
              disabled={busy}
              onChange={(event) => onUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
            />
          </div>
        </label>
        <button
          className="source-import-submit"
          type="submit"
          disabled={busy || !url.trim()}
        >
          {uploading ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ArrowRight size={16} />
          )}
          {uploading ? "Starting import…" : "Import YouTube video"}
        </button>
      </form>
      {busy && (
        <p className="source-import-status" role="status">
          {uploading
            ? "Uploading your source. Keep this page open."
            : "A video is processing. You can import another when it finishes."}
        </p>
      )}
    </div>
  );
}

export function NewProjectDialog({
  onClose,
  error,
  ...props
}: Props & { onClose: () => void; error: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="new-project-dialog"
      aria-labelledby="new-project-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
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
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <SourceImport {...props} />
      {error && (
        <p className="source-import-error" role="alert">
          {error}
        </p>
      )}
      <p className="new-project-retained">
        Your existing projects and clips stay saved in Your sources.
      </p>
    </dialog>
  );
}
