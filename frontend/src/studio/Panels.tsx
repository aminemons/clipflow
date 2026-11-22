import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, AudioLines, Captions, Check, CheckCircle2, ChevronRight, Clapperboard, Clipboard,
  Download, Film, Focus, FolderOpen, FolderUp, MonitorPlay, Play, Plus, ScanLine, Scissors, Search, Sparkles, Target, Trash2, Upload,
} from "lucide-react";
import { canvasSize } from "./compositor";
import { captionStyles, clamp, clipCues, destinationFor, destinations, elapsed, goals, lengthOf, makeId, motions, precise, round, trimSpan, type Candidate, type Cut, type Graphic, type Project } from "./model";
import type { Playback, Playhead } from "./Monitor";
import type { SubtitleSegment } from "../subtitleImport";

export type Update = (patch: Partial<Project>, history?: boolean) => void;
export type Accept = (item: Candidate) => void;

export function Panel({ icon, title, children, className = "" }: { icon: ReactNode; title: string; children: ReactNode; className?: string }) {
  return <section className={`cf-panel ${className}`} aria-label={title}>
    <header className="cf-panel-head"><span className="cf-panel-title">{icon}{title}</span></header>
    <div className="cf-panel-body">{children}</div>
  </section>;
}

export function BriefPanel({ project, update, canAI, canTranscribe, busy, openAI, onTranscribe, onSubtitles, onFind, onDraft, goBuild }: {
  project: Project; update: Update; canAI: boolean; canTranscribe: boolean; busy: boolean; openAI: () => void;
  onTranscribe: () => void; onSubtitles: () => void; onFind: (useAI: boolean) => void; onDraft: () => void; goBuild: () => void;
}) {
  return <Panel icon={<Target size={17} />} title="Clip brief">
    <p className="cf-panel-intro">Tell Clipflow what this clip should do.</p>
    <label className="cf-field">Editing goal<select value={project.goal} onChange={event => update({ goal: event.target.value as Project["goal"] })}>{goals.map(goal => <option key={goal}>{goal}</option>)}</select></label>
    <label className="cf-field">Topic <span>optional</span><input key={project.id} value={project.subject} maxLength={500} placeholder="What should viewers take away?" onChange={event => update({ subject: event.target.value }, false)} /></label>
    <div className="cf-field">Target length<div className="cf-choose-length">{[15, 30, 45, 60].map(seconds => <button key={seconds} className={project.target === seconds ? "is-active" : ""} onClick={() => update({ target: seconds })} aria-pressed={project.target === seconds}>{seconds}s</button>)}</div></div>
    <label className="cf-field">Destination<select value={project.destination} onChange={event => update({ destination: event.target.value as Project["destination"] })}>{destinations.map(item => <option key={item.id} value={item.id}>{item.label} · {item.ratio}</option>)}</select></label>
    <div className="cf-panel-divider" />
    <div className="cf-transcript-state"><Captions size={18} /><div><strong>Source transcript</strong><small>{project.transcript.length ? `${project.transcript.length} timed cues available` : "Add dialogue to find stronger moments."}</small></div></div>
    <div className="cf-inline-actions"><button className="cf-small" onClick={onSubtitles} disabled={busy}><Upload size={14} /> SRT / VTT</button><button className="cf-small" onClick={canTranscribe ? onTranscribe : openAI} disabled={busy}><AudioLines size={14} /> Transcribe</button></div>
    <button className="cf-primary cf-fill" onClick={() => onFind(canAI && !!project.transcript.length)} disabled={busy}><Sparkles size={16} /> {canAI && project.transcript.length ? "Find with GPT" : "Find moments"}</button>
    {canAI && project.transcript.length > 0 && <button className="cf-link cf-fill" onClick={() => onFind(false)} disabled={busy}>Use local suggestions</button>}
    <div className="cf-brief-actions"><button className="cf-small" onClick={onDraft} disabled={busy}><Scissors size={14} /> Draft a first cut</button><button className="cf-link" onClick={goBuild}>Edit manually</button></div>
  </Panel>;
}

