import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlignCenter,
  AlignEndHorizontal,
  ArrowLeft,
  Ban,
  Check,
  Clapperboard,
  Download,
  Film,
  Focus,
  FolderOpen,
  Layers3,
  Link2,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Palette,
  Save,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Undo2,
} from "lucide-react";
import ClipEnhancements, {
  type ClipEnhancementsValue,
} from "./ClipEnhancements";
import EditorTimeline from "./EditorTimeline";
import TranscriptPanel, { type TranscriptSegment } from "./TranscriptPanel";
import TranscriptionControls from "./TranscriptionControls";
import { NewProjectDialog } from "./SourceImport";
import CaptionPlacement from "./CaptionPlacement";
import PreviewPlayer from "./PreviewPlayer";
import ProviderSettings from "./ProviderSettings";
import PublishPage from "./PublishPage";
import PublishingSettings from "./PublishingSettings";
import CameraControls from "./CameraControls";
import ClipSetup, { type ClipSetupSettings } from "./ClipSetup";
import WorkspaceNav from "./WorkspaceNav";
import ProjectsPage, { type ProjectChanges } from "./ProjectsPage";
import ExportsPage from "./ExportsPage";
import SettingsPage from "./SettingsPage";
import GuidedTour, { type TourPage } from "./GuidedTour";
import CaptionPresets from "./CaptionPresets";
import ClipLibrary from "./ClipLibrary";
import { libraryPatch, type LibraryPatch } from "./clipLibraryModel";
import { parseSubtitles } from "./subtitleImport";
import { api, AUTH_EXPIRED_EVENT } from "./apiClient";
import "./workspace.css";
import type {
  Clip,
  Health,
  Job,
  Project,
  TranscriptionOptions,
} from "./editorTypes";

const API = "/api";
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

const fmt = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const HISTORY_LIMIT = 12;
const historyKey = (projectId: string) => `clipflow-edit-history-${projectId}`;
const clipFingerprint = (items: Clip[]) =>
  items.map((clip) => `${clip.id}:${clip.revision || 0}`).join("|");

