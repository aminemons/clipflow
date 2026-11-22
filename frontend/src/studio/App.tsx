import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  ArrowDownToLine, Check, CheckCircle2, Clapperboard, CloudOff, Download, Film, FolderOpen, HardDrive, KeyRound,
  Loader2, Plus, Settings2, Sparkles, X,
} from "lucide-react";
import { parseSubtitles, type SubtitleSegment } from "../subtitleImport";
import { aiMoments, graphicCopy, releaseCopy, requester, transcriptFor, type StudioSession } from "./assistant";
import { Monitor, type Playback, type Playhead } from "./Monitor";
import {
  BriefPanel, CutPanel, ExportPanel, GraphicsPanel, ImportPanel, manualSpan, MomentsPanel, PublishPanel,
  ReviewPanel, SourcePanel, StylePanel, TranscriptPanel, type PublishingCopy, type Update,
} from "./Panels";
import { Timeline } from "./Timeline";
import {
  clamp, clipCues, clipPosition, demoProject, destinationFor, elapsed, filename, lengthOf, localCandidates, makeId,
  newProject, round, srt, stages, tightenPauses, type Candidate, type Graphic, type Project, type Stage,
} from "./model";
import { download, openProjectFile, projectFile, projects, readMedia, removeProject, saveEdit, saveProject } from "./storage";

type Modal = "library" | "ai" | "install" | null;
type Job = { label: string; progress?: number };
type PwaPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const desktop = window.clipflowDesktop;
const lastId = "clipflow-studio-project";
const sample = "/studio/sample.mp4";
const sampleSource = () => fetch(sample).then(response => {
  if (!response.ok) throw new Error("The sample video could not be loaded.");
  return response.blob();
});
const safeLast = (id?: string) => {
  try {
    if (id) localStorage.setItem(lastId, id);
    return localStorage.getItem(lastId);
  } catch { return null; }
};
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "The operation could not be completed.";