export function MomentsPanel({ project, playingStart, accept, seek, goNext }: {
  project: Project; playingStart: number | null; accept: Accept; seek: (time: number, end: number) => void; goNext: () => void;
}) {
  return <Panel icon={<Sparkles size={17} />} title="Suggested moments" className="cf-moments-panel">
    {project.candidates.length ? <>
      <p className="cf-panel-intro">Preview a moment, then use it as the basis of your clip.</p>
      <div className="cf-moments">{project.candidates.map((item, index) => {
        const selected = project.cut.spans.length === 1 && Math.abs(project.cut.spans[0].start - item.start) < 0.01 && Math.abs(project.cut.spans[0].end - item.end) < 0.01;
        return <article className={`cf-moment ${selected ? "is-selected" : ""}`} key={item.id}>
          <div className="cf-moment-top"><span>{String(index + 1).padStart(2, "0")} <i /> {elapsed(item.start)}–{elapsed(item.end)}</span><span>{Math.round(item.end - item.start)}s</span></div>
          <h3>{item.title}</h3>
          <p>{item.reason}</p>
          <div className="cf-moment-actions">
            <button className="cf-icon" aria-label={`Preview ${item.title}`} title="Play this moment" onClick={() => seek(item.start, item.end)} aria-pressed={playingStart === item.start}><Play size={15} fill="currentColor" /></button>
            <button className="cf-small" onClick={() => selected ? goNext() : accept(item)}>{selected ? <><Check size={14} /> Edit selected</> : <>Use this moment <ChevronRight size={14} /></>}</button>
          </div>
        </article>;
      })}</div>
    </> : <div className="cf-empty"><Search size={23} /><strong>Find a starting point</strong><p>Choose a goal and select Find moments to turn a source into suggested clips.</p></div>}
  </Panel>;
}

export function ImportPanel({ project, openFile, openBackup, openLibrary, go }: { project: Project; openFile: () => void; openBackup: () => void; openLibrary: () => void; go: () => void }) {
  return <Panel title="Source media" icon={<Clapperboard size={17} />}>
    <p className="cf-panel-intro">Choose a recording from your device, or pick up an existing project.</p>
    <button className="cf-drop" onClick={openFile}><FolderUp size={25} /><strong>Choose video</strong><span>MP4, MOV or WebM</span></button>
    <button className="cf-secondary cf-fill" onClick={openBackup}><FolderOpen size={16} /> Open a project backup</button>
    <button className="cf-secondary cf-fill" onClick={openLibrary}><Film size={16} /> Browse local projects</button>
    <div className="cf-panel-divider" />
    <div className="cf-file-summary"><Film size={21} /><div><strong>{project.sourceName}</strong><small>{project.width} × {project.height} · {elapsed(project.duration)}</small></div></div>
    <button className="cf-primary cf-fill" onClick={go}>Find moments <ChevronRight size={16} /></button>
  </Panel>;
}

export function SourcePanel({ project, onTime }: { project: Project; onTime: (time: number) => void }) {
  return <Panel title="Working source" icon={<Film size={17} />}>
    {project.demo && <img className="cf-source-thumb" src="/studio/sample.webp" alt="Fog moving across a dark mountain ridge" />}
    <div className="cf-file-summary"><Film size={20} /><div><strong>{project.sourceName}</strong><small>{elapsed(project.duration)} · {project.width} × {project.height}</small></div></div>
    <button className="cf-secondary cf-fill" onClick={() => onTime(0)}><MonitorPlay size={16} /> Open in source monitor</button>
    {project.demo && <p className="cf-help">Sample footage by Athulvis, CC BY-SA 4.0. Cropped and color-adjusted with sample narration added. <a href="https://commons.wikimedia.org/wiki/File:Fog_covering_mountain_time_lapse.webm" target="_blank" rel="noreferrer">Credits</a></p>}
  </Panel>;
}

