import { useState } from "react";
import { Copy, Plus, Search, Trash2 } from "lucide-react";
import type { Clip } from "./editorTypes";
import {
  exportClipIds,
  isDiscarded,
  isSuggestion,
  matchesLibraryFilter,
  needsReview,
  type LibraryFilter,
  type LibraryPatch,
} from "./clipLibraryModel";
import "./ClipLibrary.css";

type Props = {
  clips: Clip[];
  activeId: string | null;
  busy: boolean;
  saving: boolean;
  canRestore: boolean;
  onEdit: (clip: Clip) => void;
  onPatch: (id: string, patch: LibraryPatch) => void;
  onDuplicate: (clip: Clip) => void;
  onRemove: (ids: string[]) => void;
  onDeletePermanent: (ids: string[]) => Promise<void>;
  onRestore: () => void;
  onAdd: () => void;
  onGenerate: () => void;
  onExport: (ids: string[]) => void;
  onAdobeExport: (ids: string[]) => void;
};

const filters: { id: LibraryFilter; label: string }[] = [
  { id: "all", label: "All clips" },
  { id: "pending", label: "To review" },
  { id: "kept", label: "Reviewed" },
  { id: "exported", label: "Exported" },
  { id: "discarded", label: "Discarded" },
];
const time = (value: number) =>
  `${Math.floor(value / 60)}:${Math.floor(value % 60)
    .toString()
    .padStart(2, "0")}`;

