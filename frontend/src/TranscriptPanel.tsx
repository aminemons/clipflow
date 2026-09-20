import { useEffect, useState } from "react";
import { Play, Search, Scissors, Check } from "lucide-react";
import "./TranscriptPanel.css";

export type TranscriptSegment = { start: number; end: number; text: string };
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export default function TranscriptPanel({
  projectId,
  segments,
  busy,
  onSeek,
  onSave,
  onCreateClip,
  onTranscribe,
}: {
  projectId: string;
  segments: TranscriptSegment[];
  busy: boolean;
  onSeek: (time: number) => void;
  onSave: (segments: TranscriptSegment[]) => Promise<void>;
  onCreateClip: (start: number, end: number, title: string) => Promise<void>;
  onTranscribe: () => void;
}) {
  const [draft, setDraft] = useState(segments);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<[number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(100);
  useEffect(() => {
    setDraft(segments);
  }, [segments]);
  useEffect(() => {
    setRange(null);
    setQuery("");
    setMessage("");
    setError("");
  }, [projectId]);
  useEffect(() => setLimit(100), [query]);
  const dirty = draft.some((row, i) => row.text !== segments[i]?.text);
  const matches = draft
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      row.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
  const from = range ? Math.min(...range) : -1;
  const to = range ? Math.max(...range) : -1;
  const locked = saving || busy;

  async function save(create = false) {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      if (dirty) await onSave(draft);
      if (create && range) {
        await onCreateClip(
          draft[from].start,
          draft[to].end,
          draft[from].text.trim().slice(0, 150) || "Transcript clip",
        );
        setMessage("Clip created. Find it in Clips.");
      } else
        setMessage("Transcript saved. Captions will use your corrections.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save transcript.");
    } finally {
      setSaving(false);
    }
  }

  if (!segments.length)
    return (
      <section className="transcript-empty">
        <h3>Find your words</h3>
        <p>
          Transcribe the source to search speech, correct captions, and turn a
          passage into a clip.
        </p>
        <button
          className="outline-button"
          disabled={!projectId || locked}
          onClick={onTranscribe}
        >
          Transcribe source
        </button>
      </section>
    );

  return (
    <section className="transcript-pane" aria-label="Transcript editor">
      <div className="transcript-tools">
        <label className="transcript-search">
          <Search size={14} />
          <input
            aria-label="Search transcript"
            placeholder="Find a word or phrase"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <p>
          Correct the text below. Select the first and last passage to make a
          clip, including everything between them.
        </p>
        <div className="transcript-actions">
          <button
            className="outline-button"
            disabled={!dirty || locked}
            onClick={() => void save()}
          >
            <Check size={13} /> {saving ? "Saving…" : "Save corrections"}
          </button>
          {dirty && (
            <button
              className="transcript-link"
              disabled={locked}
              onClick={() => setDraft(segments)}
            >
              Discard edits
            </button>
          )}
        </div>
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="transcript-error">
            {error}
          </p>
        )}
      </div>
      <div className="transcript-rows">
        {!matches.length && (
          <p className="transcript-no-match">No matching speech.</p>
        )}
        {matches.slice(0, limit).map(({ row, index }) => (
          <article
            className={`transcript-row ${index >= from && index <= to && range ? "chosen" : ""}`}
            key={index}
          >
            <div className="transcript-row-head">
              <label>
                <input
                  type="checkbox"
                  aria-label={`Select passage ${index + 1}`}
                  checked={!!range && index >= from && index <= to}
                  disabled={locked}
                  onChange={() =>
                    setRange((current) =>
                      current ? [current[0], index] : [index, index],
                    )
                  }
                />
                <span>Passage {index + 1}</span>
              </label>
              <button
                className="transcript-link"
                aria-label={`Go to passage ${index + 1}`}
                onClick={() => onSeek(row.start)}
              >
                <Play size={11} />
                {time(row.start)} – {time(row.end)}
              </button>
            </div>
            <textarea
              aria-label={`Transcript passage ${index + 1}`}
              dir="auto"
              maxLength={4000}
              disabled={locked}
              value={row.text}
              onChange={(e) =>
                setDraft((current) =>
                  current.map((item, i) =>
                    i === index ? { ...item, text: e.target.value } : item,
                  ),
                )
              }
            />
          </article>
        ))}
        {matches.length > limit && (
          <button
            className="outline-button"
            onClick={() => setLimit(limit + 100)}
          >
            Show more passages
          </button>
        )}
      </div>
      <div className="transcript-selection">
        {range ? (
          <>
            <span>
              {time(draft[from]?.start ?? 0)} – {time(draft[to]?.end ?? 0)}{" "}
              selected
            </span>
            <button className="transcript-link" onClick={() => setRange(null)}>
              Clear selection
            </button>
          </>
        ) : (
          <span>Select passages to create a clip.</span>
        )}
        <button
          className="export-button"
          disabled={!range || locked}
          onClick={() => void save(true)}
        >
          <Scissors size={14} /> Create clip from passage
        </button>
      </div>
    </section>
  );
}