export function CutPanel({ project, update, selected, select, seek, playhead, mode, mark, setMark, addMark, tighten, go, notify }: {
  project: Project; update: Update; selected: string; select: (id: string) => void;
  seek: (mode: Playback["mode"], t: number) => void; playhead: Playhead; mode: Playback["mode"];
  mark: number | null; setMark: (time: number) => void; addMark: () => void; tighten: () => void; go: () => void; notify: (text: string) => void;
}) {
  const { cut } = project;
  const span = cut.spans.find(item => item.id === selected) ?? cut.spans[0];
  const pieces = cut.spans;
  const position = pieces.findIndex(item => item.id === span.id);
  const updateSpan = (key: "start" | "end", value: number) => update({ cut: { ...cut, spans: pieces.map(item => item.id === span.id ? trimSpan(item, key, value, project.duration) : item) } });
  const move = (direction: number) => {
    const next = [...pieces];
    [next[position], next[position + direction]] = [next[position + direction], next[position]];
    update({ cut: { ...cut, spans: next } });
  };
  return <Panel title="Build the cut" icon={<Scissors size={17} />}>
    <p className="cf-panel-intro">Keep only what the viewer needs. Set exact edges or add another part of the source.</p>
    <div className="cf-range-list">{pieces.map((item, index) => <button key={item.id} className={item.id === span.id ? "is-active" : ""} onClick={() => { select(item.id); seek("cut", lengthOf(pieces.slice(0, index))); }}><span>{String(index + 1).padStart(2, "0")}</span><strong>{precise(item.start)}–{precise(item.end)}</strong><ChevronRight size={13} /></button>)}</div>
    <div className="cf-duo">
      <label className="cf-field">In (seconds)<input type="number" min={0} max={span.end} step={0.01} key={span.id + span.start + "start"} defaultValue={span.start} onBlur={event => { if (event.target.value !== "") updateSpan("start", +event.target.value); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      <label className="cf-field">Out (seconds)<input type="number" min={span.start} max={project.duration} step={0.01} key={span.id + span.end + "end"} defaultValue={span.end} onBlur={event => { if (event.target.value !== "") updateSpan("end", +event.target.value); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
    </div>
    <div className="cf-inline-actions">
      <button className="cf-icon" disabled={position < 1} onClick={() => move(-1)} title="Move range earlier" aria-label="Move range earlier"><ArrowUp size={17} /></button>
      <button className="cf-icon" disabled={position >= pieces.length - 1} onClick={() => move(1)} title="Move range later" aria-label="Move range later"><ArrowDown size={17} /></button>
      <button className="cf-icon" disabled={pieces.length === 1} onClick={() => { update({ cut: { ...cut, spans: pieces.filter(item => item.id !== span.id) } }); select(pieces[position ? position - 1 : 1].id); }} title="Remove range" aria-label="Remove range"><Trash2 size={16} /></button>
    </div>
    <div className="cf-panel-divider" />
    <div className="cf-inline-actions"><button className="cf-small" onClick={() => { if (mode !== "source") { seek("source", playhead.source); notify("Source monitor is open. Find your starting point, then press Mark in."); } else setMark(round(playhead.source)); }}><ScanLine size={15} /> {mark === null ? "Mark in" : `In · ${precise(mark)}`}</button><button className="cf-small" onClick={addMark} disabled={mode !== "source" || mark === null}><Plus size={15} /> Add at out</button></div>
    <button className="cf-secondary cf-fill" disabled={!project.transcript.length} onClick={tighten}><Scissors size={15} /> Tighten pauses</button>
    <button className="cf-primary cf-fill" onClick={go}>Style the clip <ChevronRight size={16} /></button>
  </Panel>;
}

export function TranscriptPanel({ project, onChange, onAdd, seek }: {
  project: Project; onChange: (index: number, cue: SubtitleSegment | null) => void; onAdd: () => void; seek: (time: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [start, setStart] = useState<number | null>(null);
  const matches = useMemo(() => project.transcript.map((cue, index) => ({ cue, index })).filter(({ cue }) => cue.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [project.transcript, query]);
  const pageSize = 32;
  const activePage = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  return <Panel title="Transcript" icon={<Captions size={17} />}>
    <p className="cf-panel-intro">Click a time to hear the line. Correct the words here and the clip captions update.</p>
    <label className="cf-search"><Search size={15} /><input aria-label="Search transcript" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Search dialogue" /></label>
    <div className="cf-transcript-list">{matches.slice(activePage * pageSize, (activePage + 1) * pageSize).map(({ cue, index }) => <div className="cf-transcript-cue" key={`${index}-${cue.start}`}>
      <button className="cf-label-button" aria-label={`Seek to ${elapsed(cue.start)}`} onClick={() => seek(cue.start)}>{elapsed(cue.start)}</button>
      <textarea aria-label={`Caption ${index + 1}`} maxLength={12000} key={cue.text} rows={2} defaultValue={cue.text} onBlur={event => { const text = event.target.value.trim(); if (text && text !== cue.text) onChange(index, { ...cue, text }); if (!text) event.target.value = cue.text; }} />
      <button className="cf-icon cf-cue-edit" aria-label={`Edit caption ${index + 1} timing`} title="Edit timing" onClick={() => setStart(start === index ? null : index)}><ScanLine size={15} /></button>
      {start === index && <div className="cf-cue-timing">
        <label className="cf-field">In (s)<input aria-label="Caption in seconds" type="number" step={0.01} key={cue.start} defaultValue={cue.start} onBlur={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) onChange(index, { ...cue, start: round(clamp(value, 0, cue.end - 0.01)) }); }} /></label>
        <label className="cf-field">Out (s)<input aria-label="Caption out seconds" type="number" step={0.01} key={cue.end} defaultValue={cue.end} onBlur={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) onChange(index, { ...cue, end: round(clamp(value, cue.start + 0.01, project.duration)) }); }} /></label>
        <button className="cf-icon" aria-label={`Remove caption ${index + 1}`} onClick={() => { onChange(index, null); setStart(null); }}><Trash2 size={16} /></button>
      </div>}
    </div>)}
    {!matches.length && <div className="cf-empty"><Captions size={24} /><strong>{query ? "No matching dialogue" : "No timed captions yet"}</strong><p>{query ? "Try a different word." : "Import a transcript, transcribe the source, or add a cue at the playhead."}</p></div>}</div>
    {matches.length > pageSize && <div className="cf-inline-actions cf-pagination"><button className="cf-small" onClick={() => setPage(activePage - 1)} disabled={!activePage}>Previous</button><small>{activePage + 1} / {Math.ceil(matches.length / pageSize)}</small><button className="cf-small" onClick={() => setPage(activePage + 1)} disabled={(activePage + 1) * pageSize >= matches.length}>Next</button></div>}
    <button className="cf-secondary cf-fill" onClick={onAdd}><Plus size={16} /> Add caption at playhead</button>
  </Panel>;
}

export function StylePanel({ project, update, go }: { project: Project; update: Update; go: () => void }) {
  const patch = (settings: Partial<Cut>, history = true) => update({ cut: { ...project.cut, ...settings } }, history);
  return <Panel title="Framing & captions" icon={<Focus size={17} />}>
    <p className="cf-panel-intro">Keep the subject in frame and the words easy to read on a phone.</p>
    <label className="cf-field">Canvas<select value={project.destination} onChange={event => update({ destination: event.target.value as Project["destination"] })}>{destinations.map(item => <option value={item.id} key={item.id}>{item.label} · {item.ratio}</option>)}</select></label>
    <div className="cf-field">Background<div className="cf-choose-length">{(["fill","fit","blur"] as const).map(item => <button key={item} className={project.cut.frame === item ? "is-active" : ""} aria-pressed={project.cut.frame === item} onClick={() => patch({ frame: item })}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div></div>
    <label className="cf-field">Horizontal framing <span>{project.cut.focus}%</span><input type="range" min={0} max={100} value={project.cut.focus} onChange={event => patch({ focus: +event.target.value }, false)} /></label>
    <label className="cf-field">Zoom <span>{project.cut.zoom}%</span><input type="range" min={100} max={180} value={project.cut.zoom} onChange={event => patch({ zoom: +event.target.value }, false)} /></label>
    <div className="cf-panel-divider" />
    <label className="cf-check-line"><input type="checkbox" checked={project.cut.captions} onChange={event => patch({ captions: event.target.checked })} /> Show captions</label>
    <label className="cf-field">Caption style<select value={project.cut.captionStyle} onChange={event => patch({ captionStyle: event.target.value as Cut["captionStyle"] })}>{captionStyles.map(item => <option key={item}>{item}</option>)}</select></label>
    <label className="cf-field">Caption size <span>{project.cut.captionSize}%</span><input type="range" min={70} max={145} value={project.cut.captionSize} onChange={event => patch({ captionSize: +event.target.value }, false)} /></label>
    <label className="cf-check-line cf-color">Accent color <input type="color" value={project.cut.accent} onChange={event => patch({ accent: event.target.value }, false)} /></label>
    <div className="cf-panel-divider" />
    <label className="cf-field">Clip volume <span>{project.cut.volume}%</span><input type="range" min={0} max={150} value={project.cut.volume} onChange={event => patch({ volume: +event.target.value }, false)} /></label>
    <label className="cf-check-line"><input type="checkbox" checked={project.cut.fade} onChange={event => patch({ fade: event.target.checked })} /> Fade audio at the edges</label>
    <button className="cf-primary cf-fill" onClick={go}>Review the clip <ChevronRight size={16} /></button>
  </Panel>;
}

export function GraphicsPanel({ project, update, playhead, seek, canAI, busy, draft }: {
  project: Project; update: Update; playhead: number; seek: (t: number) => void; canAI: boolean; busy: boolean; draft: (item: Graphic) => void;
}) {
  const [selectedId, setSelected] = useState<string | null>(null);
  const total = lengthOf(project.cut.spans);
  const selected = project.cut.graphics.find(item => item.id === selectedId);
  const updateGraphic = (patch: Partial<Graphic>) => update({ cut: { ...project.cut, graphics: project.cut.graphics.map(item => item.id === selectedId ? { ...item, ...patch } : item) } });
  function add(preset: (typeof motions)[number]) {
    const start = round(clamp(preset.id === "cta" ? Math.max(total - 2.8, 0) : playhead, 0, Math.max(0, total - 0.15)));
    const duration = round(Math.min(Math.max(0.12, total - start), preset.id === "flash" ? 0.50 : preset.id === "progress" ? total : 2.6));
    const item = { id: makeId(), style: preset.id, text: preset.sample, start, duration };
    update({ cut: { ...project.cut, graphics: [...project.cut.graphics, item] } });
    setSelected(item.id);
    seek(Math.min(total, start + 0.42));
  }
  return <Panel title="Motion graphics" icon={<Sparkles size={17} />}>
    <p className="cf-panel-intro">Add a treatment at the playhead and edit it in the monitor.</p>
    <div className="cf-motion-grid">{motions.map(item => <button key={item.id} onClick={() => add(item)} disabled={project.cut.graphics.length >= 30} title={item.detail} className={`cf-preset cf-preset-${item.id}`}><span aria-hidden="true">{item.sample || <Sparkles size={17} />}</span><strong>{item.label}</strong></button>)}</div>
    {project.cut.graphics.length > 0 && <><div className="cf-panel-divider" /><div className="cf-range-list">{project.cut.graphics.map(item => <button key={item.id} className={item.id === selectedId ? "is-active" : ""} onClick={() => { setSelected(item.id); seek(clamp(item.start + 0.3, 0, total)); }}><span>{elapsed(item.start)}</span><strong>{motions.find(preset => preset.id === item.style)?.label}</strong><ChevronRight size={13} /></button>)}</div></>}
    {selected && <>
      {selected.style !== "flash" && selected.style !== "zoom" && <label className="cf-field">On-screen text<textarea rows={2} maxLength={160} key={selected.id + selected.text} defaultValue={selected.text} onBlur={event => updateGraphic({ text: event.target.value.trim() })} /></label>}
      <div className="cf-duo">
        <label className="cf-field">Start (s)<input type="number" step={0.1} min={0} max={total} key={selected.id + selected.start + "from"} defaultValue={selected.start} onBlur={event => { if (Number.isFinite(event.target.valueAsNumber)) updateGraphic({ start: round(clamp(event.target.valueAsNumber, 0, Math.max(0, total - 0.15))) }); }} /></label>
        <label className="cf-field">Length (s)<input type="number" step={0.1} min={0.12} max={total} key={selected.id + selected.duration + "length"} defaultValue={selected.duration} onBlur={event => { if (Number.isFinite(event.target.valueAsNumber)) updateGraphic({ duration: round(clamp(event.target.valueAsNumber, 0.12, Math.max(0.12, total - selected.start))) }); }} /></label>
      </div>
      <div className="cf-inline-actions">
        {canAI && !["flash", "zoom", "progress"].includes(selected.style) && <button className="cf-small" disabled={busy} onClick={() => draft(selected)}><Sparkles size={15} /> Suggest text</button>}
        <button className="cf-small" onClick={() => { update({ cut: { ...project.cut, graphics: project.cut.graphics.filter(item => item.id !== selected.id) } }); setSelected(null); }}><Trash2 size={15} /> Remove</button>
      </div>
    </>}
  </Panel>;
}

export function ReviewPanel({ project, update, go, playFromStart }: { project: Project; update: Update; go: () => void; playFromStart: () => void }) {
  const count = clipCues(project).length;
  const total = lengthOf(project.cut.spans);
  const destination = destinationFor(project.destination);
  return <Panel title="Review before export" icon={<CheckCircle2 size={17} />}>
    <p className="cf-panel-intro">Watch the finished clip once from the start, with the sound on.</p>
    <button className="cf-secondary cf-fill" onClick={playFromStart}><MonitorPlay size={16} /> Cue clip from start</button>
    <ul className="cf-review-list">
      <li><Check size={15} /><span>The first line sets up the clip and the ending feels complete.</span></li>
      <li><Check size={15} /><span>The subject stays inside the {destination.label} crop.</span></li>
      <li><Check size={15} /><span>{count && project.cut.captions ? "Captions match the spoken words and clear the safe guides." : "The clip has no visible timed captions. Check that this suits the footage."}</span></li>
      <li><Check size={15} /><span>{project.cut.volume ? "Speech is clear, and adjacent cuts sound natural." : "Audio is muted for this clip."}</span></li>
    </ul>
    <label className="cf-field">Review notes<textarea value={project.notes} maxLength={4000} rows={3} placeholder="Anything to remember before publishing?" onChange={event => update({ notes: event.target.value }, false)} /></label>
    <div className="cf-detail-line"><span>Clip length</span><strong>{precise(total)}</strong></div>
    <button className="cf-primary cf-fill" onClick={() => { update({ approved: true }); go(); }}><Check size={16} /> {project.approved ? "Go to export" : "Approve & continue"}</button>
  </Panel>;
}

export function ExportPanel({ project, quality, setQuality, format, setFormat, busy, render, saveSubs, backup, go }: {
  project: Project; quality: 720 | 1080; setQuality: (n: 720 | 1080) => void;
  format: "auto" | "webm"; setFormat: (value: "auto" | "webm") => void; busy: boolean;
  render: () => void; saveSubs: () => void; backup: () => void; go: () => void;
}) {
  const size = canvasSize(project, quality);
  return <Panel title="Export clip" icon={<Download size={17} />}>
    <p className="cf-panel-intro">The preview’s framing, captions and graphics are rendered on this device.</p>
    <label className="cf-field">Resolution<select value={quality} onChange={event => setQuality(+event.target.value as 720 | 1080)}><option value={1080}>1080 · Full quality</option><option value={720}>720 · Smaller file</option></select></label>
    <label className="cf-field">File format<select value={format} onChange={event => setFormat(event.target.value as "auto" | "webm")}><option value="auto">MP4 when available</option><option value="webm">WebM</option></select></label>
    <div className="cf-detail-line"><span>Frame size / rate</span><strong>{size.width} × {size.height} · 30 fps</strong></div>
    {project.approved ? <button className="cf-primary cf-fill" disabled={busy} onClick={render}><Download size={16} /> Render & download</button> : <button className="cf-primary cf-fill" onClick={go}><CheckCircle2 size={16} /> Review this cut first</button>}
    <div className="cf-panel-divider" />
    <button className="cf-secondary cf-fill" onClick={saveSubs} disabled={!clipCues(project).length}><Captions size={16} /> Download captions (.srt)</button>
    <button className="cf-secondary cf-fill" onClick={backup}><FolderUp size={16} /> Save project backup</button>
    <p className="cf-help">The backup includes the footage and editable project, so you can move it to another device.</p>
  </Panel>;
}

export type PublishingCopy = { title: string; post: string; check: string };
export function PublishPanel({ copy, generate, canAI, busy, notify }: {
  copy: PublishingCopy | null; generate: () => void; canAI: boolean; busy: boolean; notify: (message: string) => void;
}) {
  return <Panel title="Publishing copy" icon={<Clipboard size={17} />}>
    <p className="cf-panel-intro">Draft a post for this clip from the dialogue and destination.</p>
    <button className="cf-secondary cf-fill" onClick={generate} disabled={busy}><Sparkles size={16} /> {canAI ? "Draft with GPT" : "Connect GPT to draft"}</button>
    {copy && <><h3 className="cf-copy-title">{copy.title}</h3><p className="cf-copy-post">{copy.post}</p>
      {copy.check && <p className="cf-help"><strong>Check before posting</strong> {copy.check}</p>}
      <button className="cf-small" onClick={() => void navigator.clipboard.writeText(`${copy.title}\n\n${copy.post}`).then(() => notify("Publishing copy copied.")).catch(() => notify("Select the text to copy it."))}><Clipboard size={14} /> Copy post</button></>}
  </Panel>;
}

export function manualSpan(start: number, end: number) {
  return { id: makeId(), start: round(start), end: round(end) };
}