function routePage(): TourPage {
  const value = window.location.hash.split("/")[1];
  return ["projects", "editor", "exports", "publish", "settings"].includes(
    value,
  )
    ? (value as TourPage)
    : "projects";
}
export default function App() {
  const [page, setPage] = useState<TourPage>(routePage);
  const [settingsSection, setSettingsSection] = useState("processing");
  const [navCompact, setNavCompact] = useState(false);
  const [tourSetupStep, setTourSetupStep] = useState<
    "source" | "moments" | "camera" | "captions" | "review" | undefined
  >();
  const [tourReplay, setTourReplay] = useState(0);
  const [inspector, setInspector] = useState<
    "clipping" | "layout" | "captions" | "audio"
  >("clipping");
  const [subtitleDraft, setSubtitleDraft] = useState<
    { start: number; end: number; text: string }[] | null
  >(null);
  const [health, setHealth] = useState<Health>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<
    "clips" | "connections" | "transcript"
  >("clips");
  const targetDuration = 30;
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [url, setUrl] = useState("");
  const [activeTime, setActiveTime] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [playing, setPlaying] = useState(false);

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
  const [showSetup, setShowSetup] = useState(false);
  const [analysisSubmitting, setAnalysisSubmitting] = useState(false);
  const inspectorContent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Each tool opens at its first decision, not at the previous tool's scroll position.
    if (inspectorContent.current) inspectorContent.current.scrollTop = 0;
  }, [inspector, project?.id]);
  const [expandedPreview, setExpandedPreview] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"edit" | "review">("edit");
  const settingsOpen = page === "settings";
  const setSettingsOpen = (open: boolean) => {
    if (open) void navigatePage("settings");
  };
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [saveState, setSaveState] = useState<
    "saved" | "dirty" | "saving" | "error"
  >("saved");
  const [saveError, setSaveError] = useState("");
  const importInFlight = useRef(false);
  const importJobId = useRef("");
  const openRequestId = useRef(0);
  const proofJobId = useRef("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSourceSeek = useRef<number | null>(null);
  const patchVersions = useRef<Record<string, number>>({});
  const loadProjectOnDone = useRef(false);
  const pendingSaves = useRef<Set<Promise<unknown>>>(new Set());
  const [librarySaving, setLibrarySaving] = useState(0);
  const libraryVersions = useRef<Record<string, number>>({});
  const saveChains = useRef<Record<string, Promise<unknown>>>({});
  const debouncedSaves = useRef<
    Record<
      string,
      {
        patch: Partial<Clip>;
        version: number;
        failed?: boolean;
        error?: string;
      }
    >
  >({});
  const resumed = useRef(false);

  // Restore the working clip after a refresh without changing export checkboxes.
  useEffect(() => {
    if (resumed.current || !projects.length) return;
    resumed.current = true;
    const last = window.location.hash.startsWith("#/editor/")
      ? window.location.hash.split("/")[2]
      : localStorage.getItem("clipflow-current-project");
    if (last && projects.some((item) => item.id === last && !item.archived))
      void openProject(last, false);
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
      if (
        !pendingSaves.current.size &&
        !Object.keys(debouncedSaves.current).length
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, []);

  const selected = clips.find((c) => c.id === selectedId) ?? clips[0];
  const duration = project?.duration || 0;
  const isBusy = job?.status === "queued" || job?.status === "running";
  const brollAvailable = health.configuration?.higgsfield?.configured === true;
  useEffect(() => {
    if (!brollAvailable && sidebar === "connections") setSidebar("clips");
  }, [brollAvailable, sidebar]);

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
          "generate_clips_job",
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
            setInspector("clipping");
            setShowSetup(true);
            setNotice("Source imported. Choose how you want to create clips.");
            proofJobId.current = "";
            setProofUrl("");
            setPlaying(false);
            setActiveTime(0);
            setTimelineZoom(1);
            setSidebar("clips");
            setUrl("");
            setPage("editor");
            window.history.pushState(null, "", `#/editor/${loaded.id}`);
          }
          setProject(loaded);
          setClips(nextClips);
          if (next.kind === "generate_clips_job") {
            setShowSetup(false);
            setInspector("layout");
            setWorkspaceMode("edit");
            setSidebar("clips");
            const first = nextClips.find(
              (clip) => clip.generation_id === next.id,
            );
            if (first) {
              setActiveTime(first.start);
              pendingSourceSeek.current = first.start;
              setTimelineZoom(
                clamp(
                  (loaded.duration / Math.max(first.end - first.start, 1)) *
                    0.8,
                  1,
                  256,
                ),
              );
            }
            setProofUrl("");
            proofJobId.current = "";
          }
          setRestoreAvailable(Boolean(loaded.can_restore_clips));
          setSelectedId(
            (next.kind === "transcribe_job" &&
            selectedId &&
            nextClips.some((clip) => clip.id === selectedId)
              ? selectedId
              : undefined) ??
              (next.kind === "generate_clips_job"
                ? nextClips.find((clip) => clip.generation_id === next.id)?.id
                : undefined) ??
              nextClips.find((clip) => clip.selected)?.id ??
              nextClips[0]?.id ??
              null,
          );
          refreshProjects();
          setNotice(
            next.kind === "generate_clips_job"
              ? "Clips generated. Select a clip to adjust its timing, camera or captions."
              : next.kind === "transcribe_job"
                ? "Transcription complete."
                : "Source imported. Configure your clips to continue.",
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
          if (next.status === "error") {
            setNotice("");
            setError(
              next.error || "The job failed. Check the source and try again.",
            );
          }
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
      if (
        newProjectOpen ||
        page !== "editor" ||
        document.querySelector("[role=dialog]")
      )
        return;
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
  async function importYoutube(quality: number) {
    if (!url.trim()) return;
    await beginImport(
      () =>
        api<Job>("/projects/youtube", {
          method: "POST",
          body: JSON.stringify({
            url: url.trim(),
            quality,
          }),
        }),
      "Fetching source from YouTube",
    );
  }
  async function openProject(id: string, reveal = true) {
    const requestId = ++openRequestId.current;
    setProofUrl("");
    proofJobId.current = "";
    setRestoreAvailable(false);
    try {
      if (!(await flushQueuedSaves())) return;
      const loaded = await api<Project>(`/projects/${id}`);
      if (requestId !== openRequestId.current) return;
      if (project?.id !== loaded.id) {
        setSidebar("clips");
      }
      setProject(loaded);
      setShowSetup(!loaded.clips?.length);
      if (reveal) {
        setPage("editor");
        window.history.pushState(null, "", `#/editor/${loaded.id}`);
      }
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
  // Media edits remain drafts until Save settings; rendering never saves implicitly.
  async function flushQueuedSaves(saveDrafts = false): Promise<boolean> {
    if (Object.keys(debouncedSaves.current).length && !saveDrafts) {
      setNotice(
        "Save settings before leaving or rendering. Your edits are still here.",
      );
      return false;
    }
    const queued = Object.entries(debouncedSaves.current);
    await Promise.all(
      queued.map(([id, entry]) => flushDebouncedSave(id, entry)),
    );
    await Promise.allSettled([...pendingSaves.current]);
    if (Object.keys(debouncedSaves.current).length) return false;
    setSaveState("saved");
    setSaveError("");
    return true;
  }
  async function flushDebouncedSave(
    id: string,
    entry: {
      patch: Partial<Clip>;
      version: number;
      failed?: boolean;
      error?: string;
    },
  ) {
    if (debouncedSaves.current[id] !== entry) return;
    // Detach this snapshot so typing during a request cannot erase later edits.
    delete debouncedSaves.current[id];
    setSaveState("saving");
    try {
      const saved = await persistClip(id, entry.patch);
      if (saved && patchVersions.current[id] === entry.version)
        setClips((list) =>
          list.map((c) =>
            c.id === id
              ? {
                  ...saved,
                  selected: c.selected,
                  reviewed: c.reviewed,
                  suggestion_status: c.suggestion_status,
                }
              : c,
          ),
        );
      // Keep a visible retry state for any other clip whose patch failed.
      // A successful retry or an unrelated save must not hide that failure.
      if (!Object.values(debouncedSaves.current).some((item) => item.failed))
        setSaveError("");
    } catch (e) {
      const newer = debouncedSaves.current[id];
      entry.error =
        e instanceof Error ? e.message : "Could not save this edit.";
      debouncedSaves.current[id] = {
        patch: { ...entry.patch, ...newer?.patch },
        version: newer?.version ?? entry.version,
        failed: true,
        error: entry.error,
      };
      setSaveState("error");
      setSaveError(entry.error);
      setError(e instanceof Error ? e.message : "Could not save clip.");
    } finally {
      const remaining = Object.values(debouncedSaves.current);
      setSaveState(
        remaining.some((item) => item.failed)
          ? "error"
          : remaining.length
            ? "dirty"
            : pendingSaves.current.size
              ? "saving"
              : "saved",
      );
    }
  }
  function retryFailedSaves() {
    void flushQueuedSaves(true);
  }
  function queueClipSave(id: string, patch: Partial<Clip>, version: number) {
    setSaveState("dirty");
    if (!Object.values(debouncedSaves.current).some((entry) => entry.failed))
      setSaveError("");
    const existing = debouncedSaves.current[id];
    debouncedSaves.current[id] = {
      patch: { ...existing?.patch, ...patch },
      version,
    };
  }
  async function syncClips(next: Clip[]) {
    if (!project) return;
    proofJobId.current = "";
    setProofUrl("");
    for (const clip of next) {
      const version = (patchVersions.current[clip.id] || 0) + 1;
      patchVersions.current[clip.id] = version;
      queueClipSave(clip.id, clip, version);
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
      setSaveError(
        e instanceof Error ? e.message : "Could not save this edit.",
      );
      throw e;
    } finally {
      pendingSaves.current.delete(request);
      setSaveState((state) =>
        state === "saving" && pendingSaves.current.size === 0
          ? Object.keys(debouncedSaves.current).length
            ? "dirty"
            : "saved"
          : state,
      );
    }
  }
  async function updateLibraryClip(id: string, changes: LibraryPatch) {
    const current = clips.find((clip) => clip.id === id);
    if (!current) return;
    const patch = libraryPatch(changes);
    const previous = {
      selected: current.selected,
      reviewed: current.reviewed,
      suggestion_status: current.suggestion_status,
    };
    const version = (libraryVersions.current[id] || 0) + 1;
    libraryVersions.current[id] = version;
    setLibrarySaving((count) => count + 1);
    setClips((list) =>
      list.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip)),
    );
    try {
      const saved = await persistClip(id, patch);
      if (saved && libraryVersions.current[id] === version) {
        // Only merge library fields; a response must not overwrite unsaved media edits.
        setClips((list) =>
          list.map((clip) =>
            clip.id === id
              ? {
                  ...clip,
                  selected: saved.selected,
                  reviewed: saved.reviewed,
                  suggestion_status: saved.suggestion_status,
                }
              : clip,
          ),
        );
      }
    } catch (error) {
      if (libraryVersions.current[id] === version)
        setClips((list) =>
          list.map((clip) =>
            clip.id === id ? { ...clip, ...previous } : clip,
          ),
        );
      setError(
        error instanceof Error
          ? error.message
          : "Could not save this clip decision. Please try again.",
      );
    } finally {
      setLibrarySaving((count) => Math.max(0, count - 1));
    }
  }
  function patchClip(id: string, patch: Partial<Clip>) {
    const current = clips.find((clip) => clip.id === id);
    if (
      current &&
      Object.entries(patch).every(
        ([key, value]) => current[key as keyof Clip] === value,
      )
    )
      return;
    // Library selection and review are independent of media drafts.
    if (
      Object.keys(patch).every((key) =>
        ["selected", "reviewed", "suggestion_status"].includes(key),
      )
    ) {
      void updateLibraryClip(id, patch);
      return;
    }
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
    if (isBusy) return;
    try {
      if (!(await flushQueuedSaves())) return;
      const start = clamp(activeTime, 0, Math.max(0, duration - 0.1));
      const created = await api<Clip>(`/projects/${project.id}/clips`, {
        method: "POST",
        body: JSON.stringify({
          ...DEFAULT_CLIP,
          title: `Clip ${clips.length + 1}`,
          start,
          end: Math.min(duration, start + targetDuration),
        }),
      });
      setClips((c) => [...c, created]);
      proofJobId.current = "";
      setProofUrl("");
      setSelectedId(created.id);
      setSidebar("clips");
      setNotice(
        "Clip added at the playhead. Drag its timeline handles or set start and end with I and O.",
      );
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
      proofJobId.current = "";
      setProofUrl("");
      setSelectedId(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not duplicate clip.");
    }
  }
  async function workOnClip(clip: Clip) {
    if (!project) return;
    try {
      proofJobId.current = "";
      setProofUrl("");
      // The active editor clip is separate from the export selection. Choosing
      // a clip to work on must never silently deselect other export targets.
      setSelectedId(clip.id);
      setShowSetup(false);
      setWorkspaceMode("edit");
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
  async function generateConfiguredClips(settings: ClipSetupSettings) {
    if (!project || isBusy || analysisSubmitting) return;
    setAnalysisSubmitting(true);
    setError("");
    setNotice("");
    try {
      if (!(await flushQueuedSaves())) return;
      loadProjectOnDone.current = true;
      await startJob(
        await api<Job>(`/projects/${project.id}/generate`, {
          method: "POST",
          body: JSON.stringify(settings),
        }),
      );
      setNotice(
        "Generating clips with your camera, caption and audio settings.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start generation.");
    } finally {
      setAnalysisSubmitting(false);
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
      setSidebar("clips");
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
      setSidebar("clips");
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
      if (res.status === 401) {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      }
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

  async function navigatePage(next: TourPage) {
    if (!(await flushQueuedSaves())) return;
    if (next !== "editor") {
      videoRef.current?.pause();
      setExpandedPreview(false);
    }
    setPage(next);
    window.history.pushState(
      null,
      "",
      `#/${next}${next === "editor" && project ? "/" + project.id : ""}`,
    );
    if (next === "projects") void refreshProjects();
    if (next === "exports") void refreshJobs();
  }
  useEffect(() => {
    const changed = async () => {
      if (!(await flushQueuedSaves())) {
        window.history.replaceState(
          null,
          "",
          `#/${page}${page === "editor" && project ? "/" + project.id : ""}`,
        );
        return;
      }
      const next = routePage();
      if (next !== "editor") {
        videoRef.current?.pause();
        setExpandedPreview(false);
      }
      setPage(next);
      const id = window.location.hash.split("/")[2];
      if (next === "editor" && id && id !== project?.id)
        void openProject(id, false);
    };
    window.addEventListener("hashchange", changed);
    window.addEventListener("popstate", changed);
    return () => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("popstate", changed);
    };
  }, [project?.id, page]);
  async function updateProject(id: string, changes: ProjectChanges) {
    if (!(await flushQueuedSaves()))
      throw new Error("Save your current changes before updating a project.");
    const updated = await api<Project>(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    });
    setProjects((items) => items.map((p) => (p.id === id ? updated : p)));
    if (project?.id === id) {
      setProject(updated);
      if (updated.archived) {
        setProject(null);
        setClips([]);
        setSelectedId(null);
        localStorage.removeItem("clipflow-current-project");
      }
    }
    if (changes.archived !== undefined)
      setNotice(
        changes.archived
          ? "Project archived. Restore it from Archived."
          : "Project restored.",
      );
  }
  async function importSubtitles(file?: File) {
    if (!file || !project) return;
    try {
      if (file.size > 2_000_000)
        throw new Error("Subtitle files must be smaller than 2 MB.");
      setSubtitleDraft(parseSubtitles(await file.text(), duration));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read subtitles.");
    }
  }
  async function applySubtitles() {
    if (!project || !subtitleDraft || !(await flushQueuedSaves())) return;
    try {
      const updated = await api<Project>(
        `/projects/${project.id}/transcript/import`,
        { method: "POST", body: JSON.stringify({ segments: subtitleDraft }) },
      );
      setProject(updated);
      setClips(updated.clips);
      setSubtitleDraft(null);
      setProofUrl("");
      setHistory([]);
      setFuture([]);
      setSidebar("transcript");
      setNotice(
        "Source subtitles imported. Clip-specific corrections and manual overlays are preserved.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save subtitles.");
    }
  }

  return (
    <div
      className={`application-shell ${navCompact ? "navigation-collapsed" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
      }}

      onDrop={(e) => {
        e.preventDefault();

        importFile(e.dataTransfer.files[0]);
      }}
    >
      <WorkspaceNav
        page={page}
        onNavigate={navigatePage}
        onNew={() => {
          setError("");
          setNewProjectOpen(true);
        }}
        onTour={() => setTourReplay((n) => n + 1)}
        hasProject={!!project}
        projectTitle={project?.title}
        compact={navCompact}
        onCompact={() => setNavCompact((v) => !v)}
        activeJobs={
          jobs.filter((j) => ["running", "queued"].includes(j.status)).length
        }
      />
      <div className="workspace-route">
        {page === "projects" && (
          <ProjectsPage
            projects={projects.map((p) =>
              p.id === project?.id ? { ...p, clips } : p,
            )}
            jobs={jobs}
            currentId={project?.id}
            onOpen={openProject}
            onNew={() => {
              setError("");
              setNewProjectOpen(true);
            }}
            onDemo={loadDemo}
            onUpdate={updateProject}
            busy={isBusy || importSubmitting}
          />
        )}
        {page === "exports" && (
          <ExportsPage
            projects={projects}
            jobs={jobs}
            onOpen={openProject}
            onCancel={cancelJob}
            onRetry={retryJob}
            onRefresh={refreshJobs}
          />
        )}
        {page === "publish" && (
          <PublishPage
            api={api}
            projects={projects}
            currentId={project?.id}
            onOpen={openProject}
            onSettings={() => {
              setSettingsSection("publishing");
              navigatePage("settings");
            }}
            onNotice={setNotice}
          />
        )}
        {page === "settings" && (
          <SettingsPage
            initialTab={settingsSection}
            api={api}
            health={health}
            projects={projects}
            onTour={() => setTourReplay((n) => n + 1)}
            onNotice={setNotice}
            publishing={<PublishingSettings api={api} onNotice={setNotice} />}
            onPreviewsCleared={(id) => {
              if (id === project?.id) setProofUrl("");
            }}
          >
            <ProviderSettings
              api={api}
              open
              embedded
              onClose={() => undefined}
              onHealth={setHealth}
              onNotice={setNotice}
            />
          </SettingsPage>
        )}
        {page === "editor" && !project && (
          <main className="workspace-page">
            <header className="page-heading">
              <div>
                <h1>Open a project to edit</h1>
                <p>
                  Choose a source from your library or start with a new video.
                </p>
              </div>
            </header>
            <div className="workspace-empty">
              <Film size={42} />
              <h2>Your editing workspace</h2>
              <p>
                Clipping, captions, framing, and sound in one focused workspace.
              </p>
              <button
                className="primary-action"
                onClick={() => navigatePage("projects")}
              >
                <FolderOpen size={18} />
                Browse projects
              </button>
              <button
                className="text-action"
                onClick={() => setNewProjectOpen(true)}
              >
                Import a new video
              </button>
            </div>
          </main>
        )}
        <div
          className={`editor-route workspace-${workspaceMode}`}
          hidden={page !== "editor" || !project}
        >
          <header className="studio-header">
            <button
              className="icon-button back-projects"
              aria-label="Back to projects"
              onClick={() => navigatePage("projects")}
            >
              <ArrowLeft size={19} />
            </button>
            <div className="header-project">
              <span>Project</span>
              <strong title={project?.title}>{project?.title}</strong>
            </div>
            <div className="header-context">
              {" "}
              <span className={`save-status ${saveState}`} role="status">
                <span className="save-status-dot" />
                {saveState === "saving"
                  ? saveError
                    ? "Saving… · previous error"
                    : "Saving…"
                  : saveState === "error"
                    ? "Save failed"
                    : saveState === "dirty"
                      ? "Unsaved changes"
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
            <div className="header-actions">
              <div className="workspace-toggle" hidden={showSetup}>
                <button
                  className={workspaceMode === "edit" ? "active" : ""}
                  onClick={() => setWorkspaceMode("edit")}
                >
                  Edit
                </button>
                <button
                  className={workspaceMode === "review" ? "active" : ""}
                  onClick={() => setWorkspaceMode("review")}
                >
                  Review
                </button>
              </div>
              <button
                className="icon-button"
                aria-label="Undo"
                title="Undo"
                onClick={undo}
                disabled={!history.length}
              >
                <Undo2 size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Redo"
                title="Redo"
                onClick={redo}
                disabled={!future.length}
              >
                <Redo2 size={17} />
              </button>
              <button
                className="secondary-action"
                onClick={() => navigatePage("exports")}
              >
                <Download size={16} />
                Exports
              </button>
            </div>
          </header>
          <nav className="editor-journey" aria-label="Project workflow">
            <button
              aria-current={showSetup ? "step" : undefined}
              onClick={() => setShowSetup(true)}
            >
              Clip setup
            </button>
            <button
              disabled={!clips.length}
              aria-current={!showSetup ? "step" : undefined}
              onClick={() => setShowSetup(false)}
            >
              Edit clips ({clips.length})
            </button>
            <button onClick={() => navigatePage("exports")}>Exports</button>
            <button onClick={() => navigatePage("publish")}>Publish</button>
          </nav>
          {showSetup && project ? (
            <ClipSetup
              key={project.id}
              project={project}
              tourStep={tourSetupStep}
              busy={isBusy || analysisSubmitting}
              initialSettings={project.generation_settings}
              availableProviders={
                health.configuration?.highlights?.available_providers as
                  ClipSetupSettings["provider"][] | undefined
              }
              onGenerate={generateConfiguredClips}
              onReplaceSource={() => setNewProjectOpen(true)}
              onCancel={clips.length ? () => setShowSetup(false) : undefined}
            />
          ) : (
            <>
              <div className="workspace">
                <aside className="left-panel" aria-label="Editing tools">
                  <div className="inspector-tabs">
                    {(["clipping", "layout", "captions", "audio"] as const).map(
                      (tab) => (
                        <button
                          key={tab}
                          aria-pressed={inspector === tab}
                          className={inspector === tab ? "active" : ""}
                          data-tour={
                            tab === "captions" ? "editor-captions" : undefined
                          }
                          onClick={() => setInspector(tab)}
                        >
                          {tab === "clipping" ? (
                            <Scissors size={18} />
                          ) : tab === "layout" ? (
                            <Focus size={18} />
                          ) : tab === "captions" ? (
                            <MessageSquareText size={18} />
                          ) : (
                            <Activity size={18} />
                          )}
                          <span>
                            {tab === "clipping"
                              ? "Trim"
                              : tab === "layout"
                                ? "Layout"
                                : tab === "captions"
                                  ? "Captions"
                                  : "Audio"}
                          </span>
                        </button>
                      ),
                    )}
                  </div>
                  <div className="inspector-content" ref={inspectorContent}>
                    {project && !selected && (
                      <div className="editor-empty-state">
                        <Layers3 size={22} aria-hidden="true" />
                        <h3>Choose a clip to edit</h3>
                        <p>
                          Open the clip library on the right, then click a clip.
                          Checkboxes choose batch exports; they do not change
                          the clip you are editing.
                        </p>
                        <button
                          className="secondary-action"
                          type="button"
                          onClick={() => setSidebar("clips")}
                        >
                          Open clip library
                        </button>
                      </div>
                    )}
                    {project && selected && (
                      <>
                        <div
                          hidden={inspector !== "clipping"}
                          data-tour="editor-generation"
                        >
                          <div className="inspector-source">
                            <Film size={17} />
                            <span>{fmt(project.duration)} source</span>
                            <span>
                              {project.width} × {project.height}
                            </span>
                          </div>{" "}
                          <section className="settings-section clip-edit-controls">
                            <h3>
                              {selected
                                ? `Clip ${clips.findIndex((c) => c.id === selected.id) + 1}`
                                : "Choose a clip"}
                            </h3>
                            {selected && (
                              <>
                                <label>
                                  Clip name
                                  <input
                                    aria-label="Clip name"
                                    maxLength={150}
                                    data-tour="editor-clip-name"
                                    value={selected.title}
                                    onChange={(event) =>
                                      patchClip(selected.id, {
                                        title: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  Start in seconds
                                  <NumberSetting
                                    value={selected.start}
                                    min={0}
                                    max={selected.end - 0.1}
                                    step={0.1}
                                    onChange={(value) =>
                                      setSelectedRange("start", value)
                                    }
                                  />
                                </label>
                                <label>
                                  End in seconds
                                  <NumberSetting
                                    value={selected.end}
                                    min={selected.start + 0.1}
                                    max={duration}
                                    step={0.1}
                                    onChange={(value) =>
                                      setSelectedRange("end", value)
                                    }
                                  />
                                </label>
                                <p>Changes apply to this clip only.</p>
                                <button
                                  className="secondary-action"
                                  onClick={() =>
                                    selected && workOnClip(selected)
                                  }
                                >
                                  Fit this clip in the timeline
                                </button>
                              </>
                            )}
                          </section>
                          <section className="settings-section">
                            <button
                              className="primary-action"
                              disabled={isBusy}
                              onClick={() => setShowSetup(true)}
                            >
                              <Plus size={16} /> Generate more clips
                            </button>
                          </section>
                        </div>
                        <div hidden={inspector !== "layout"}>
                          {" "}
                          <section className="settings-section">
                            <div className="section-title">Framing</div>
                            <div className="select-row">
                              <button
                                disabled={!selected}
                                className={
                                  selected?.framing === "follow"
                                    ? "selected"
                                    : ""
                                }
                                onClick={() =>
                                  selected &&
                                  patchClip(selected.id, { framing: "follow" })
                                }
                              >
                                <Focus size={15} />
                                <span>Automatic tracking</span>
                              </button>
                              <button
                                disabled={!selected}
                                className={
                                  selected?.framing === "manual"
                                    ? "selected"
                                    : ""
                                }
                                onClick={() =>
                                  selected &&
                                  patchClip(selected.id, { framing: "manual" })
                                }
                              >
                                <AlignCenter size={15} />
                                <span>Manual camera</span>
                              </button>
                              <button
                                disabled={!selected}
                                className={
                                  selected?.framing === "fit" ? "selected" : ""
                                }
                                onClick={() =>
                                  selected &&
                                  patchClip(selected.id, { framing: "fit" })
                                }
                              >
                                <Maximize2 size={15} />
                                <span>Fit frame</span>
                              </button>
                              <button
                                disabled={!selected}
                                className={
                                  selected?.framing === "blur" ? "selected" : ""
                                }
                                onClick={() =>
                                  selected &&
                                  patchClip(selected.id, { framing: "blur" })
                                }
                              >
                                <Layers3 size={15} />
                                <span>Blur background</span>
                              </button>
                            </div>
                            <p className="framing-help">
                              {selected?.framing === "follow"
                                ? "Automatically follows faces or movement. Choose a movement preset below, then render a proof to review it."
                                : selected?.framing === "manual"
                                  ? "You place the camera. Set a fixed position, or add keyframes below to pan and zoom."
                                  : "Keeps the whole source visible. Automatic tracking and camera keyframes are not applied."}
                            </p>
                            {selected?.framing === "manual" &&
                              !selected.camera_keyframes?.length && (
                                <label className="range-control">
                                  <span>
                                    Focus{" "}
                                    <b>
                                      {Math.round(
                                        (selected.focus_x || 0.5) * 100,
                                      )}
                                      %
                                    </b>
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
                                      subject: e.target
                                        .value as Clip["subject"],
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
                          {selected &&
                            (selected.framing === "follow" ||
                              selected.framing === "manual") && (
                              <CameraControls
                                clip={selected}
                                activeTime={activeTime}
                                onPatch={(patch) =>
                                  patchClip(selected.id, patch)
                                }
                                onSeek={(time) => seek(time, true)}
                              />
                            )}
                        </div>
                        <div hidden={inspector !== "captions"}>
                          <section className="settings-section">
                            <div className="section-title">Transcription</div>{" "}
                            <TranscriptionControls
                              projectId={project.id}
                              clipId={selected?.id}
                              clipDuration={
                                selected ? selected.end - selected.start : 0
                              }
                              sourceDuration={duration}
                              busy={isBusy}
                              available={health.transcription !== false}
                              settingsOpen={settingsOpen}
                              hasTranscript={Boolean(
                                selected?.transcript?.length ||
                                project.transcript?.length,
                              )}
                              onTranscribe={async (options) =>
                                transcribe(options)
                              }
                              onOpenSettings={() => setSettingsOpen(true)}
                            />
                          </section>{" "}
                          <section className="settings-section caption-settings">
                            <div className="section-title">
                              <span>Captions</span>
                              <button
                                className="text-button"
                                onClick={() =>
                                  selected && downloadSrt(selected.id)
                                }
                              >
                                <Download size={12} /> SRT
                              </button>
                            </div>
                            <textarea
                              disabled={!selected}
                              value={selected?.caption_text || ""}
                              onChange={(e) =>
                                selected &&
                                patchClip(selected.id, {
                                  caption_text: e.target.value,
                                })
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
                                    caption_style: e.target
                                      .value as Clip["caption_style"],
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
                                  patchClip(selected.id, {
                                    caption_color: e.target.value,
                                  })
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
                                y={
                                  selected.caption_y ??
                                  (selected.caption_position === "center"
                                    ? 0.5
                                    : 0.86)
                                }
                                disabled={isBusy}
                                onChange={(patch) =>
                                  patchClip(selected.id, patch)
                                }
                              />
                            )}
                            {selected && (
                              <CaptionPresets
                                clip={selected}
                                disabled={isBusy}
                                onApply={(values) =>
                                  patchClip(selected.id, values)
                                }
                                onApplyAll={(values) =>
                                  clips.forEach((c) => patchClip(c.id, values))
                                }
                              />
                            )}
                            <div className="subtitle-import-row">
                              <label className="secondary-action">
                                Import SRT / VTT
                                <input
                                  type="file"
                                  hidden
                                  accept=".srt,.vtt,text/plain,text/vtt"
                                  disabled={isBusy}
                                  onChange={(event) => {
                                    const file = event.target.files?.[0];
                                    event.target.value = "";
                                    void importSubtitles(file);
                                  }}
                                />
                              </label>
                              <small>
                                Uses source-video timestamps. Replaces the
                                source transcript after confirmation.
                              </small>
                            </div>
                            <div className="brand-actions">
                              <button
                                className="brand-save"
                                onClick={() => {
                                  const color =
                                    selected?.caption_color || brandColor;
                                  localStorage.setItem(
                                    "clipflow-brand-color",
                                    color,
                                  );
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
                                    patchClip(selected.id, {
                                      caption_color: color,
                                    });
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
                                    patchClip(selected.id, {
                                      caption_color: "#b8a7ff",
                                    });
                                  localStorage.removeItem(
                                    "clipflow-brand-color",
                                  );
                                  setNotice("Brand color reset");
                                }}
                              >
                                Reset
                              </button>
                            </div>
                          </section>
                        </div>
                        <div hidden={inspector !== "audio"}>
                          {" "}
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
                        </div>
                      </>
                    )}
                  </div>
                </aside>
                <main className="canvas-area">
                  <div className="canvas-toolbar">
                    <div className="crumb">
                      <Clapperboard size={16} />
                      <span>{project ? "Edit" : "New project"}</span>
                    </div>
                    {!selected && (
                      <span className="source-dimensions">
                        {project?.width} × {project?.height} source
                      </span>
                    )}
                    <div className="canvas-tools" hidden={!selected}>
                      <select
                        className="tool-button"
                        aria-label="Output aspect ratio"
                        value={selected?.aspect_ratio || "9:16"}
                        disabled={!selected || isBusy}
                        onChange={(e) =>
                          selected &&
                          patchClip(selected.id, {
                            aspect_ratio: e.target
                              .value as Clip["aspect_ratio"],
                          })
                        }
                      >
                        <option value="9:16">9:16 Vertical</option>
                        <option value="1:1">1:1 Square</option>
                        <option value="4:5">4:5 Portrait</option>
                        <option value="16:9">16:9 Wide</option>
                      </select>
                      <select
                        className="tool-button"
                        aria-label="Export resolution"
                        value={selected?.resolution || 720}
                        disabled={!selected}
                        onChange={(e) =>
                          selected &&
                          patchClip(selected.id, {
                            resolution: Number(e.target.value),
                          })
                        }
                      >
                        {[360, 720, 1080].map((width) => {
                          const [w, h] = (selected?.aspect_ratio || "9:16")
                            .split(":")
                            .map(Number);
                          return (
                            <option key={width} value={width}>
                              {width} ×{" "}
                              {Math.round((width * h) / w / 2) * 2}
                            </option>
                          );
                        })}
                      </select>
                      <button
                        data-tour="editor-save"
                        className="primary-action"
                        disabled={
                          saveState !== "dirty" && saveState !== "error"
                        }
                        onClick={() =>
                          void flushQueuedSaves(true).then(
                            (ok) =>
                              ok &&
                              setNotice(
                                "Settings saved. Render a preview to see the result.",
                              ),
                          )
                        }
                      >
                        <Save size={15} /> Save settings
                      </button>
                      <button
                        data-tour="editor-render"
                        className="tool-button"
                        disabled={
                          !selected ||
                          isBusy ||
                          saveState !== "saved" ||
                          !!proofUrl
                        }
                        title={
                          saveState !== "saved"
                            ? "Save settings first"
                            : proofUrl
                              ? "Preview is up to date"
                              : "Render the saved clip"
                        }
                        onClick={renderProof}
                      >
                        Render preview
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
                  <div className="preview-stage" data-tour="editor-preview">
                    <div className="current-clip-strip">
                      <div>
                        <span className="current-clip-kicker">Editing</span>
                        <strong>
                          {selected?.title ||
                            "Source preview · choose a clipping method"}
                        </strong>
                        {selected && (
                          <small>
                            {fmt(selected.start)}–{fmt(selected.end)}{" "}
                            · {fmt(selected.end - selected.start)} source
                          </small>
                        )}
                      </div>
                      <button
                        className="tool-button current-export"
                        data-tour="editor-export"
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
                      renderDisabled={isBusy || saveState !== "saved"}
                      onUseSource={() => {
                        proofJobId.current = "";
                        pendingSourceSeek.current = clamp(
                          activeTime,
                          0,
                          duration,
                        );
                        setProofUrl("");
                      }}
                      onExpand={() => setExpandedPreview((value) => !value)}
                    />
                  </div>
                  <div data-tour="editor-timeline">
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
                            (duration /
                              Math.max(selected.end - selected.start, 1)) *
                              0.8,
                            1,
                            256,
                          ),
                        )
                      }
                    />
                  </div>
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
                <aside
                  className="right-panel"
                  data-tour={
                    sidebar === "transcript" ? "editor-transcript" : undefined
                  }
                >
                  <div className="right-tabs">
                    {(
                      [
                        "clips",
                        "transcript",
                        ...(brollAvailable ? (["connections"] as const) : []),
                      ] as const
                    ).map((tab) => (
                        <button
                          key={tab}
                          className={sidebar === tab ? "active" : ""}
                          onClick={() => setSidebar(tab)}
                        >
                          {tab === "clips" ? (
                            <Layers3 size={15} />
                          ) : tab === "transcript" ? (
                            <MessageSquareText size={15} />
                          ) : (
                            <Link2 size={15} />
                          )}
                          <span>
                            {tab === "connections"
                              ? "B-roll"
                              : tab === "clips"
                                ? "Clips"
                                : "Transcript"}
                          </span>
                          {tab === "clips" && clips.length > 0 && (
                            <b>{clips.length}</b>
                          )}
                        </button>
                      ))}
                  </div>
                  <p className="right-panel-guide">
                    {sidebar === "clips"
                      ? "Click a clip to edit it. Checkboxes choose clips for batch export."
                      : sidebar === "transcript"
                        ? selected?.transcript
                          ? `Editing the transcript for ${selected.title}. Click any line to seek.`
                          : "Showing the source transcript. Select consecutive lines to create a clip."
                        : "Generate an optional insert as a separate project."}
                  </p>
                  {sidebar === "clips" && (
                    <ClipLibrary
                      key={project?.id}
                      clips={clips}
                      activeId={selectedId}
                      busy={isBusy}
                      saving={librarySaving > 0}
                      canRestore={restoreAvailable}
                      onEdit={workOnClip}
                      onPatch={(id, patch) => {
                        void updateLibraryClip(id, patch);
                      }}
                      onDuplicate={duplicateClip}
                      onRemove={bulkDelete}
                      onRestore={restoreLastBatch}
                      onAdd={addClip}
                      onGenerate={() => setShowSetup(true)}
                      onExport={exportClips}
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
                              clip_id: selected?.transcript
                                ? selected.id
                                : undefined,
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
                      onTranscribe={() => {
                        void transcribe();
                      }}
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
            </>
          )}
        </div>
      </div>
      <GuidedTour
        page={page}
        onNavigate={navigatePage}
        onReveal={(target) => {
          if (target === "editor-generation" || target.startsWith("setup-")) {
            setShowSetup(true);
            setTourSetupStep(
              (target === "editor-generation" ? "source" : target.slice(6)) as
                "source" | "moments" | "camera" | "captions" | "review",
            );
          } else if (target.startsWith("editor-")) {
            setShowSetup(false);
            setTourSetupStep(undefined);
          }
          if (target === "editor-captions") setInspector("captions");
          if (target === "editor-clip-name" || target === "editor-timeline")
            setInspector("clipping");
          if (target === "editor-transcript") setSidebar("transcript");
          if (
            ["editor-library", "editor-selection", "editor-review"].includes(
              target,
            )
          )
            setSidebar("clips");
        }}
        hasClips={clips.length > 0}
        onClose={() => setTourSetupStep(undefined)}
        hasProject={!!project}
        replayToken={tourReplay}
      />
      {subtitleDraft && (
        <div className="workspace-modal-backdrop">
          <section
            className="workspace-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Import subtitles"
          >
            <h2>Import {subtitleDraft.length} subtitle passages?</h2>
            <p>
              This replaces the source transcript. Existing clip-specific
              corrections and manual caption text stay unchanged.
            </p>
            <footer>
              <button
                className="secondary-action"
                onClick={() => setSubtitleDraft(null)}
              >
                Cancel
              </button>
              <button className="primary-action" onClick={applySubtitles}>
                Import subtitles
              </button>
            </footer>
          </section>
        </div>
      )}
      {(job?.status === "queued" || job?.status === "running") && (
        <div className="job-toast">
          <LoaderCircle className="spin" size={16} />
          <div>
            <strong>{job.stage || "Working locally"}</strong>
            <span>
              {Math.round(job.progress || 0)}% · you can keep editing
            </span>
            {job.warning && (
              <small className="job-warning">{job.warning}</small>
            )}
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
      {restoreAvailable && page === "editor" && (
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
          onInspect={(sourceUrl, signal) =>
            api("/sources/youtube/inspect", {
              method: "POST",
              signal,
              body: JSON.stringify({ url: sourceUrl }),
            })
          }
          busy={isBusy || importSubmitting}
          uploading={importSubmitting}
          onClose={() => setNewProjectOpen(false)}
          error={error}
        />
      )}
    </div>
  );
}

function NumberSetting({
  value,
  min,
  max,
  disabled,
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const next =
      draft.trim() && Number.isFinite(Number(draft))
        ? clamp(Math.round(Number(draft) / step) * step, min, max)
        : value;
    setDraft(String(next));
    onChange(next);
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
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