export default function StudioApp() {
  const [project, setProject] = useState(demoProject);
  const projectRef = useRef(project);
  const [media, setMedia] = useState<Blob | null>(null);
  const url = useRef("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [stage, setStage] = useState<Stage>("Find moments");
  const [playback, setPlayback] = useState<Playback>({ mode: "cut", time: 0.5, sequence: 0 });
  const [playhead, setPlayhead] = useState<Playhead>({ source: 0, cut: 0 });
  const playheadRef = useRef(playhead);
  const [guides, setGuides] = useState(false);
  const [wave, setWave] = useState<number[]>([]);
  const [selected, setSelected] = useState(project.cut.spans[0].id);
  const [mark, setMark] = useState<number | null>(null);
  const [status, setStatus] = useState<"opening" | "saving" | "saved" | "error">("opening");
  const [notice, setNotice] = useState("");
  const [problem, setProblem] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const [library, setLibrary] = useState<Project[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const controller = useRef<AbortController | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const editHistory = useRef<{ undo: Project[]; redo: Project[] }>({ undo: [], redo: [] });
  const [historyCount, setHistoryCount] = useState({ undo: 0, redo: 0 });
  const [key, setKey] = useState("");
  const [session, setSession] = useState<StudioSession | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [wantPlan, setWantPlan] = useState(true);
  const [pwa, setPwa] = useState<PwaPrompt | null>(null);
  const [quality, setQuality] = useState<720 | 1080>(1080);
  const [format, setFormat] = useState<"auto" | "webm">("auto");
  const [copy, setCopy] = useState<PublishingCopy | null>(null);
  const [dragged, setDragged] = useState(false);
  const dragDepth = useRef(0);
  const mediaInput = useRef<HTMLInputElement>(null);
  const subtitleInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDialogElement>(null);
  const activeSource = useRef(0);

  const canTranscribe = /^sk-[A-Za-z0-9_-]{15,400}$/.test(key);
  const usingPlan = wantPlan && !!session?.sharing;
  const canAI = usingPlan || canTranscribe;
  const busy = !!job || status === "opening";

  const seek = useCallback((mode: Playback["mode"], time: number, playUntil?: number) => setPlayback(last => ({ mode, time, playUntil, sequence: last.sequence + 1 })), []);
  const reportTime = useCallback((time: Playhead) => {
    playheadRef.current = time;
    setPlayhead(old => Math.abs(old.source - time.source) > 0.009 || Math.abs(old.cut - time.cut) > 0.009 ? time : old);
  }, []);

  const refreshHistory = () => setHistoryCount({ undo: editHistory.current.undo.length, redo: editHistory.current.redo.length });

  const persist = useCallback((value: Project) => {
    setStatus("saving");
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      await saveEdit(value);
      if (projectRef.current === value) setStatus("saved");
    }).catch(error => {
      if (projectRef.current.id === value.id) {
        setStatus("error");
        setProblem(error?.name === "QuotaExceededError" ? "Device storage is full. Save a project backup to keep your changes." : "Autosave failed. Save a project backup to keep your changes.");
      }
    });
  }, []);

  const update: Update = (patch, history = true) => {
    const current = projectRef.current;
    if (Object.entries(patch).every(([field, value]) => current[field as keyof Project] === value)) return;
    const invalidates = !!patch.cut || !!patch.transcript || !!patch.destination;
    const value = { ...current, ...(invalidates ? { approved: false } : {}), ...patch, updated: Date.now() };
    if (history) {
      editHistory.current.undo = [...editHistory.current.undo.slice(-34), current];
      editHistory.current.redo = [];
      refreshHistory();
    }
    if (invalidates) setCopy(null);
    if (patch.cut && patch.cut.spans !== current.cut.spans) {
      seek("cut", clamp(playheadRef.current.cut, 0, lengthOf(patch.cut.spans)));
    }
    projectRef.current = value;
    setProject(value);
    persist(value);
  };

  function changeHistory(direction: "undo" | "redo") {
    const current = projectRef.current;
    const previous = editHistory.current[direction].pop();
    if (!previous) return;
    editHistory.current[direction === "undo" ? "redo" : "undo"].push(current);
    refreshHistory();
    const value = { ...previous, updated: Date.now() };
    projectRef.current = value;
    setProject(value);
    setSelected(value.cut.spans[0].id);
    setCopy(null);
    seek("cut", clamp(playheadRef.current.cut, 0, lengthOf(value.cut.spans)));
    persist(value);
  }

  const activate = useCallback((next: Project, source: Blob, step: Stage, firstTime = 0) => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = URL.createObjectURL(source);
    projectRef.current = next;
    editHistory.current = { undo: [], redo: [] };
    setHistoryCount({ undo: 0, redo: 0 });
    setProject(next); setPreviewUrl(url.current); setMedia(source); setStage(step);
    setSelected(next.cut.spans[0].id); setMark(null); setCopy(null); setStatus("saved");
    safeLast(next.id);
    seek("cut", firstTime);
  }, [seek]);

  useEffect(() => {
    const sourceId = ++activeSource.current;
    void (async () => {
      try {
        const all = await projects();
        const saved = all.find(item => item.id === safeLast()) ?? [...all].sort((a, b) => b.updated - a.updated)[0];
        if (saved) {
          const blob = await readMedia(saved.id);
          if (blob && sourceId === activeSource.current) {
            activate(saved, blob, saved.approved ? "Export" : "Find moments", saved.demo ? 0.5 : 0);
            return;
          }
        }
        const source = await sampleSource();
        if (sourceId !== activeSource.current) return;
        const next = projectRef.current;
        await saveProject(next, source);
        if (sourceId === activeSource.current) activate(next, source, "Find moments", 0.5);
      } catch (error) {
        if (sourceId !== activeSource.current) return;
        setStatus("error");
        setProblem(message(error));
        setPreviewUrl(sample);
        void sampleSource().then(source => { if (sourceId === activeSource.current) setMedia(source); }).catch(() => undefined);
      }
    })();
    return () => {
      ++activeSource.current;
      if (url.current) URL.revokeObjectURL(url.current);
      controller.current?.abort();
    };
  }, [activate]);

  useEffect(() => {
    if (!media) return;
    const operation = new AbortController();
    setWave([]);
    void import("./media").then(engine => engine.waveform(media, projectRef.current.duration, operation.signal)).then(result => {
      if (!operation.signal.aborted) setWave(result);
    }).catch(() => undefined);
    return () => operation.abort();
  }, [media]);

  useEffect(() => {
    if (desktop) void desktop.session().then(setSession).catch(error => setProblem(message(error)));
    const capture = (event: Event) => { event.preventDefault(); setPwa(event as PwaPrompt); };
    window.addEventListener("beforeinstallprompt", capture);
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);

  useEffect(() => {
    const dialog = modalRef.current;
    if (!dialog) return;
    if (modal && !dialog.open) dialog.showModal();
    if (!modal && dialog.open) dialog.close();
  }, [modal]);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 5200);
    return () => clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      const target = event.target;
      if (modal || job || (target instanceof Element && target.closest("input, textarea, select, [contenteditable]"))) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        changeHistory(event.shiftKey ? "redo" : "undo");
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  });

  async function work(label: string, task: (signal: AbortSignal, set: (label: string, progress?: number) => void) => Promise<void>) {
    if (controller.current) return;
    const operation = new AbortController();
    controller.current = operation;
    setProblem("");
    setJob({ label });
    try { await task(operation.signal, (label, progress) => setJob({ label, progress })); }
    catch (error) {
      if (operation.signal.aborted) setNotice("Operation cancelled.");
      else setProblem(message(error));
    } finally { controller.current = null; setJob(null); }
  }

  async function importAsset(file: File) {
    if (busy) return;
    if (file.name.toLowerCase().endsWith(".clipflow")) {
      await work("Opening project backup…", async signal => {
        const restored = await openProjectFile(file);
        const info = await (await import("./media")).probe(restored.media);
        if (Math.abs(info.duration - restored.project.duration) > 0.15 || info.width !== restored.project.width || info.height !== restored.project.height) throw new Error("The footage in the backup does not match the saved project.");
        signal.throwIfAborted();
        await saveProject(restored.project, restored.media);
        activate(restored.project, restored.media, "Find moments");
        setModal(null);
        setNotice("Project restored on this device.");
      });
      return;
    }
    await work("Reading and saving your video…", async signal => {
      const info = await (await import("./media")).probe(file);
      signal.throwIfAborted();
      const value = newProject(file, info);
      try { await saveProject(value, file); } catch (error) {
        if ((error as DOMException)?.name === "QuotaExceededError") throw new Error("This device does not have enough browser storage for that file.");
        throw error;
      }
      if (navigator.storage?.persist) void navigator.storage.persist().catch(() => false);
      activate(value, file, "Find moments");
      setModal(null);
      setNotice("Video saved on this device.");
    });
  }

  const pick = (callback: (file: File) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) callback(file);
  };

  async function loadSubtitles(file: File) {
    await work("Reading subtitle timings…", async signal => {
      if (file.size > 10 * 1024 * 1024) throw new Error("Use an SRT or VTT file under 10 MB.");
      const transcript = parseSubtitles(await file.text(), projectRef.current.duration);
      signal.throwIfAborted();
      update({ transcript, candidates: [] });
      setNotice(`Imported ${transcript.length} timed cues.`);
    });
  }

  function find(useAI: boolean) {
    const source = projectRef.current;
    if (!useAI) {
      const candidates = localCandidates(source);
      update({ candidates });
      setNotice(`${candidates.length} ${candidates.length === 1 ? "moment" : "moments"} ready to review.`);
      return;
    }
    void work("Finding moments with GPT…", async (signal, set) => {
      const candidates = await aiMoments(source, requester(key, usingPlan), signal, set);
      signal.throwIfAborted();
      if (projectRef.current.id !== source.id || projectRef.current.transcript !== source.transcript || projectRef.current.subject !== source.subject || projectRef.current.goal !== source.goal || projectRef.current.target !== source.target || projectRef.current.destination !== source.destination) throw new Error("The brief changed during analysis. Find moments again to use the latest brief.");
      update({ candidates });
      setNotice(`${candidates.length} GPT ${candidates.length === 1 ? "suggestion" : "suggestions"} ready to review.`);
    });
  }

  function firstCut() {
    const source = projectRef.current;
    const sourceMedia = media;
    void work("Preparing a first cut…", async (signal, set) => {
      let transcript = source.transcript;
      if (!transcript.length && canTranscribe && sourceMedia) {
        transcript = await transcriptFor(sourceMedia, source.duration, key, signal, set);
      }
      const draft = { ...source, transcript };
      const ask = requester(key, usingPlan);
      const candidates = canAI && transcript.length ? await aiMoments(draft, ask, signal, set) : localCandidates(draft);
      const candidate = candidates[0];
      const style: Graphic["style"] = source.goal === "Teach one thing" ? "callout"
        : source.goal === "Share an opinion" ? "quote" : "opening";
      const span = manualSpan(candidate.start, candidate.end);
      const spans = transcript.length ? tightenPauses({ ...draft, cut: { ...source.cut, spans: [span] } }) : [span];
      const duration = lengthOf(spans);
      const graphic: Graphic = { id: makeId(), style, text: candidate.hook ? candidate.title : source.title, start: 0, duration: Math.min(2.7, duration) };
      signal.throwIfAborted();
      if (projectRef.current !== source) throw new Error("The project changed while Clipflow drafted the cut. Run it again with the latest edits.");
      update({
        candidates, transcript,
        cut: { ...source.cut, spans, graphics: duration >= 0.3 ? [graphic] : [], captions: !!transcript.length, fade: true },
      });
      setSelected(spans[0].id);
      seek("cut", Math.min(duration * 0.14, 0.55));
      setStage("Build cut");
      setNotice(transcript.length ? "First cut ready. Play it through and check the pacing." : "Visual draft ready. Choose a different range if the opening needs a stronger moment.");
    });
  }

  function transcribe() {
    if (!media || !canTranscribe) return;
    const source = projectRef.current;
    void work("Extracting speech locally…", async (signal, set) => {
      const transcript = await transcriptFor(media, source.duration, key, signal, set);
      signal.throwIfAborted();
      if (projectRef.current.id !== source.id || projectRef.current.transcript !== source.transcript) throw new Error("The transcript changed during this request. Your existing cues were kept.");
      update({ transcript, candidates: [] });
      setNotice(`${transcript.length} timed cues. Check names and spelling in the transcript.`);
    });
  }

  const go = (step: Stage) => {
    setStage(step);
    if (["Style", "Review", "Export"].includes(step)) seek("cut", 0);
  };

  function accept(item: Candidate) {
    const cut = projectRef.current.cut;
    const span = manualSpan(item.start, item.end);
    update({ cut: { ...cut, spans: [span] } });
    setSelected(span.id);
    seek("cut", 0);
    setStage("Build cut");
    setNotice("Moment added. Check the edges and remove anything the viewer doesn’t need.");
  }

  function split() {
    const source = projectRef.current;
    if (playback.mode !== "cut") { setNotice("Switch the monitor to Clip and move its playhead to the split."); return; }
    const point = clipPosition(source.cut.spans, playheadRef.current.cut);
    if (!point || point.sourceTime - point.span.start < 0.15 || point.span.end - point.sourceTime < 0.15) { setNotice("Move the playhead inside a range to split it."); return; }
    if (source.cut.spans.length >= 100) { setNotice("This cut already has 100 ranges."); return; }
    const first = { ...point.span, end: round(point.sourceTime) };
    const second = manualSpan(point.sourceTime, point.span.end);
    const spans = [...source.cut.spans];
    spans.splice(point.index, 1, first, second);
    update({ cut: { ...source.cut, spans } });
    setSelected(second.id);
    setStage("Build cut");
  }

  function appendRange() {
    const source = projectRef.current;
    const end = playheadRef.current.source;
    if (mark === null || end - mark < 0.15) { setNotice("Move the source playhead after the in point."); return; }
    if (source.cut.spans.length >= 100) { setNotice("This cut already has 100 ranges."); return; }
    const span = manualSpan(mark, Math.min(source.duration, end));
    update({ cut: { ...source.cut, spans: [...source.cut.spans, span] } });
    seek("cut", lengthOf(source.cut.spans)); setMark(null); setSelected(span.id);
  }

  function tighten() {
    const source = projectRef.current;
    const spans = tightenPauses(source);
    const removed = lengthOf(source.cut.spans) - lengthOf(spans);
    if (removed < 0.03) { setNotice("There are no long transcript gaps to tighten."); return; }
    update({ cut: { ...source.cut, spans } });
    setSelected(spans[0].id);
    setNotice(`Trimmed ${removed.toFixed(1)} seconds between dialogue cues. Review the new cuts with sound.`);
  }

  function changeCue(index: number, cue: SubtitleSegment | null) {
    const transcript = [...projectRef.current.transcript];
    if (cue) transcript[index] = cue; else transcript.splice(index, 1);
    update({ transcript: transcript.sort((a, b) => a.start - b.start) });
  }

  function addCue() {
    const source = projectRef.current;
    if (source.transcript.length >= 10000) { setNotice("This source already has 10,000 timed cues."); return; }
    const start = round(clamp(playheadRef.current.source, 0, Math.max(0, source.duration - 0.05)));
    update({ transcript: [...source.transcript, { start, end: round(Math.min(start + 2.2, source.duration)), text: "Type your caption" }].sort((a, b) => a.start - b.start) });
    setNotice(`Caption added at ${elapsed(start)}. Edit the text in the transcript.`);
  }

  function draftGraphic(item: Graphic) {
    const source = projectRef.current;
    void work("Drafting on-screen text…", async signal => {
      const text = await graphicCopy(source, item.style, clipCues(source), requester(key, usingPlan), signal);
      signal.throwIfAborted();
      const current = projectRef.current;
      if (current.id !== source.id || !current.cut.graphics.some(graphic => graphic.id === item.id && graphic.text === item.text)) throw new Error("This graphic changed before the suggestion arrived.");
      update({ cut: { ...current.cut, graphics: current.cut.graphics.map(graphic => graphic.id === item.id ? { ...graphic, text } : graphic) } });
      seek("cut", Math.min(lengthOf(current.cut.spans), item.start + 0.42));
      setNotice("GPT suggestion applied. You can still edit the text.");
    });
  }

  function draftPost() {
    if (!canAI) { setModal("ai"); return; }
    const source = projectRef.current;
    void work("Drafting publishing copy…", async signal => {
      const cues = clipCues(source);
      if (!cues.length) throw new Error("Add speech captions to the cut before generating a post.");
      const output = await releaseCopy(source, cues, requester(key, usingPlan), signal);
      signal.throwIfAborted();
      const current = projectRef.current;
      if (current.cut !== source.cut || current.transcript !== source.transcript || current.destination !== source.destination) throw new Error("The cut changed during drafting. Generate again for this version.");
      setCopy(output);
    });
  }

  async function openLibrary() {
    try {
      await saveQueue.current;
      setLibrary((await projects()).sort((a, b) => b.updated - a.updated));
      setDeleteId(null); setModal("library");
    } catch (error) { setProblem(message(error)); }
  }

  function reopen(item: Project) {
    if (busy) return;
    void work("Opening saved project…", async signal => {
      await saveQueue.current;
      const source = await readMedia(item.id);
      if (!source) throw new Error("The footage for this project is missing. Restore its backup.");
      signal.throwIfAborted();
      activate(item, source, item.approved ? "Export" : "Find moments", item.demo ? 0.5 : 0);
      setModal(null);
    });
  }

  function erase(id: string) {
    if (busy) return;
    if (deleteId !== id) { setDeleteId(id); return; }
    void work("Removing local project…", async () => {
      let replacement: { value: Project; source: Blob } | undefined;
      if (id === projectRef.current.id) {
        const fallback = library.find(item => item.id !== id);
        const existing = fallback && await readMedia(fallback.id);
        replacement = fallback && existing ? { value: fallback, source: existing } : { value: demoProject(), source: await sampleSource() };
        if (!fallback || !existing) await saveProject(replacement.value, replacement.source);
      }
      await saveQueue.current;
      await removeProject(id);
      if (replacement) activate(replacement.value, replacement.source, "Find moments", replacement.value.demo ? 0.5 : 0);
      setLibrary((await projects()).sort((a, b) => b.updated - a.updated));
      setDeleteId(null);
    });
  }

  function backup() {
    if (!media) return setProblem("Open the source video first.");
    try { download(projectFile(projectRef.current, media), `${filename(projectRef.current.title)}.clipflow`); }
    catch (error) { setProblem(message(error)); }
  }

  function exportClip() {
    const current = projectRef.current;
    if (!media || !current.approved) return;
    void work("Rendering on this device…", async (signal, set) => {
      const editor = await import("./media");
      const result = await editor.renderClip(media, current, quality, signal, value => set("Rendering on this device…", value), format);
      signal.throwIfAborted();
      download(result.data, `${filename(current.title)}.${result.extension}`);
      setNotice(`${result.extension.toUpperCase()} ready. The download has started.`);
    });
  }

  async function signIn() {
    if (!desktop || signingIn) return;
    setSigningIn(true);
    setProblem("");
    try { setSession(await desktop.signIn()); setWantPlan(true); }
    catch (error) { setProblem(message(error)); }
    finally { setSigningIn(false); }
  }

  const drop = (event: DragEvent) => {
    event.preventDefault(); dragDepth.current = 0; setDragged(false);
    const file = event.dataTransfer.files[0];
    if (file) void importAsset(file);
  };

  return <div className="cf-app" onDragEnter={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); dragDepth.current++; setDragged(true); }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragged(false); } }} onDrop={drop}>
    <header className="cf-topbar">
      <div className="cf-topbar-inner">
        <button className="cf-brand" onClick={() => go("Import")} aria-label="Clipflow Studio home"><img src="/studio/icon.svg" alt="" /><span>clipflow<span className="cf-brand-period">.</span></span><i /><small>Studio</small></button>
        <div className="cf-top-actions">
          <span className="cf-device"><HardDrive size={14} /> On this device</span>
          <button className="cf-secondary cf-top-control" onClick={() => void openLibrary()} aria-label="Local projects"><FolderOpen size={16} /> <span>Projects</span></button>
          <button className="cf-secondary cf-top-control" onClick={() => setModal("ai")} aria-label="AI settings"><Sparkles size={16} /> <span>AI settings</span>{canAI && <i />}</button>
          {!desktop && <button className="cf-icon cf-top-control cf-install" onClick={() => setModal("install")} aria-label="Install Clipflow" title="Install Clipflow"><ArrowDownToLine size={17} /></button>}
          <button className="cf-primary cf-top-control" onClick={() => mediaInput.current?.click()} aria-label="New video" disabled={busy}><Plus size={17} /><span>New video</span></button>
        </div>
      </div>
    </header>

    <main className="cf-main">
      <div className="cf-project-head">
        <div className="cf-project-label"><span><Film size={14} /> {project.demo ? "SAMPLE PROJECT" : "LOCAL PROJECT"}</span><span className="cf-saved" role="status">{status === "saved" ? <Check size={14} /> : status === "error" ? <CloudOff size={14} /> : <Loader2 size={14} className="cf-spin" />}{status === "saved" ? "Saved locally" : status === "error" ? "Save needs attention" : status === "saving" ? "Saving changes" : "Opening project"}</span></div>
        <div className="cf-project-title">
          <input aria-label="Project title" title="Edit project title" key={project.id + project.title} defaultValue={project.title} maxLength={300} onBlur={event => { const value = event.target.value.trim(); if (value) update({ title: value }); else event.target.value = project.title; }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          <button className="cf-secondary cf-project-export" onClick={() => go(project.approved ? "Export" : "Review")}><Download size={16} /> Export</button>
        </div>
        <div className="cf-project-meta"><span>{elapsed(project.duration)} source</span><i /><span>{destinationFor(project.destination).label}</span><i /><span>{destinationFor(project.destination).ratio}</span></div>
      </div>

      <nav className="cf-stages" aria-label="Editing workflow">{stages.map((item, index) => <button key={item} onClick={() => go(item)} className={item === stage ? "is-active" : ""} aria-current={item === stage ? "step" : undefined}><span className="cf-stage-index">{index + 1}</span><strong>{item}</strong></button>)}</nav>

      <div className="cf-editor">
        <div className="cf-left">
          {stage === "Import" && <ImportPanel project={project} openFile={() => mediaInput.current?.click()} openBackup={() => backupInput.current?.click()} openLibrary={() => void openLibrary()} go={() => go("Find moments")} />}
          {stage === "Find moments" && <BriefPanel project={project} update={update} canAI={canAI} canTranscribe={canTranscribe} busy={busy} openAI={() => setModal("ai")} onTranscribe={transcribe} onSubtitles={() => subtitleInput.current?.click()} onFind={find} onDraft={firstCut} goBuild={() => go("Build cut")} />}
          {stage === "Build cut" && <CutPanel project={project} update={update} selected={selected} select={setSelected} seek={seek} playhead={playhead} mode={playback.mode} mark={mark} setMark={setMark} addMark={appendRange} tighten={tighten} go={() => go("Style")} notify={setNotice} />}
          {stage === "Style" && <StylePanel project={project} update={update} go={() => go("Review")} />}
          {stage === "Review" && <ReviewPanel project={project} update={update} go={() => go("Export")} playFromStart={() => seek("cut", 0, lengthOf(project.cut.spans))} />}
          {stage === "Export" && <ExportPanel project={project} quality={quality} setQuality={setQuality} format={format} setFormat={setFormat} busy={busy} render={exportClip} saveSubs={() => download(new Blob([srt(clipCues(project))], { type: "text/plain;charset=utf-8" }), `${filename(project.title)}.srt`)} backup={backup} go={() => go("Review")} />}
        </div>
        <Monitor key={project.id} project={project} url={previewUrl} playback={playback} onSeek={seek} onTime={reportTime} guides={guides} setGuides={setGuides} />
        <div className="cf-right">
          {stage === "Import" && <SourcePanel project={project} onTime={time => seek("source", time)} />}
          {stage === "Find moments" && <MomentsPanel project={project} playingStart={playback.mode === "source" ? playback.time : null} seek={(time, end) => seek("source", time, end)} accept={accept} goNext={() => go("Build cut")} />}
          {(stage === "Build cut" || stage === "Review") && <TranscriptPanel key={project.id} project={project} onAdd={addCue} onChange={changeCue} seek={time => seek("source", time)} />}
          {stage === "Style" && <GraphicsPanel key={project.id} project={project} update={update} playhead={playhead.cut} seek={time => seek("cut", time)} canAI={canAI} busy={busy} draft={draftGraphic} />}
          {stage === "Export" && <PublishPanel copy={copy} generate={draftPost} canAI={canAI} busy={busy} notify={setNotice} />}
        </div>
      </div>

      <Timeline key={project.id} project={project} playhead={playhead} mode={playback.mode} wave={wave} seek={time => seek("cut", time)} selected={selected} select={setSelected} onSplit={split} onUndo={() => changeHistory("undo")} onRedo={() => changeHistory("redo")} canUndo={!!historyCount.undo} canRedo={!!historyCount.redo} />
      <footer className="cf-footer"><span><HardDrive size={14} /> Footage and projects stay on this device.</span><span>Space to play or pause <i /> Ctrl / ⌘ + Z to undo</span></footer>
    </main>

    {dragged && <div className="cf-drag-mask"><FolderOpen size={40} /><strong>Drop a video or Clipflow backup</strong></div>}
    <div className="cf-toast-stack">
      {job && <div className="cf-toast cf-job" role="status"><Loader2 size={18} className="cf-spin" /><div><strong>{job.label}</strong>{typeof job.progress === "number" && <progress max={1} value={job.progress} aria-label="Render progress" />}</div><button className="cf-small" onClick={() => controller.current?.abort()}>Cancel</button></div>}
      {notice && <div className="cf-toast" role="status"><CheckCircle2 size={18} /><span>{notice}</span><button className="cf-icon" onClick={() => setNotice("")} aria-label="Dismiss status"><X size={15} /></button></div>}
      {problem && !modal && <div className="cf-toast cf-error" role="alert"><span>{problem}</span><button className="cf-icon" onClick={() => setProblem("")} aria-label="Dismiss error"><X size={15} /></button></div>}
    </div>
    <input hidden ref={mediaInput} type="file" accept="video/*,.mp4,.mov,.webm,.mkv" onChange={pick(file => void importAsset(file))} />
    <input hidden ref={subtitleInput} type="file" accept=".srt,.vtt,text/plain,text/vtt" onChange={pick(file => void loadSubtitles(file))} />
    <input hidden ref={backupInput} type="file" accept=".clipflow" onChange={pick(file => void importAsset(file))} />

    <dialog ref={modalRef} className="cf-modal" onCancel={() => setModal(null)} onClose={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) setModal(null); }}>
      {modal && <div className="cf-modal-inner">
        <div className="cf-modal-head"><div>{modal === "library" ? <FolderOpen size={21} /> : modal === "ai" ? <Settings2 size={21} /> : <Download size={21} />}<h2>{modal === "library" ? "Projects on this device" : modal === "ai" ? "AI settings" : "Install Clipflow"}</h2></div><button className="cf-icon" onClick={() => setModal(null)} aria-label="Close dialog"><X size={20} /></button></div>
        {problem && <p className="cf-modal-error" role="alert">{problem}</p>}
        {modal === "library" && <>
          <p>Open a project stored by this browser or restore a backup file.</p>
          <div className="cf-library-list">{library.map(item => <div className="cf-library-item" key={item.id}>
            <button className="cf-library-open" onClick={() => reopen(item)} disabled={busy}><Film size={19} /><div><strong>{item.title}</strong><small>{elapsed(item.duration)} · {item.demo ? "Sample" : item.sourceName}</small></div></button>
            {item.id === project.id && <span className="cf-current">Open</span>}
            <button className={deleteId === item.id ? "cf-small cf-danger" : "cf-small"} disabled={busy} onClick={() => erase(item.id)} aria-label={deleteId === item.id ? `Confirm remove ${item.title}` : `Remove ${item.title}`}>{deleteId === item.id ? "Confirm remove" : "Remove"}</button>
          </div>)}</div>
          <button className="cf-secondary cf-fill" onClick={() => backupInput.current?.click()} disabled={busy}><FolderOpen size={16} /> Restore from backup</button>
        </>}
        {modal === "ai" && <>
          <p>Use GPT to choose clip moments and write on-screen or publishing copy. AI runs when you request it.</p>
          {desktop && <section className="cf-ai-account">
            <h3>ChatGPT plan</h3>
            <p>{session?.sharing ? `Connected${session.identity?.email ? ` as ${session.identity.email}` : ""}. Eligible edits can use your ChatGPT plan.` : "Connect an eligible ChatGPT Plus or Pro plan for AI editing. Editing and local save work without signing in."}</p>
            {session?.error && <p className="cf-help">{session.error.message}</p>}
            {session?.sharing ? <>
              <label className="cf-check-line"><input type="checkbox" checked={wantPlan} onChange={event => setWantPlan(event.target.checked)} /> Use ChatGPT plan for GPT editing</label>
              <div className="cf-inline-actions"><button className="cf-small" onClick={() => void desktop.usage()}>Manage usage</button><button className="cf-small" onClick={() => void desktop.disconnect().then(() => desktop.session()).then(setSession).catch(error => setProblem(message(error)))}>Disconnect</button></div>
            </> : <div className="cf-inline-actions"><button className="cf-primary" onClick={() => void signIn()} disabled={signingIn}>{signingIn ? "Waiting for ChatGPT…" : "Continue with ChatGPT"}</button>{signingIn && <button className="cf-small" onClick={() => void desktop.cancelSignIn()}>Cancel</button>}</div>}
          </section>}
          {!desktop && <p className="cf-help">This browser session uses your OpenAI API key. ChatGPT plan sign-in is available in Clipflow Desktop.</p>}
          <label className="cf-field">OpenAI developer API key <input autoComplete="off" spellCheck={false} type="password" value={key} maxLength={403} placeholder="sk-…" onChange={event => setKey(event.target.value.trim())} /></label>
          <p className="cf-help"><KeyRound size={14} /> The key stays in this session. GPT editing sends timed dialogue. Transcribe and Draft a first cut can send audio chunks to OpenAI when a key is present. API requests are billed separately.</p>
          {key && !canTranscribe && <p className="cf-modal-error">Enter a valid OpenAI developer API key.</p>}
          <button className="cf-primary cf-fill" onClick={() => setModal(null)}><Check size={16} /> Done</button>
        </>}
        {modal === "install" && <>
          <p>Install the browser editor to open Clipflow from your desktop and edit offline after its first load. For ChatGPT plan sign-in, use the native Clipflow Desktop download.</p>
          {pwa ? <button className="cf-primary cf-fill" onClick={() => void pwa.prompt().then(() => pwa.userChoice).then(result => { setPwa(null); setModal(null); if (result.outcome === "accepted") setNotice("Clipflow added to your device."); }).catch(error => setProblem(message(error)))}><Download size={16} /> Install web app</button> : <p className="cf-help">In Chrome or Edge, look for the install icon in the address bar or the Install app command in the browser menu.</p>}
          <a className="cf-secondary cf-fill" href="https://github.com/aminemons/clipflow/tree/feature/local-first-studio/studio-desktop" target="_blank" rel="noreferrer"><Clapperboard size={16} /> Clipflow Desktop</a>
        </>}
      </div>}
    </dialog>
  </div>;
}
