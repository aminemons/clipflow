import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlignCenter,
  AlignEndHorizontal,
  AlignStartHorizontal,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  Clapperboard,
  Clock3,
  Copy,
  Download,
  FileVideo,
  Film,
  Focus,
  FolderOpen,
  Gauge,
  Globe2,
  HardDrive,
  HelpCircle,
  History,
  Import,
  Info,
  Layers3,
  Link2,
  LoaderCircle,
  Lock,
  Maximize2,
  Menu,
  MessageSquareText,
  Minus,
  MonitorPlay,
  MoreHorizontal,
  MoveHorizontal,
  Palette,
  PanelRight,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  Youtube,
  Zap,
  X,
} from "lucide-react";
import ClipEnhancements, {
  type ClipEnhancementsValue,
} from "./ClipEnhancements";
import EditorTimeline from "./EditorTimeline";
import TranscriptPanel, { type TranscriptSegment } from "./TranscriptPanel";
import TranscriptionControls from "./TranscriptionControls";
import { SourceImport, NewProjectDialog } from "./SourceImport";
import CaptionPlacement from "./CaptionPlacement";
import PreviewPlayer from "./PreviewPlayer";
import ProviderSettings from "./ProviderSettings";
import type {
  AnalysisOptions,
  Clip,
  Health,
  Job,
  Project,
  TranscriptionOptions,
} from "./editorTypes";