export default function ClipLibrary(props: Props) {
  const { clips, activeId, busy, saving, onPatch } = props;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [pendingRemove, setPendingRemove] = useState<string[] | null>(null);
  const [pendingPermanent, setPendingPermanent] = useState<string[] | null>(null);
  const [permanentDeleting, setPermanentDeleting] = useState(false);
  const visible = clips.filter((clip) =>
    matchesLibraryFilter(clip, filter, query),
  );
  const eligible = visible.filter((clip) => !isDiscarded(clip));
  const exportIds = exportClipIds(clips);
  const allChecked =
    eligible.length > 0 && eligible.every((clip) => clip.selected);
  const pending = clips.filter((clip) =>
    matchesLibraryFilter(clip, "pending", ""),
  );
  const requestRemove = (ids: string[]) => {
    if (ids.length) setPendingRemove(ids);
  };

  return (
    <section
      className="clip-library"
      aria-label="Clip library"
      data-tour="editor-library"
    >
      <header className="library-header">
        <div>
          <h2>
            Clips <span>{clips.length}</span>
          </h2>
          <p>Open a clip to edit. Check its box to export it.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Add clip at playhead"
          disabled={busy}
          onClick={props.onAdd}
        >
          <Plus size={18} />
        </button>
      </header>
      <div className="library-tools">
        <label className="library-search">
          <Search size={15} />
          <input
            aria-label="Search clips"
            placeholder="Search by name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="library-filter">
          Show
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as LibraryFilter)}
          >
            {filters.map(({ id, label }) => (
              <option key={id} value={id}>
                {label} (
                {
                  clips.filter((clip) => matchesLibraryFilter(clip, id, ""))
                    .length
                }
                )
              </option>
            ))}
          </select>
        </label>
        {pending.length > 0 && (
          <div className="library-review" data-tour="editor-review">
            <span>
              {pending.length} suggestion{pending.length === 1 ? "" : "s"} to
              review
            </span>
            <button
              disabled={saving || busy}
              onClick={() =>
                pending.forEach((clip) =>
                  onPatch(clip.id, { suggestion_status: "kept" }),
                )
              }
            >
              Keep all suggestions
            </button>
          </div>
        )}
      </div>
      <div className="library-list">
        {visible.map((clip) => {
          const active = clip.id === activeId;
          const discarded = isDiscarded(clip);
          const suggested = isSuggestion(clip);
          const clipNeedsReview = needsReview(clip);
          return (
            <article
              className={`library-clip${active ? " is-editing" : ""}`}
              key={clip.id}
              aria-label={`Clip ${clips.indexOf(clip) + 1}: ${clip.title}`}
            >
              <div className="library-clip-top">
                <label className="library-export-check">
                  <input
                    type="checkbox"
                    aria-label={`Include clip ${clips.indexOf(clip) + 1} in export`}
                    checked={Boolean(clip.selected) && !discarded}
                    disabled={discarded || saving}
                    onChange={(event) =>
                      onPatch(clip.id, { selected: event.target.checked })
                    }
                  />
                  <span>Clip {clips.indexOf(clip) + 1}</span>
                </label>
                <span className="library-clip-status">
                  {active
                    ? "Editing"
                    : discarded
                      ? "Discarded"
                      : clip.status === "exported"
                        ? "Exported"
                        : clip.reviewed
                          ? "Reviewed"
                          : clipNeedsReview
                            ? "To review"
                            : "Draft"}
                </span>
              </div>
              <button
                className="library-open"
                aria-label={`Edit clip ${clips.indexOf(clip) + 1}: ${clip.title}`}
                onClick={() => props.onEdit(clip)}
              >
                <strong>{clip.title}</strong>
                <span>
                  {time(clip.start)}–{time(clip.end)} ·{" "}
                  {time(clip.end - clip.start)} long
                </span>
              </button>
              {clip.reason && (
                <details className="library-reason">
                  <summary>Why this moment?</summary>
                  <p>{clip.reason}</p>
                </details>
              )}
              <div className="library-clip-actions">
                {discarded ? (
                  <button
                    disabled={saving}
                    onClick={() =>
                      onPatch(clip.id, { suggestion_status: "pending" })
                    }
                  >
                    Restore clip
                  </button>
                ) : (
                  <>
                    <button
                      className="library-edit"
                      onClick={() => props.onEdit(clip)}
                    >
                      {active ? "Edit settings" : "Edit clip"}
                    </button>
                    {clipNeedsReview ? (
                      <button
                        disabled={saving}
                        onClick={() =>
                          onPatch(clip.id, { suggestion_status: "kept" })
                        }
                      >
                        Keep
                      </button>
                    ) : (
                      <button
                        disabled={saving}
                        onClick={() =>
                          onPatch(clip.id, { reviewed: !clip.reviewed })
                        }
                      >
                        {clip.reviewed ? "Undo review" : "Mark reviewed"}
                      </button>
                    )}
                    {suggested && (
                      <button
                        disabled={saving}
                        onClick={() =>
                          onPatch(clip.id, { suggestion_status: "discarded" })
                        }
                      >
                        Discard
                      </button>
                    )}
                  </>
                )}
                <button
                  aria-label={`Duplicate clip ${clips.indexOf(clip) + 1}`}
                  disabled={busy || saving}
                  onClick={() => props.onDuplicate(clip)}
                >
                  <Copy size={14} />
                </button>
                <button
                  aria-label={`Remove clip ${clips.indexOf(clip) + 1}`}
                  disabled={busy || saving}
                  onClick={() => requestRemove([clip.id])}
                >
                  <Trash2 size={14} />
                </button>
                <button
                  className="permanent-delete-clip"
                  aria-label={`Permanently delete clip ${clips.indexOf(clip) + 1}`}
                  disabled={busy || saving}
                  onClick={() => setPendingPermanent([clip.id])}
                >
                  Delete permanently
                </button>
              </div>
            </article>
          );
        })}
        {!visible.length && (
          <div className="library-empty">
            <strong>
              {clips.length
                ? "No clips in this view"
                : "Create your first clip"}
            </strong>
            <p>
              {clips.length
                ? "Choose All clips or clear your search."
                : "Generate suggestions or add a clip at the playhead."}
            </p>
            <button
              onClick={
                clips.length
                  ? () => {
                      setFilter("all");
                      setQuery("");
                    }
                  : props.onGenerate
              }
            >
              {clips.length ? "Show all clips" : "Set up clips"}
            </button>
          </div>
        )}
      </div>
      <footer className="library-footer" data-tour="editor-selection">
        {eligible.length > 0 && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={allChecked}
              disabled={saving}
              onChange={(event) =>
                eligible.forEach((clip) =>
                  onPatch(clip.id, { selected: event.target.checked }),
                )
              }
            />
            Select {eligible.length} shown for export
          </label>
        )}
        <button
          className="export-button"
          disabled={!exportIds.length || busy || saving}
          onClick={() => props.onExport(exportIds)}
        >
          Export {exportIds.length || "selected"} clip
          {exportIds.length === 1 ? "" : "s"}
        </button>
        <div className="library-footer-actions">
          <button disabled={busy} onClick={props.onGenerate}>
            Generate more
          </button>
          <button
            disabled={!exportIds.length || busy || saving}
            title="Download selected clips as an editable Adobe handoff"
            onClick={() => props.onAdobeExport(exportIds)}
          >
            Adobe edit package
          </button>
          <button
            disabled={!exportIds.length || busy || saving}
            onClick={() => requestRemove(exportIds)}
          >
            Remove selected
          </button>
          <button
            className="permanent-delete-clip"
            disabled={!exportIds.length || busy || saving}
            onClick={() => setPendingPermanent(exportIds)}
          >
            Delete selected permanently
          </button>
          <button
            disabled={!clips.length || busy || saving}
            onClick={() => requestRemove(clips.map((clip) => clip.id))}
          >
            Clear clips
          </button>
        </div>
        {props.canRestore && (
          <button
            className="library-restore"
            disabled={busy}
            onClick={props.onRestore}
          >
            Undo last removal
          </button>
        )}
      </footer>
      {pendingRemove && (
        <div className="workspace-modal-backdrop" onClick={(event) => event.target === event.currentTarget && setPendingRemove(null)}>
          <div className="workspace-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-clips-title">
            <h2 id="remove-clips-title">Remove {pendingRemove.length} {pendingRemove.length === 1 ? "clip" : "clips"}?</h2>
            <p>These clips will leave the library and any export selection. You can undo this removal from the library footer.</p>
            <footer>
              <button type="button" className="secondary-action" onClick={() => setPendingRemove(null)}>Keep clips</button>
              <button type="button" className="danger-action" disabled={busy || saving} onClick={() => { props.onRemove(pendingRemove); setPendingRemove(null); }}>Remove clips</button>
            </footer>
          </div>
        </div>
      )}
      {pendingPermanent && (
        <div className="workspace-modal-backdrop" onClick={(event) => event.target === event.currentTarget && setPendingPermanent(null)}>
          <div className="workspace-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-clips-title">
            <h2 id="delete-clips-title">Permanently delete {pendingPermanent.length} {pendingPermanent.length === 1 ? "clip" : "clips"}?</h2>
            <p>This permanently removes the selected clip data and its previews/exports. It cannot be undone and will not be restored by Undo.</p>
            <footer>
              <button type="button" className="secondary-action" onClick={() => setPendingPermanent(null)}>Keep clips</button>
              <button type="button" className="danger-action" disabled={busy || saving || permanentDeleting} onClick={async () => {
                setPermanentDeleting(true);
                try {
                  await props.onDeletePermanent(pendingPermanent);
                  setPendingPermanent(null);
                } finally {
                  setPermanentDeleting(false);
                }
              }}>{permanentDeleting ? "Deleting…" : "Delete permanently"}</button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