const API = "/api";
const demoClips: Clip[] = [];
const DEFAULT_CLIP: Omit<Clip, "id"> = {
  title: "Untitled clip",
  start: 0,
  end: 15,
  framing: "follow",
  focus_x: 0.5,
  smoothing: 0.15,
  caption_text: "",
  caption_style: "clean",
  caption_color: "#b8a7ff",
  caption_position: "bottom",
  caption_x: 0.5,
  caption_y: 0.86,
  caption_enabled: true,
  playback_speed: 1,
  audio_volume: 1,
  audio_denoise: false,
  audio_fade: 0,
  resolution: 720,
  status: "draft",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const message = await response.text();
    try {
      const parsed = JSON.parse(message);
      throw new Error(
        typeof parsed.detail === "string"
          ? parsed.detail
          : `Check your input (HTTP ${response.status}).`,
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error(message || `Request failed (${response.status})`);
      throw error;
    }
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const fmt = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const HISTORY_LIMIT = 12;
const historyKey = (projectId: string) => `clipflow-edit-history-${projectId}`;
const clipFingerprint = (items: Clip[]) =>
  items.map((clip) => `${clip.id}:${clip.revision || 0}`).join("|");

export default function App() {
  const [health, setHealth] = useState<Health>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [clips, setClips] = useState<Clip[]>(demoClips);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<
    "clips" | "exports" | "connections" | "transcript"
  >("clips");
  const [targetDuration, setTargetDuration] = useState(30);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [activeTime, setActiveTime] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState("");
  const [clipFilter, setClipFilter] = useState<
    "all" | "drafts" | "reviewed" | "exported"
  >("all");
  const [restoreAvailable, setRestoreAvailable] = useState(false);
  const [brandColor, setBrandColor] = useState(
    () => localStorage.getItem("clipflow-brand-color") || "#d6fb78",
  );
  const [history, setHistory] = useState<Clip[][]>([]);
  const [future, setFuture] = useState<Clip[][]>([]);
  const [exports, setExports] = useState<Job[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("clipflow-exports") || "[]");
    } catch {
      return [];
    }
  });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [proofUrl, setProofUrl] = useState("");
  const [generationPrompt, setGenerationPrompt] = useState(
    "A quiet travel detail, soft movement, natural light",
  );
  const [generationDuration, setGenerationDuration] = useState<5 | 10>(5);
  const [analysisMode, setAnalysisMode] = useState<"full" | "smart">("full");
  const [analysisTolerance, setAnalysisTolerance] = useState(0.3);
  const [analysisStrictMax, setAnalysisStrictMax] = useState<number | null>(
    null,
  );
  const [analysisMaxClips, setAnalysisMaxClips] = useState(5);
  const [analysisTopic, setAnalysisTopic] = useState("");
  const [analysisUseTranscript, setAnalysisUseTranscript] = useState(true);
  const [analysisProvider, setAnalysisProvider] = useState<"local" | "groq">(
    "local",
  );
  const [expandedPreview, setExpandedPreview] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"edit" | "review">(
    "edit",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(
    "saved",
  );
  const [saveError, setSaveError] = useState("");
  const importInFlight = useRef(false);
  const importJobId = useRef("");
  const openRequestId = useRef(0);
  useEffect(() => {
    setAnalysisProvider(
      health?.configuration?.highlights?.provider === "groq" ? "groq" : "local",
    );
  }, [health?.configuration?.highlights?.provider]);
  const proofJobId = useRef("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSourceSeek = useRef<number | null>(null);
  const patchVersions = useRef<Record<string, number>>({});
  const loadProjectOnDone = useRef(false);
  const pendingSaves = useRef<Set<Promise<unknown>>>(new Set());
  const saveChains = useRef<Record<string, Promise<unknown>>>({});
  const debouncedSaves = useRef<Record<string, {
    patch: Partial<Clip>;
    version: number;
    timer: number;
    promise: Promise<void>;
    resolve: () => void;
    failed?: boolean;
    error?: string;
  }>>({});
  const resumed = useRef(false);

  // Restore the working clip after a refresh without changing export checkboxes.
  useEffect(() => {
    if (resumed.current || !projects.length) return;
    resumed.current = true;
    const last = localStorage.getItem("clipflow-current-project");
    if (last && projects.some((item) => item.id === last))
      void openProject(last);
  }, [projects]);
  useEffect(() => {
    if (!project) return;
    localStorage.setItem("clipflow-current-project", project.id);
    if (selectedId)
      localStorage.setItem(`clipflow-current-clip-${project.id}`, selectedId);
  }, [project?.id, selectedId]);
  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(
        historyKey(project.id),
        JSON.stringify({
          fingerprint: clipFingerprint(clips),
          history: history.slice(-HISTORY_LIMIT),
          future: future.slice(0, HISTORY_LIMIT),
        }),
      );
    } catch {
      // Large transcript snapshots can exceed local storage; server edits remain safe.
    }
  }, [project?.id, clips, history, future]);
  useEffect(() => {
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      if (!pendingSaves.current.size && !Object.keys(debouncedSaves.current).length)
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, []);

  const selected = clips.find((c) => c.id === selectedId) ?? clips[0];
  const smoothingEnabled = !!selected && (selected.smoothing ?? 0) > 0;
  const duration = project?.duration || 0;
  const isBusy = job?.status === "queued" || job?.status === "running";

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api<Project[]>("/projects"));
    } catch {
      /* backend may still be starting */
    }
  }, []);
  const refreshJobs = useCallback(async () => {
    try {
      const next = await api<Job[]>("/jobs");
      setJobs(next);
      setExports(
        next.filter(
          (item) =>
            item.kind === "export_job" ||
            item.kind === "preview_job" ||
            item.download_url,
        ),
      );
      const active = next.find(
        (item) => item.status === "queued" || item.status === "running",
      );
      if (
        active &&
        [
          "upload_job",
          "youtube_job",
          "demo_job",
          "analyze_job",
          "transcribe_job",
        ].includes(active.kind || "")
      )
        loadProjectOnDone.current = true;
      if (
        active &&
        ["upload_job", "youtube_job", "demo_job"].includes(active.kind || "")
      )
        importJobId.current = active.id;
      setJob((current) =>
        current && next.some((item) => item.id === current.id)
          ? next.find((item) => item.id === current.id) || current
          : current || active || null,
      );
    } catch {
      /* backend may still be starting */
    }
  }, []);
  useEffect(() => {
    api<Health>("/health")
      .then(setHealth)
      .catch(() => setHealth({}));
    refreshProjects();
    refreshJobs();
  }, [refreshProjects, refreshJobs]);
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api<Job>(`/jobs/${job.id}`);
        setJob(next);
        setJobs((items) => [
          next,
          ...items.filter((item) => item.id !== next.id),
        ]);
        setExports((items) =>
          items.map((item) => (item.id === next.id ? next : item)),
        );
        if (
          next.status === "done" &&
          next.download_url &&
          next.id === proofJobId.current
        ) {
          setProofUrl(next.download_url + "?v=" + next.id);
          setNotice("Rendered proof ready. Play to review the final clip.");
        }
        if (
          next.status === "done" &&
          next.download_url &&
          next.project_id &&
          next.id !== proofJobId.current
        ) {
          const updated = await api<Project>(`/projects/${next.project_id}`);
          if (project?.id === next.project_id) setClips(updated.clips);
          setNotice("Export complete. Your download is ready.");
        }
        if (
          next.status === "done" &&
          next.kind === "higgsfield_job" &&
          next.project_id
        ) {
          const generated = await api<Project>(`/projects/${next.project_id}`);
          setProject(generated);
          setClips(generated.clips || []);
          setSelectedId(generated.clips?.[0]?.id ?? null);
          setSidebar("clips");
          refreshProjects();
          setNotice("Generation ready as a new project.");
        }
        if (
          next.project_id &&
          next.status === "done" &&
          loadProjectOnDone.current &&
          (!project ||
            project.id === next.project_id ||
            importJobId.current === next.id)
        ) {
          const loaded = await api<Project>(`/projects/${next.project_id}`);
          const nextClips = loaded.clips || [];
          if (importJobId.current === next.id) {
            // A new source is a separate project; switch only after it is ready.
            openRequestId.current++;
            importJobId.current = "";
            proofJobId.current = "";
            setProofUrl("");
            setPlaying(false);
            setActiveTime(0);
            setTimelineZoom(1);
            setSearch("");
            setClipFilter("all");
            setSidebar("clips");
            setUrl("");
          }
          setProject(loaded);
          setClips(nextClips);
          setRestoreAvailable(Boolean(loaded.can_restore_clips));
          setSelectedId(
            (next.kind === "transcribe_job" &&
            selectedId &&
            nextClips.some((clip) => clip.id === selectedId)
              ? selectedId
              : undefined) ??
              nextClips.find((clip) => clip.selected)?.id ??
              nextClips[0]?.id ??
              null,
          );
          refreshProjects();
          setNotice(
            next.download_url
              ? "Source ready. Your clips are ready to edit."
              : "Source ready.",
          );
          setHistory([]);
          setFuture([]);
          loadProjectOnDone.current = false;
        }
        if (
          next.project_id &&
          next.status === "done" &&
          loadProjectOnDone.current &&
          project &&
          project.id !== next.project_id &&
          importJobId.current !== next.id
        )
          loadProjectOnDone.current = false;
        if (next.status === "error" || next.status === "cancelled") {
          if (importJobId.current === next.id) importJobId.current = "";
          loadProjectOnDone.current = false;
          if (next.status === "error")
            setError(
              next.error || "The job failed. Check the source and try again.",
            );
        }
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Could not check job status.",
        );
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [job, project?.id, refreshProjects]);
  useEffect(() => {
    localStorage.setItem(
      "clipflow-exports",
      JSON.stringify(exports.slice(0, 30)),
    );
  }, [exports]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (newProjectOpen) return;
      const target = event.target as HTMLElement;
      const editing = target.matches(
        'input, textarea, select, [contenteditable="true"]',
      );
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z" &&
        !editing
      ) {
        event.preventDefault();
        undo();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "y" &&
        !editing
      ) {
        event.preventDefault();
        redo();
      }
      if (editing) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      }
      if (event.key.toLowerCase() === "i")
        setSelectedRange("start", activeTime);
      if (event.key.toLowerCase() === "o") setSelectedRange("end", activeTime);
      if (event.key === "ArrowLeft")
        seek(activeTime - (event.shiftKey ? 1 : 0.1));
      if (event.key === "ArrowRight")
        seek(activeTime + (event.shiftKey ? 1 : 0.1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  async function startJob(next: Job) {
    setError("");
    setJob(next);
  }
  async function loadDemo() {
    await beginImport(
      () =>
        api<Job>("/projects/demo", {
          method: "POST",
          body: JSON.stringify({ target_duration: targetDuration }),
        }),
      "Preparing demo",
    );
  }
  async function beginImport(create: () => Promise<Job>, message: string) {
    if (importInFlight.current || isBusy) return;
    importInFlight.current = true;
    setImportSubmitting(true);
    setError("");
    try {
      if (!(await flushQueuedSaves())) return;
      const next = await create();
      importJobId.current = next.id;
      loadProjectOnDone.current = true;
      await startJob(next);
      setNewProjectOpen(false);
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import this video.");
    } finally {
      importInFlight.current = false;
      setImportSubmitting(false);
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("target_duration", String(targetDuration));
    await beginImport(
      () => api<Job>("/projects/upload", { method: "POST", body: form }),
      `Importing ${file.name}`,
    );
  }
  async function importYoutube() {
    if (!url.trim()) return;
    await beginImport(
      () =>
        api<Job>("/projects/youtube", {
          method: "POST",
          body: JSON.stringify({
            url: url.trim(),
            target_duration: targetDuration,
          }),
        }),
      "Fetching source from YouTube",
    );
  }
  async function openProject(id: string) {
    const requestId = ++openRequestId.current;
    setProofUrl("");
    proofJobId.current = "";
    setRestoreAvailable(false);
    try {
      if (!(await flushQueuedSaves())) return;
      const loaded = await api<Project>(`/projects/${id}`);
      if (requestId !== openRequestId.current) return;
      setProject(loaded);
      setClips(loaded.clips || []);
      setRestoreAvailable(Boolean(loaded.can_restore_clips));
      setSelectedId(
        loaded.clips?.find(
          (clip) =>
            clip.id === localStorage.getItem(`clipflow-current-clip-${id}`),
        )?.id ??
          loaded.clips?.find((clip) => clip.selected)?.id ??
          loaded.clips?.[0]?.id ??
          null,
      );
      let restoredHistory: Clip[][] = [];
      let restoredFuture: Clip[][] = [];
      try {
        const raw = localStorage.getItem(historyKey(id));
        const saved = raw ? JSON.parse(raw) : null;
        if (
          saved?.fingerprint === clipFingerprint(loaded.clips || []) &&
          Array.isArray(saved.history) &&
          Array.isArray(saved.future)
        ) {
          restoredHistory = saved.history.slice(-HISTORY_LIMIT);
          restoredFuture = saved.future.slice(0, HISTORY_LIMIT);
        }
      } catch {
        restoredHistory = [];
        restoredFuture = [];
      }
      setHistory(restoredHistory);
      setFuture(restoredFuture);
      setError("");
      setSaveState("saved");
      setSaveError("");
      setSearch("");
      setClipFilter("all");
      setTimelineZoom(1);
      setActiveTime(0);
      if (loaded.active_job_id) {
        try {
          const active = await api<Job>(`/jobs/${loaded.active_job_id}`);
          setJob(active);
          setJobs((items) => [
            active,
            ...items.filter((item) => item.id !== active.id),
          ]);
        } catch {
          /* job may have completed between reads */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open project.");
    }
  }
  function snapshot() {
    setHistory((h) => [...h.slice(-(HISTORY_LIMIT - 1)), clips]);
    setFuture([]);
  }
  function undo() {
    const previous = history[history.length - 1];
    if (!previous) return;
    setFuture((f) => [clips, ...f]);
    setHistory((h) => h.slice(0, -1));
    setClips(previous);
    void syncClips(previous);
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setHistory((h) => [...h, clips]);
    setFuture((f) => f.slice(1));
    setClips(next);
    void syncClips(next);
  }
  async function flushQueuedSaves(): Promise<boolean> {
    if (Object.values(debouncedSaves.current).some((entry) => entry.failed)) {
      setSaveState("error");
      setError("Some edits could not be saved. Retry the save before continuing.");
      return false;
    }
    const queued = Object.entries(debouncedSaves.current);
    for (const [id, entry] of queued) {
      window.clearTimeout(entry.timer);
      void flushDebouncedSave(id, entry);
    }
    await Promise.all([...pendingSaves.current]);
    if (Object.values(debouncedSaves.current).some((entry) => entry.failed)) {
      setSaveState("error");
      setError("Some edits could not be saved. Retry the save before continuing.");
      return false;
    }
    return true;
  }
  async function flushDebouncedSave(
    id: string,
    entry: {
      patch: Partial<Clip>;
      version: number;
      timer: number;
      promise: Promise<void>;
      resolve: () => void;
      failed?: boolean;
      error?: string;
    },
  ) {
    if (debouncedSaves.current[id] !== entry) return;
    entry.failed = false;
    setSaveState("saving");
    try {
      const saved = await persistClip(id, entry.patch);
      if (saved && patchVersions.current[id] === entry.version)
        setClips((list) => list.map((c) => (c.id === id ? saved : c)));
      delete debouncedSaves.current[id];
      // Keep a visible retry state for any other clip whose patch failed.
      // A successful retry or an unrelated save must not hide that failure.
      if (!Object.values(debouncedSaves.current).some((item) => item.failed))
        setSaveError("");
    } catch (e) {
      entry.failed = true;
      entry.error = e instanceof Error ? e.message : "Could not save this edit.";
      setSaveState("error");
      setSaveError(entry.error);
      setError(e instanceof Error ? e.message : "Could not save clip.");
    } finally {
      pendingSaves.current.delete(entry.promise);
      entry.resolve();
    }
  }
  function retryFailedSaves() {
    const failed = Object.entries(debouncedSaves.current).filter(
      ([, entry]) => entry.failed,
    );
    if (!failed.length) return;
    setSaveState("saving");
    for (const [id, entry] of failed) {
      let resolve!: () => void;
      entry.promise = new Promise<void>((done) => {
        resolve = done;
      });
      entry.resolve = resolve;
      entry.failed = false;
      pendingSaves.current.add(entry.promise);
      void flushDebouncedSave(id, entry);
    }
  }
  function queueClipSave(id: string, patch: Partial<Clip>, version: number) {
    setSaveState("saving");
    if (!Object.values(debouncedSaves.current).some((entry) => entry.failed))
      setSaveError("");
    const existing = debouncedSaves.current[id];
    if (existing) {
      existing.patch = { ...existing.patch, ...patch };
      existing.version = version;
      window.clearTimeout(existing.timer);
      existing.timer = window.setTimeout(
        () => void flushDebouncedSave(id, existing),
        220,
      );
      return;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const entry = {
      patch: { ...patch },
      version,
      timer: 0,
      promise,
      resolve,
    };
    entry.timer = window.setTimeout(
      () => void flushDebouncedSave(id, entry),
      220,
    );
    debouncedSaves.current[id] = entry;
    pendingSaves.current.add(promise);
  }
  async function syncClips(next: Clip[]) {
    if (!project) return;
    try {
      if (!(await flushQueuedSaves())) return;
      const saved = await Promise.all(next.map((c) => persistClip(c.id, c)));
      const byId = new Map(
        saved.filter((clip): clip is Clip => Boolean(clip)).map((clip) => [clip.id, clip]),
      );
      setClips((items) => items.map((clip) => byId.get(clip.id) || clip));
      setSaveState("saved");
      setSaveError("");
    } catch (e) {
      setSaveState("error");
      setSaveError(e instanceof Error ? e.message : "Could not save this edit.");
      setError(e instanceof Error ? e.message : "Could not save this edit.");
    }
  }
  async function persistClip(
    id: string,
    patch: Partial<Clip>,
  ): Promise<Clip | undefined> {
    if (!project) return;
    setSaveState("saving");
    if (!Object.values(debouncedSaves.current).some((entry) => entry.failed))
      setSaveError("");
    const previous = saveChains.current[id] || Promise.resolve();
    const request = previous
      .catch(() => undefined)
      .then(() =>
        api<Clip>(`/projects/${project.id}/clips/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      );
    saveChains.current[id] = request;
    pendingSaves.current.add(request);
    try {
      return await request;
    } catch (e) {
      setSaveState("error");
      setSaveError(e instanceof Error ? e.message : "Could not save this edit.");
      throw e;
    } finally {
      pendingSaves.current.delete(request);
      setSaveState((state) =>
        state === "saving" && pendingSaves.current.size === 0 ? "saved" : state,
      );
    }
  }
  function patchClip(id: string, patch: Partial<Clip>) {
    proofJobId.current = "";
    setProofUrl("");
    snapshot();
    setClips((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    if (!project) return;
    const version = (patchVersions.current[id] || 0) + 1;
    patchVersions.current[id] = version;
    queueClipSave(id, patch, version);
  }
  async function addClip() {
    if (!project) {
      setNotice("Import a source to add clips.");
      return;
    }
    try {
      const created = await api<Clip>(`/projects/${project.id}/clips`, {
        method: "POST",
        body: JSON.stringify({
          ...DEFAULT_CLIP,
          title: `Clip ${clips.length + 1}`,
          end: Math.min(duration, targetDuration),
        }),
      });
      setClips((c) => [...c, created]);
      setSelectedId(created.id);
      setNotice("New clip added");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add clip.");
    }
  }
  async function bulkDelete(ids: string[]) {
    if (!project || !ids.length) return;
    try {
      if (!(await flushQueuedSaves())) return;
      const next = await api<Project>(`/projects/${project.id}/clips/bulk`, {
        method: "POST",
        body: JSON.stringify({ action: "delete", clip_ids: ids }),
      });
      const nextClips = next.clips || [];
      setProject(next);
      setClips(nextClips);
      setSelectedId(
        nextClips.find((clip) => clip.id === selectedId)?.id ??
          nextClips[0]?.id ??
          null,
      );
      proofJobId.current = "";
      setProofUrl("");
      setHistory([]);
      setFuture([]);
      setRestoreAvailable(true);
      setNotice(
        `${ids.length} clip${ids.length === 1 ? "" : "s"} removed. You can undo this.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove clips.");
    }
  }
  async function restoreLastBatch() {
    if (!project || !restoreAvailable) return;
    try {
      const next = await api<Project>(`/projects/${project.id}/clips/bulk`, {
        method: "POST",
        body: JSON.stringify({ action: "restore" }),
      });
      const nextClips = next.clips || [];
      setProject(next);
      setClips(nextClips);
      setSelectedId(
        nextClips.find((clip) => clip.selected)?.id ?? nextClips[0]?.id ?? null,
      );
      setRestoreAvailable(false);
      setNotice("Removed clips restored");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restore clips.");
    }
  }
  async function deleteClip(id: string) {
    await bulkDelete([id]);
  }
  async function duplicateClip(c: Clip) {
    if (!project) return;
    try {
      const created = await api<Clip>(`/projects/${project.id}/clips`, {
        method: "POST",
        body: JSON.stringify({
          ...c,
          id: undefined,
          title: `${c.title} copy`,
          start: c.start,
          end: c.end,
        }),
      });
      setClips((list) => [...list, created]);
      setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not duplicate clip.");
    }
  }
  async function workOnClip(clip: Clip) {
    if (!project) return;
    try {
      // The active editor clip is separate from the export selection. Choosing
      // a clip to work on must never silently deselect other export targets.
      setSelectedId(clip.id);
      setTimelineZoom(
        clamp((duration / Math.max(clip.end - clip.start, 1)) * 0.8, 1, 256),
      );
      seek(clip.start, true);
      setNotice(`Editing ${clip.title}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not select this clip.");
    }
  }
  function seek(time: number, forceSource = false) {
    const t = clamp(time, 0, duration);
    setActiveTime(t);
    if (forceSource && proofUrl) {
      proofJobId.current = "";
      pendingSourceSeek.current = t;
      setProofUrl("");
      return;
    }
    if (proofUrl && selected && videoRef.current) {
      const speed = Math.max(0.5, selected.playback_speed ?? 1);
      const proofDuration = Math.max(0, selected.end - selected.start) / speed;
      videoRef.current.currentTime = clamp(
        (t - selected.start) / speed,
        0,
        proofDuration,
      );
      return;
    }
    if (videoRef.current) videoRef.current.currentTime = t;
  }
  function togglePlay() {
    if (!videoRef.current) {
      setPlaying((p) => !p);
      return;
    }
    if (videoRef.current.paused) videoRef.current.play().catch(() => undefined);
    else videoRef.current.pause();
  }
  function setSelectedRange(which: "start" | "end", value: number) {
    if (!selected) return;
    const patch =
      which === "start"
        ? { start: clamp(value, 0, selected.end - 0.1) }
        : { end: clamp(value, selected.start + 0.1, duration) };
    patchClip(selected.id, patch);
  }
  async function analyze(modeOverride?: "full" | "smart") {
    if (!project) return;
    try {
      loadProjectOnDone.current = true;
      const options: AnalysisOptions = {
        mode: modeOverride || analysisMode,
        targetDuration,
        tolerance: analysisTolerance,
        strictMax: analysisStrictMax,
        maxClips: analysisMaxClips,
        topic: analysisTopic.trim(),
        useTranscript: analysisUseTranscript,
        provider: analysisProvider,
      };
      await startJob(
        await api<Job>(`/projects/${project.id}/analyze`, {
          method: "POST",
          body: JSON.stringify({
            target_duration: options.targetDuration,
            mode: options.mode,
            max_clips: options.maxClips,
            tolerance: options.tolerance,
            strict_max: options.strictMax,
            topic: options.topic,
            use_transcript: options.useTranscript,
            provider: options.provider,
          }),
        }),
      );
      setNotice(
        options.mode === "smart"
          ? "Ranking a focused subset of clips"
          : "Analyzing the full video",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed.");
    }
  }
  async function transcribe(
    options: TranscriptionOptions = {
      scope: "source",
      quality: "balanced",
      language: "auto",
      dialect: "none",
      prompt: "",
      force: false,
    },
  ) {
    if (!project || isBusy || health.transcription === false) return;
    try {
      if (!(await flushQueuedSaves())) return;
      loadProjectOnDone.current = true;
      await startJob(
        await api<Job>(`/projects/${project.id}/transcribe`, {
          method: "POST",
          body: JSON.stringify({
            clip_id: options.scope === "clip" ? selected?.id : undefined,
            quality: options.quality,
            language: options.language,
            dialect: options.dialect,
            initial_prompt: options.prompt,
            force: options.force,
          }),
        }),
      );
      setNotice(
        `Transcribing audio with ${health.configuration?.transcription?.provider || "the configured provider"}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transcription failed.");
    }
  }
  async function renderProof() {
    if (!project || !selected || isBusy) return;
    try {
      if (!(await flushQueuedSaves())) return;
      loadProjectOnDone.current = false;
      const proof = await api<Job>(`/projects/${project.id}/preview`, {
        method: "POST",
        body: JSON.stringify({ clip_id: selected.id }),
      });
      proofJobId.current = proof.id;
      await startJob(proof);
      setNotice("Rendering an exact framing proof");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview render failed.");
    }
  }
  async function exportClips(ids: string[]) {
    if (!project || !ids.length || isBusy) return;
    try {
      if (!(await flushQueuedSaves())) return;
      const created = await api<Job>(`/projects/${project.id}/export`, {
        method: "POST",
        body: JSON.stringify({ clip_ids: ids }),
      });
      setExports((x) => [created, ...x]);
      setJob(created);
      setSidebar("exports");
      setNotice("Export queued");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    }
  }
  async function cancelJob(id: string) {
    try {
      const next = await api<Job>(`/jobs/${id}/cancel`, { method: "POST" });
      setJob(next);
      setJobs((items) => items.map((item) => (item.id === id ? next : item)));
      setExports((items) =>
        items.map((item) => (item.id === id ? next : item)),
      );
      setNotice("Job cancelled");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel job.");
    }
  }
  async function retryJob(id: string) {
    try {
      const next = await api<Job>(`/jobs/${id}/retry`, { method: "POST" });
      setJob(next);
      setJobs((items) => [next, ...items.filter((item) => item.id !== id)]);
      setNotice("Job reconnected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not retry job.");
    }
  }
  async function generateBroll(prompt: string, duration: 5 | 10) {
    if (prompt.trim().length < 3 || isBusy) return;
    try {
      const created = await api<Job>("/generations", {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim(), duration }),
      });
      setJobs((items) => [created, ...items]);
      setJob(created);
      setSidebar("exports");
      setNotice(
        "Generation queued. It will open as a new project when ready; provider credits may apply.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation could not start.");
    }
  }
  async function downloadSrt(id: string) {
    if (!project) return;
    try {
      const res = await fetch(
        `${API}/projects/${project.id}/clips/${id}/captions`,
      );
      if (!res.ok)
        throw new Error((await res.text()) || "Captions are not ready yet.");
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `${selected?.title || "captions"}.srt`;
      a.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Caption download failed.");
    }
  }

  const filteredClips = useMemo(
    () =>
      clips.filter((c) => {
        const matchesFilter =
          clipFilter === "all" ||
          (clipFilter === "exported"
            ? c.status === "exported"
            : clipFilter === "reviewed"
              ? !!c.reviewed
              : c.status !== "exported" && !c.reviewed);
        return (
          matchesFilter && c.title.toLowerCase().includes(search.toLowerCase())
        );
      }),
    [clips, search, clipFilter],
  );
  const selectedCount = clips.filter((c) => c.selected).length;

  return (
    <div
      className={`studio-shell workspace-${workspaceMode}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        importFile(e.dataTransfer.files[0]);
      }}
    >
      <header className="studio-header">
        <div className="brand-mark">
          <span className="brand-symbol">◒</span>
          <span>clipflow</span>
        </div>
        <div className="header-context">
          {project ? (
            <>
              <span className="status-dot" /> Editing{" "}
              <strong>{project.title}</strong>
            </>
          ) : (
            <>
              <span className="status-dot idle" /> Your private edit studio
            </>
          )}
          <span className={`save-status ${saveState}`} role="status">
            <span className="save-status-dot" />
            {saveState === "saving"
              ? saveError
                ? "Saving… · previous error"
                : "Saving…"
              : saveState === "error"
                ? "Save failed"
                : "Saved"}
          </span>
          {saveError && (
            <button
              className="save-status-detail"
              title={saveError}
              onClick={retryFailedSaves}
            >
              Retry save
            </button>
          )}
        </div>
        <div className="workspace-toggle" role="tablist" aria-label="Workspace mode">
          <button
            role="tab"
            aria-selected={workspaceMode === "edit"}
            className={workspaceMode === "edit" ? "active" : ""}
            onClick={() => setWorkspaceMode("edit")}
          >
            Edit
          </button>
          <button
            role="tab"
            aria-selected={workspaceMode === "review"}
            className={workspaceMode === "review" ? "active" : ""}
            onClick={() => setWorkspaceMode("review")}
          >
            Review
          </button>
        </div>
        <div className="header-actions">
          <button
            className="new-project-trigger"
            onClick={() => {
              setError("");
              setNewProjectOpen(true);
            }}
          >
            <Plus size={16} /> New project
          </button>
          <button
            className="icon-button"
            title="Undo"
            aria-label="Undo"
            onClick={undo}
            disabled={!history.length}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            title="Redo"
            aria-label="Redo"
            onClick={redo}
            disabled={!future.length}
          >
            <Redo2 size={16} />
          </button>
          <span className="header-divider" />
          <button
            className="icon-button"
            title="Settings"
            aria-label="Open provider settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 size={16} />
          </button>
          <button
            className="quiet-button"
            onClick={() =>
              setNotice(
                "Your source stays in this workspace until you export or connect a provider.",
              )
            }
          >
            <ShieldCheck size={15} /> Private workspace
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="left-panel">
          <div className="panel-top">
            <div className="eyebrow">SOURCE</div>
          </div>
          {projects.length > 0 && (
            <details className="project-history" open={!project}>
              <summary className="history-label">
                <History size={13} /> Your sources · {projects.length}
              </summary>
              <div className="source-history-list">
                {projects.map((item) => (
                  <button
                    key={item.id}
                    className={`project-history-row ${item.id === project?.id ? "current" : ""}`}
                    onClick={() => openProject(item.id)}
                  >
                    <span className="project-dot" />
                    <span>{item.title}</span>
                    <small>{fmt(item.duration)}</small>
                  </button>
                ))}
              </div>
            </details>
          )}
          {!project ? (
            <div className="empty-source">
              <SourceImport
                url={url}
                onUrl={setUrl}
                onFile={importFile}
                onYoutube={importYoutube}
                busy={isBusy || importSubmitting}
                uploading={importSubmitting}
              />
              <button
                className="demo-button"
                onClick={loadDemo}
                disabled={isBusy || importSubmitting}
              >
                <Sparkles size={15} /> Try the 12-second tracking demo{" "}
                <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            <>
              <div className="source-card">
                <div
                  className="source-thumb"
                  style={
                    project.thumbnail_url
                      ? { backgroundImage: `url(${project.thumbnail_url})` }
                      : undefined
                  }
                >
                  <Film size={22} />
                  <span>{fmt(project.duration)}</span>
                </div>
                <div className="source-meta">
                  <strong>{project.title}</strong>
                  <span>
                    {project.width} × {project.height} · {project.fps} fps
                  </span>
                  <span className="source-ok">
                    <Check size={13} /> Source ready
                  </span>
                </div>
              </div>
              <button
                className="outline-button full"
                onClick={() => {
                  setError("");
                  setNewProjectOpen(true);
                }}
              >
                <Plus size={15} /> Import another video
              </button>
              <AnalysisControls
                options={{
                  mode: analysisMode,
                  targetDuration,
                  tolerance: analysisTolerance,
                  strictMax: analysisStrictMax,
                  maxClips: analysisMaxClips,
                  topic: analysisTopic,
                  useTranscript: analysisUseTranscript,
                  provider: analysisProvider,
                }}
                groqAvailable={
                  !!health.configuration?.highlights?.groq_available
                }
                onOpenSettings={() => setSettingsOpen(true)}
                onModeChange={setAnalysisMode}
                onDurationChange={setTargetDuration}
                onToleranceChange={setAnalysisTolerance}
                onStrictMaxChange={setAnalysisStrictMax}
                onMaxClipsChange={setAnalysisMaxClips}
                onTopicChange={setAnalysisTopic}
                onTranscriptChange={setAnalysisUseTranscript}
                onProviderChange={setAnalysisProvider}
                onAnalyze={analyze}
                busy={isBusy}
              />
              <section className="settings-section">
                <div className="section-title">Framing</div>
                <div className="select-row">
                  <button
                    disabled={!selected}
                    className={selected?.framing === "follow" ? "selected" : ""}
                    onClick={() =>
                      selected && patchClip(selected.id, { framing: "follow" })
                    }
                  >
                    <Focus size={15} />
                    <span>Follow subject</span>
                  </button>
                  <button
                    disabled={!selected}
                    className={selected?.framing === "manual" ? "selected" : ""}
                    onClick={() =>
                      selected && patchClip(selected.id, { framing: "manual" })
                    }
                  >
                    <AlignCenter size={15} />
                    <span>Manual focus</span>
                  </button>
                  <button
                    disabled={!selected}
                    className={selected?.framing === "fit" ? "selected" : ""}
                    onClick={() =>
                      selected && patchClip(selected.id, { framing: "fit" })
                    }
                  >
                    <Maximize2 size={15} />
                    <span>Fit frame</span>
                  </button>
                </div>
                {selected?.framing === "manual" && (
                  <label className="range-control">
                    <span>
                      Focus{" "}
                      <b>{Math.round((selected.focus_x || 0.5) * 100)}%</b>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step=".01"
                      value={selected.focus_x}
                      onChange={(e) =>
                        patchClip(selected.id, {
                          focus_x: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                )}
                {selected?.framing === "follow" && (
                  <label className="select-setting">
                    <span>Subject position</span>
                    <select
                      aria-label="Subject position"
                      value={selected.subject || "auto"}
                      onChange={(e) =>
                        patchClip(selected.id, {
                          subject: e.target.value as Clip["subject"],
                        })
                      }
                    >
                      <option value="auto">Auto detect</option>
                      <option value="left">Prefer left</option>
                      <option value="right">Prefer right</option>
                    </select>
                  </label>
                )}
              </section>
              <section className="settings-section">
                <div className="section-title">Enhance</div>
                <TranscriptionControls
                  projectId={project.id}
                  clipId={selected?.id}
                  clipDuration={selected ? selected.end - selected.start : 0}
                  sourceDuration={duration}
                  busy={isBusy}
                  available={health.transcription !== false}
                  settingsOpen={settingsOpen}
                  hasTranscript={Boolean(
                    selected?.transcript?.length || project.transcript?.length,
                  )}
                  onTranscribe={async (options) => transcribe(options)}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
                <div className="setting-line smoothing-row">
                  <span>
                    <Activity size={15} /> Smart smoothing
                  </span>
                  <button
                    disabled={!selected}
                    aria-label={
                      smoothingEnabled
                        ? "Disable smart smoothing"
                        : "Enable smart smoothing"
                    }
                    className={`toggle ${smoothingEnabled ? "on" : ""}`}
                    onClick={() =>
                      selected &&
                      patchClip(selected.id, {
                        smoothing: smoothingEnabled ? 0 : 0.15,
                      })
                    }
                  >
                    <i />
                  </button>
                </div>
                {smoothingEnabled && selected && (
                  <label className="range-control smoothing-control">
                    <span>
                      Strength{" "}
                      <b>{Math.round((selected.smoothing ?? 0.15) * 100)}%</b>
                    </span>
                    <input
                      aria-label="Smoothing strength"
                      type="range"
                      min="0"
                      max="1"
                      step=".01"
                      value={selected.smoothing ?? 0.15}
                      onChange={(e) =>
                        patchClip(selected.id, {
                          smoothing: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                )}
              </section>
              {selected && (
                <ClipEnhancements
                  start={selected.start}
                  end={selected.end}
                  playback_speed={selected.playback_speed ?? 1}
                  audio_volume={selected.audio_volume ?? 1}
                  audio_denoise={selected.audio_denoise ?? false}
                  audio_fade={selected.audio_fade ?? 0}
                  disabled={isBusy}
                  onChange={(patch: ClipEnhancementsValue) =>
                    patchClip(selected.id, patch)
                  }
                />
              )}
              <section className="settings-section caption-settings">
                <div className="section-title">
                  <span>Captions</span>
                  <button
                    className="text-button"
                    onClick={() => selected && downloadSrt(selected.id)}
                  >
                    <Download size={12} /> SRT
                  </button>
                </div>
                <textarea
                  disabled={!selected}
                  value={selected?.caption_text || ""}
                  onChange={(e) =>
                    selected &&
                    patchClip(selected.id, { caption_text: e.target.value })
                  }
                  placeholder="Add a caption overlay or transcribe first…"
                />
                <label className="caption-toggle">
                  <input
                    type="checkbox"
                    disabled={!selected}
                    checked={selected?.caption_enabled !== false}
                    onChange={(e) =>
                      selected &&
                      patchClip(selected.id, {
                        caption_enabled: e.target.checked,
                      })
                    }
                  />{" "}
                  Burn captions into export
                </label>
                <div className="caption-controls">
                  <select
                    disabled={!selected}
                    value={selected?.caption_style || "clean"}
                    onChange={(e) =>
                      selected &&
                      patchClip(selected.id, {
                        caption_style: e.target.value as Clip["caption_style"],
                      })
                    }
                  >
                    <option value="clean">Clean</option>
                    <option value="bold">Bold</option>
                    <option value="minimal">Minimal</option>
                  </select>
                  <input
                    aria-label="Caption color"
                    disabled={!selected}
                    type="color"
                    value={selected?.caption_color || brandColor}
                    onChange={(e) =>
                      selected &&
                      patchClip(selected.id, { caption_color: e.target.value })
                    }
                  />
                  <div className="position-toggle">
                    <button
                      aria-label="Place captions at bottom"
                      className={
                        selected?.caption_position === "bottom"
                          ? "selected"
                          : ""
                      }
                      onClick={() =>
                        selected &&
                        patchClip(selected.id, {
                          caption_position: "bottom",
                          caption_x: 0.5,
                          caption_y: 0.86,
                        })
                      }
                    >
                      <AlignEndHorizontal size={13} />
                    </button>
                    <button
                      aria-label="Place captions at center"
                      className={
                        selected?.caption_position === "center"
                          ? "selected"
                          : ""
                      }
                      onClick={() =>
                        selected &&
                        patchClip(selected.id, {
                          caption_position: "center",
                          caption_x: 0.5,
                          caption_y: 0.5,
                        })
                      }
                    >
                      <AlignCenter size={13} />
                    </button>
                  </div>
                </div>
                {selected && (
                  <CaptionPlacement
                    x={selected.caption_x ?? 0.5}
                    y={selected.caption_y ?? (selected.caption_position === "center" ? 0.5 : 0.86)}
                    disabled={isBusy}
                    onChange={(patch) => patchClip(selected.id, patch)}
                  />
                )}
                <div className="brand-actions">
                  <button
                    className="brand-save"
                    onClick={() => {
                      const color = selected?.caption_color || brandColor;
                      localStorage.setItem("clipflow-brand-color", color);
                      setBrandColor(color);
                      setNotice("Brand color saved");
                    }}
                  >
                    <Palette size={13} /> Save brand color
                  </button>
                  <button
                    className="brand-save"
                    onClick={() => {
                      const color = brandColor;
                      selected &&
                        patchClip(selected.id, { caption_color: color });
                      setNotice("Brand color applied");
                    }}
                  >
                    Apply preset
                  </button>
                  <button
                    className="brand-save"
                    onClick={() => {
                      setBrandColor("#b8a7ff");
                      selected &&
                        patchClip(selected.id, { caption_color: "#b8a7ff" });
                      localStorage.removeItem("clipflow-brand-color");
                      setNotice("Brand color reset");
                    }}
                  >
                    Reset
                  </button>
                </div>
              </section>
              <section className="settings-section shortcuts">
                <div className="section-title">Shortcuts</div>
                <div>
                  <kbd>Space</kbd>
                  <span>Play / pause</span>
                </div>
                <div>
                  <kbd>I</kbd>
                  <span>Set in point</span>
                  <kbd>O</kbd>
                  <span>Set out point</span>
                </div>
                <div>
                  <kbd>Ctrl Z</kbd>
                  <span>Undo edit</span>
                </div>
              </section>
            </>
          )}
          <div className="left-footer">
            <button
              className="icon-button"
              title="Settings"
              aria-label="Open provider settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 size={16} />
            </button>
          </div>
        </aside>
        <main className="canvas-area">
          <div className="canvas-toolbar">
            <div className="crumb">
              <Clapperboard size={16} />
              <span>{project ? "Edit" : "New project"}</span>
            </div>
            <div className="canvas-tools">
              <span className="tool-button">9:16</span>
              <select
                className="tool-button"
                aria-label="Export resolution"
                value={selected?.resolution || 720}
                disabled={!selected}
                onChange={(e) =>
                  selected &&
                  patchClip(selected.id, { resolution: Number(e.target.value) })
                }
              >
                <option value="360">360 × 640</option>
                <option value="720">720 × 1280</option>
                <option value="1080">1080 × 1920</option>
              </select>
              <button
                className="tool-button"
                disabled={!selected || isBusy}
                onClick={renderProof}
              >
                Render proof
              </button>
              {proofUrl && (
                <a
                  className="tool-button"
                  href={proofUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open rendered proof
                </a>
              )}
            </div>
          </div>
          <div className="preview-stage">
            <div className="current-clip-strip">
              <div>
                <span className="current-clip-kicker">Editing</span>
                <strong>{selected?.title || "No clip selected"}</strong>
                {selected && (
                  <small>
                    {fmt(selected.start)}–{fmt(selected.end)} ·{" "}
                    {fmt(selected.end - selected.start)} source
                  </small>
                )}
              </div>
              <button
                className="tool-button current-export"
                disabled={!selected || isBusy}
                onClick={() => selected && exportClips([selected.id])}
              >
                <Download size={14} /> Export current
              </button>
            </div>
            <PreviewPlayer
              project={project}
              clip={selected}
              proofUrl={proofUrl}
              duration={duration}
              activeTime={activeTime}
              videoRef={videoRef}
              pendingSourceSeek={pendingSourceSeek}
              playing={playing}
              expanded={expandedPreview}
              onPlayState={setPlaying}
              onTimeChange={setActiveTime}
              onPatch={patchClip}
              onRenderProof={renderProof}
              onUseSource={() => {
                proofJobId.current = "";
                pendingSourceSeek.current = clamp(activeTime, 0, duration);
                setProofUrl("");
              }}
              onExpand={() => setExpandedPreview((value) => !value)}
            />
          </div>
          <EditorTimeline
            duration={duration}
            clips={clips}
            selectedId={selectedId}
            activeTime={activeTime}
            playing={playing}
            zoom={timelineZoom}
            onZoomChange={setTimelineZoom}
            onSeek={(time) => seek(time, true)}
            onSelect={(clip) => {
              if (clip.id !== selectedId) {
                proofJobId.current = "";
                setProofUrl("");
              }
              setSelectedId(clip.id);
              seek(clip.start, true);
            }}
            onPlayToggle={togglePlay}
            onStep={(amount) => seek(activeTime + amount, true)}
            onTrim={(id, start, end) => patchClip(id, { start, end })}
            onFitSource={() => setTimelineZoom(1)}
            onFocusClip={() =>
              selected &&
              setTimelineZoom(
                clamp(
                  (duration / Math.max(selected.end - selected.start, 1)) * 0.8,
                  1,
                  256,
                ),
              )
            }
          />
          {selected && (
            <div className="trim-sliders">
              <label>
                Start{" "}
                <input
                  aria-label="Trim start"
                  type="range"
                  min="0"
                  max={duration}
                  step="0.1"
                  value={selected.start}
                  onChange={(e) =>
                    setSelectedRange("start", Number(e.target.value))
                  }
                />
              </label>
              <label>
                End{" "}
                <input
                  aria-label="Trim end"
                  type="range"
                  min="0"
                  max={duration}
                  step="0.1"
                  value={selected.end}
                  onChange={(e) =>
                    setSelectedRange("end", Number(e.target.value))
                  }
                />
              </label>
            </div>
          )}
        </main>
        <aside className="right-panel">
          <div className="right-tabs">
            {(["clips", "exports", "transcript", "connections"] as const).map(
              (tab) => (
                <button
                  key={tab}
                  className={sidebar === tab ? "active" : ""}
                  onClick={() => setSidebar(tab)}
                >
                  {tab === "clips" ? (
                    <Layers3 size={15} />
                  ) : tab === "exports" ? (
                    <ArrowDownToLine size={15} />
                  ) : tab === "transcript" ? (
                    <MessageSquareText size={15} />
                  ) : (
                    <Link2 size={15} />
                  )}
                  <span>{tab}</span>
                  {tab === "clips" && clips.length > 0 && <b>{clips.length}</b>}
                </button>
              ),
            )}
          </div>
          {sidebar === "clips" && (
            <div className="clips-pane">
              <div className="clips-toolbar">
                <div className="pane-title">
                  Clip library <span>{clips.length}</span>
                </div>
                <button
                  className="icon-button"
                  aria-label="Add clip"
                  onClick={addClip}
                >
                  <Plus size={17} />
                </button>
              </div>
              {clips.length > 0 && (
                <>
                  <div className="clip-search">
                    <Search size={14} />
                    <input
                      placeholder="Search clips"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        aria-label="Clear clip search"
                        onClick={() => setSearch("")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <div
                    className="clip-filters"
                    role="tablist"
                    aria-label="Clip filters"
                  >
                    {(["all", "drafts", "reviewed", "exported"] as const).map((filter) => (
                      <button
                        key={filter}
                        className={clipFilter === filter ? "active" : ""}
                        onClick={() => setClipFilter(filter)}
                      >
                        {filter === "all"
                          ? "All"
                          : filter === "drafts"
                            ? "Drafts"
                            : filter === "reviewed"
                              ? "Reviewed"
                            : "Exported"}
                      </button>
                    ))}
                  </div>
                  {clips.some((clip) => clip.reason || clip.score !== undefined) && (
                    <div className="suggestion-toolbar">
                      <span>Suggestions</span>
                      <button
                        className="text-button"
                        disabled={isBusy}
                        onClick={() => void analyze("smart")}
                      >
                        <WandSparkles size={12} /> Regenerate
                      </button>
                    </div>
                  )}
                </>
              )}
              <div className="clip-list">
                {filteredClips.length === 0 ? (
                  <div className="no-clips">
                    <div className="empty-list-icon">
                      <Scissors size={17} />
                    </div>
                    <strong>
                      {clips.length
                        ? "No clips match this view"
                        : "No clips yet"}
                    </strong>
                    <span>
                      {clips.length
                        ? "Clear the search or switch between All, Drafts, Reviewed, and Exported."
                        : "Import and split a video, or add a clip manually."}
                    </span>
                    {!clips.length && (
                      <button className="outline-button" onClick={addClip}>
                        <Plus size={14} /> Add first clip
                      </button>
                    )}
                  </div>
                ) : (
                  filteredClips.map((c) => (
                    <ClipRow
                      key={c.id}
                      clip={c}
                      duration={duration}
                      active={c.id === selectedId}
                      onSelect={() => {
                        if (c.id !== selectedId) {
                          proofJobId.current = "";
                          setProofUrl("");
                        }
                        setSelectedId(c.id);
                        seek(c.start, true);
                      }}
                      onPatch={(p) => patchClip(c.id, p)}
                      onReview={() => patchClip(c.id, { reviewed: !c.reviewed })}
                      onSuggestionStatus={(suggestion_status) =>
                        patchClip(c.id, { suggestion_status })
                      }
                      onDelete={() => deleteClip(c.id)}
                      onDuplicate={() => duplicateClip(c)}
                      onWork={() => workOnClip(c)}
                    />
                  ))
                )}
              </div>
              {clips.length > 0 && (
                <div className="clips-footer">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={selectedCount === clips.length}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        clips.forEach((c) => {
                          void patchClip(c.id, { selected: checked });
                        });
                      }}
                    />
                    <span>Select all clips</span>
                  </label>
                  <button
                    className="export-button"
                    disabled={!selectedCount || isBusy}
                    onClick={() =>
                      exportClips(
                        clips.filter((c) => c.selected).map((c) => c.id),
                      )
                    }
                  >
                    <Download size={15} /> Export{" "}
                    {selectedCount ? `${selectedCount} selected` : "all"}
                  </button>
                  <div className="clip-bulk-actions">
                    <button
                      className="text-button danger-text"
                      disabled={!selectedCount || isBusy}
                      onClick={() =>
                        bulkDelete(
                          clips
                            .filter((clip) => clip.selected)
                            .map((clip) => clip.id),
                        )
                      }
                    >
                      Remove selected
                    </button>
                    <button
                      className="text-button danger-text"
                      disabled={!clips.length || isBusy}
                      onClick={() => bulkDelete(clips.map((clip) => clip.id))}
                    >
                      Clear clips
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {sidebar === "exports" && (
            <ExportsPane
              exports={exports.filter(
                (item) =>
                  item.project_id === project?.id && item.kind === "export_job",
              )}
              jobs={jobs.filter(
                (item) =>
                  item.project_id === project?.id && item.kind === "export_job",
              )}
              onExport={() => exportClips(clips.map((c) => c.id))}
              onCancel={cancelJob}
              onRetry={retryJob}
            />
          )}
          {sidebar === "transcript" && (
            <TranscriptPanel
              projectId={
                project
                  ? `${project.id}:${selected?.transcript ? selected.id : "source"}`
                  : ""
              }
              segments={
                (selected?.transcript ??
                  project?.transcript ??
                  []) as TranscriptSegment[]
              }
              busy={isBusy}
              onSeek={(time) => seek(time, true)}
              onSave={async (segments) => {
                if (!project) return;
                if (!(await flushQueuedSaves())) return;
                const saved = await api<Project>(
                  `/projects/${project.id}/transcript`,
                  {
                    method: "PUT",
                    body: JSON.stringify({
                      segments,
                      clip_id: selected?.transcript ? selected.id : undefined,
                    }),
                  },
                );
                setProject(saved);
                setClips(saved.clips || []);
                proofJobId.current = "";
                setProofUrl("");
                setHistory([]);
                setFuture([]);
                setNotice("Transcript saved");
              }}
              onCreateClip={async (start, end, title) => {
                if (!project) return;
                const created = await api<Clip>(
                  `/projects/${project.id}/clips`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      ...DEFAULT_CLIP,
                      title,
                      start,
                      end,
                      selected: true,
                      source_clip_id: selected?.transcript
                        ? selected.id
                        : undefined,
                    }),
                  },
                );
                proofJobId.current = "";
                setProofUrl("");
                setClips((list) => [...list, created]);
                setSelectedId(created.id);
                seek(start, true);
              }}
              onTranscribe={transcribe}
            />
          )}
          {sidebar === "connections" && (
            <ConnectionsPane
              health={health}
              busy={isBusy}
              prompt={generationPrompt}
              setPrompt={setGenerationPrompt}
              duration={generationDuration}
              setDuration={setGenerationDuration}
              onGenerate={generateBroll}
            />
          )}
        </aside>
      </div>
      {(job?.status === "queued" || job?.status === "running") && (
        <div className="job-toast">
          <LoaderCircle className="spin" size={16} />
          <div>
            <strong>{job.stage || "Working locally"}</strong>
            <span>{Math.round(job.progress || 0)}% · you can keep editing</span>
            {job.warning && <small className="job-warning">{job.warning}</small>}
          </div>
          <div className="job-progress">
            <i style={{ width: `${job.progress || 0}%` }} />
          </div>
          <button className="job-cancel" onClick={() => cancelJob(job.id)}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div className="notice error">
          <Ban size={16} />
          <span>{error}</span>
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      {notice && (
        <div className="notice">
          <Check size={16} />
          <span>{notice}</span>
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      {restoreAvailable && (
        <div className="notice undo-notice">
          <span>Removed clips stay recoverable.</span>
          <button onClick={restoreLastBatch}>Undo remove</button>
          <button
            aria-label="Dismiss undo"
            onClick={() => setRestoreAvailable(false)}
          >
            ×
          </button>
        </div>
      )}
      {newProjectOpen && (
        <NewProjectDialog
          url={url}
          onUrl={setUrl}
          onFile={importFile}
          onYoutube={importYoutube}
          busy={isBusy || importSubmitting}
          uploading={importSubmitting}
          onClose={() => setNewProjectOpen(false)}
          error={error}
        />
      )}
      <ProviderSettings
        api={api}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onHealth={setHealth}
        onNotice={setNotice}
      />
    </div>
  );
}

function NumberSetting({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const next =
      draft.trim() && Number.isFinite(Number(draft))
        ? clamp(Math.round(Number(draft)), min, max)
        : value;
    setDraft(String(next));
    onChange(next);
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function AnalysisControls({
  options,
  groqAvailable,
  onOpenSettings,
  onModeChange,
  onDurationChange,
  onToleranceChange,
  onStrictMaxChange,
  onMaxClipsChange,
  onTopicChange,
  onTranscriptChange,
  onProviderChange,
  onAnalyze,
  busy,
}: {
  options: AnalysisOptions;
  groqAvailable: boolean;
  onOpenSettings: () => void;
  onModeChange: (value: "full" | "smart") => void;
  onDurationChange: (value: number) => void;
  onToleranceChange: (value: number) => void;
  onStrictMaxChange: (value: number | null) => void;
  onMaxClipsChange: (value: number) => void;
  onTopicChange: (value: string) => void;
  onTranscriptChange: (value: boolean) => void;
  onProviderChange: (value: "local" | "groq") => void;
  onAnalyze: () => void;
  busy: boolean;
}) {
  return (
    <section className={`settings-section analysis-controls ${options.mode}`}>
      <div className="section-title">
        <span>Clip generation</span>
        <Info size={13} />
      </div>
      <div className="analysis-modes">
        <button
          className={options.mode === "full" ? "active" : ""}
          onClick={() => onModeChange("full")}
        >
          <strong>Full video</strong>
          <small>Review every candidate from the source.</small>
        </button>
        <button
          className={options.mode === "smart" ? "active" : ""}
          onClick={() => onModeChange("smart")}
        >
          <strong>Smart highlights</strong>
          <small>Rank a focused subset within your limit.</small>
        </button>
      </div>
      <div className="analysis-grid">
        <label>
          Approx. duration
          <NumberSetting
            min={5}
            max={300}
            value={options.targetDuration}
            onChange={onDurationChange}
          />
          <span>seconds</span>
        </label>
        <label className="smart-only">
          Tolerance
          <NumberSetting
            min={10}
            max={50}
            value={Math.round(options.tolerance * 100)}
            onChange={(value) => onToleranceChange(value / 100)}
          />
          <span>± percent</span>
        </label>
        <label className="smart-only strict-max-field">
          <span className="strict-max-label">
            <input
              type="checkbox"
              checked={options.strictMax !== null}
              onChange={(event) =>
                onStrictMaxChange(event.target.checked ? options.targetDuration : null)
              }
            />
            Strict maximum
          </span>
          <NumberSetting
            min={1}
            max={300}
            value={options.strictMax ?? options.targetDuration}
            disabled={options.strictMax === null}
            onChange={onStrictMaxChange}
          />
          <span>seconds</span>
        </label>
        <label className="smart-only">
          Max clips
          <NumberSetting
            min={1}
            max={20}
            value={options.maxClips}
            onChange={onMaxClipsChange}
          />
          <span>clips</span>
        </label>
      </div>
      <label className="analysis-topic">
        Topic or angle
        <input
          value={options.topic}
          onChange={(event) => onTopicChange(event.target.value)}
          placeholder="e.g. arrival, food, street detail"
        />
      </label>
      <div className="analysis-options">
        <label>
          <input
            type="checkbox"
            checked={options.useTranscript}
            onChange={(event) => onTranscriptChange(event.target.checked)}
          />{" "}
          Use transcript highlights
        </label>
        <label>
          Provider
          <select
            value={options.provider}
            onChange={(event) =>
              onProviderChange(event.target.value as "local" | "groq")
            }
          >
            <option value="local">Local</option>
            <option value="groq" disabled={!groqAvailable}>
              Groq{groqAvailable ? "" : " · configure in settings"}
            </option>
          </select>
        </label>
      </div>
      {!groqAvailable && (
        <button className="analysis-link" onClick={onOpenSettings}>
          Set up Groq in provider settings
        </button>
      )}
      <p className="analysis-note">
        {options.mode === "smart"
          ? "Smart highlights selects up to the limit and keeps existing clips and edits."
          : "Full video analyzes every candidate across the source."}
      </p>
      <button className="lime-button full" onClick={onAnalyze} disabled={busy}>
        <WandSparkles size={15} />{" "}
        {options.mode === "smart" ? "Find highlights" : "Analyze full video"}
      </button>
    </section>
  );
}

function StatusPill({ value }: { value: string }) {
  return (
    <span className={`status-pill ${value === "Ready" ? "ready" : ""}`}>
      {value}
    </span>
  );
}
function ClipRow({
  clip,
  duration,
  active,
  onSelect,
  onPatch,
  onDelete,
  onDuplicate,
  onWork,
  onReview,
  onSuggestionStatus,
}: {
  clip: Clip;
  duration: number;
  active: boolean;
  onSelect: () => void;
  onPatch: (p: Partial<Clip>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onWork: () => void;
  onReview: () => void;
  onSuggestionStatus: (
    status: "pending" | "kept" | "discarded",
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftStart, setDraftStart] = useState(String(clip.start));
  const [draftEnd, setDraftEnd] = useState(String(clip.end));
  useEffect(() => {
    setDraftStart(String(clip.start));
    setDraftEnd(String(clip.end));
  }, [clip.start, clip.end]);
  function commitStart() {
    const parsed = Number(draftStart);
    onPatch({
      start: Number.isFinite(parsed)
        ? clamp(parsed, 0, Math.max(0, clip.end - 0.1))
        : clip.start,
    });
  }
  function commitEnd() {
    const parsed = Number(draftEnd);
    onPatch({
      end: Number.isFinite(parsed)
        ? clamp(parsed, Math.min(duration, clip.start + 0.1), duration)
        : clip.end,
    });
  }
  return (
    <article
      className={`clip-row ${active ? "active" : ""}`}
      onClick={onSelect}
    >
      <div className="clip-thumbnail">
        <div className="thumb-bars" />
        <span>
          {fmt(clip.start)} → {fmt(clip.end)}
        </span>
        <button
          className="thumb-play"
          aria-label={`Select ${clip.title} preview`}
        >
          <Play size={13} fill="currentColor" />
        </button>
      </div>
      <div className="clip-content">
        <div className="clip-name-line">
          {editing ? (
            <input
              autoFocus
              value={clip.title}
              onChange={(e) => onPatch({ title: e.target.value })}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <strong
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
            >
              {clip.title}
            </strong>
          )}
          <button
            title="Duplicate clip"
            className="row-menu"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
          >
            <Copy size={13} />
          </button>
        </div>
        <div className="clip-meta">
          <input
            type="checkbox"
            aria-label={`Select ${clip.title}`}
            checked={!!clip.selected}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onPatch({ selected: e.target.checked })}
          />
          <span>
            <Clock3 size={12} />
            {fmt(clip.end - clip.start)}
          </span>
          <span className={clip.status === "exported" ? "ready-text" : ""}>
            {clip.status === "exported"
              ? "Exported"
              : clip.reviewed
                ? "Reviewed"
                : "Draft"}
            </span>
          {active && <b className="clip-editing-label">Editing</b>}
          {clip.reviewed && <b className="clip-reviewed-label">✓</b>}
        </div>
        {(clip.reason || clip.score !== undefined) && (
          <div className="clip-reason">
            <span>
              {clip.reason || "Suggested highlight"}
              {clip.score !== undefined && (
                <b>{Math.round(clip.score * 100)}%</b>
              )}
            </span>
            <span className="suggestion-status">
              {clip.suggestion_status === "kept"
                ? "Kept"
                : clip.suggestion_status === "discarded"
                  ? "Discarded"
                  : "Suggested"}
            </span>
          </div>
        )}
        {(clip.reason || clip.score !== undefined) && (
          <div className="suggestion-actions">
            <button
              className={clip.suggestion_status === "kept" ? "active" : ""}
              onClick={(e) => {
                e.stopPropagation();
                onSuggestionStatus("kept");
              }}
            >
              Keep
            </button>
            <button
              className={clip.suggestion_status === "discarded" ? "active" : ""}
              onClick={(e) => {
                e.stopPropagation();
                onSuggestionStatus("discarded");
              }}
            >
              Discard
            </button>
            {clip.suggestion_status === "discarded" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSuggestionStatus("pending");
                }}
              >
                Restore
              </button>
            )}
          </div>
        )}
        <div className="clip-range">
          <input
            aria-label="Clip start"
            type="number"
            min="0"
            step=".1"
            value={draftStart}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftStart(e.target.value)}
            onBlur={commitStart}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          <span>–</span>
          <input
            aria-label="Clip end"
            type="number"
            min="0"
            step=".1"
            value={draftEnd}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftEnd(e.target.value)}
            onBlur={commitEnd}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
          <button
            className="delete-clip"
            title="Delete clip"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={12} />
          </button>
          <button
            className="work-clip"
            onClick={(e) => {
              e.stopPropagation();
              onWork();
            }}
          >
            Work on this clip
          </button>
          <button
            className="review-clip"
            onClick={(e) => {
              e.stopPropagation();
              onReview();
            }}
          >
            {clip.reviewed ? "Unmark reviewed" : "Mark reviewed"}
          </button>
        </div>
      </div>
    </article>
  );
}
function jobTitle(kind?: string) {
  return (
    (
      {
        preview_job: "Rendered proof",
        export_job: "Clip export",
        upload_job: "Import source",
        youtube_job: "YouTube import",
        demo_job: "Tracking demo",
        analyze_job: "Clip analysis",
        transcribe_job: "Transcription",
        higgsfield_job: "B-roll generation",
      } as Record<string, string>
    )[kind || ""] || "Background job"
  );
}
function ExportsPane({
  exports,
  jobs,
  onExport,
  onCancel,
  onRetry,
}: {
  exports: Job[];
  jobs: Job[];
  onExport: () => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const rows = jobs.length ? jobs : exports;
  return (
    <div className="exports-pane">
      <div className="pane-heading">
        <div>
          <div className="pane-title">Exports</div>
          <p>Finished renders and live jobs</p>
        </div>
        <button className="export-button compact" onClick={onExport}>
          <Download size={15} /> Export all
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="export-intro">
          <div className="export-icon">
            <Download size={20} />
          </div>
          <strong>Nothing rendered yet</strong>
          <span>Select clips and export when the cut is ready.</span>
          <button className="export-button" onClick={onExport}>
            <Download size={15} /> Export all clips
          </button>
        </div>
      ) : (
        <div className="job-list">
          {rows.map((x) => (
            <div className="export-item" key={x.id}>
              <div className="job-info">
                <FileVideo size={16} />
                <span>
                  <strong>
                    {x.clip_titles?.join(", ") || jobTitle(x.kind)}
                  </strong>
                  <small>
                    {x.created_at
                      ? `${new Date(x.created_at).toLocaleString()} · `
                      : ""}
                    {x.status === "done" ? "Exported" : x.stage || x.status} ·{" "}
                    {Math.round(x.progress || (x.status === "done" ? 100 : 0))}%
                  </small>
                  {x.error && (
                    <small style={{ color: "#b94d40", whiteSpace: "normal" }}>
                      {x.error}
                    </small>
                  )}
                  {x.warning && (
                    <small className="job-warning">{x.warning}</small>
                  )}
                </span>
              </div>
              <div className="job-actions">
                {x.download_url && x.status === "done" && (
                  <a
                    href={x.download_url}
                    download
                    aria-label="Download export"
                  >
                    <Download size={14} />
                  </a>
                )}
                {(x.status === "queued" || x.status === "running") && (
                  <button title="Cancel job" onClick={() => onCancel(x.id)}>
                    <Ban size={14} />
                  </button>
                )}
                {(x.status === "error" || x.status === "cancelled") && (
                  <button title="Retry job" onClick={() => onRetry(x.id)}>
                    <RotateCcw size={14} />
                  </button>
                )}
                {x.status === "done" && (
                  <Check size={15} className="job-done" />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function ConnectionsPane({
  health,
  busy,
  prompt,
  setPrompt,
  duration,
  setDuration,
  onGenerate,
}: {
  health: Health;
  busy: boolean;
  prompt: string;
  setPrompt: (value: string) => void;
  duration: 5 | 10;
  setDuration: (value: 5 | 10) => void;
  onGenerate: (prompt: string, duration: 5 | 10) => void;
}) {
  const hf = health.configuration?.higgsfield;
  const canGenerate = !!hf?.configured && !busy && prompt.trim().length >= 3;
  return (
    <div className="connections-pane">
      <div className="pane-title">Generate a B-roll shot</div>
      <p className="pane-lede">
        Create a short insert with Higgsfield. The finished generation opens as
        a new project. Provider credits and account usage are yours.
      </p>
      <label className="field-label">Prompt</label>
      <textarea
        className="generation-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
      />
      <div className="generation-row">
        <div>
          <span className="field-label">Duration</span>
          <div className="duration-pills">
            {([5, 10] as const).map((value) => (
              <button
                key={value}
                className={duration === value ? "active" : ""}
                onClick={() => setDuration(value)}
              >
                {value}s
              </button>
            ))}
          </div>
        </div>
        <button
          className="generate-button"
          disabled={!canGenerate}
          onClick={() => onGenerate(prompt, duration)}
        >
          <Sparkles size={15} /> Generate
        </button>
      </div>
      <div className={`provider-note ${hf?.configured ? "ready" : ""}`}>
        <span className="provider-dot" />
        <div>
          <strong>
            {hf?.configured ? "Higgsfield ready" : "Higgsfield needs setup"}
          </strong>
          <small>
            {hf?.message ||
              "Add HF_API_KEY and HF_API_SECRET to the server environment."}
          </small>
        </div>
      </div>
      <div className="engine-list">
        <div>
          <span className={health.ffmpeg ? "on-dot" : "off-dot"} />
          <span>FFmpeg</span>
          <b>{health.ffmpeg ? "Ready" : "Unavailable"}</b>
        </div>
        <div>
          <span className={health.ffprobe ? "on-dot" : "off-dot"} />
          <span>FFprobe</span>
          <b>{health.ffprobe ? "Ready" : "Unavailable"}</b>
        </div>
        <div>
          <span
            className={
              health.configuration?.transcription?.available
                ? "on-dot"
                : "off-dot"
            }
          />
          <span>
            {health.configuration?.transcription?.provider || "Transcription"}
          </span>
          <b>
            {health.configuration?.transcription?.available
              ? "Ready"
              : "Optional"}
          </b>
        </div>
      </div>
    </div>
  );
}
