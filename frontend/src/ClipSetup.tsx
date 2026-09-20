import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Captions,
  Check,
  Film,
  Focus,
  LoaderCircle,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  Volume2,
} from "lucide-react";
import type { AnalysisOptions, Project } from "./editorTypes";
import "./ClipSetup.css";

/** The range shape sent to the atomic generation endpoint. Times are source seconds. */
export type ClipSetupRange = { start: number; end: number };

/**
 * The complete, reviewable setup payload. Keep this snake_case schema in sync
 * with POST /api/projects/{project_id}/generate.
 */
export type ClipSetupSettings = {
  automatic?: boolean;
  mode: "smart" | "full" | "manual";
  target_duration: number;
  tolerance: number;
  max_clips: number;
  topic: string;
  use_transcript: boolean;
  provider: AnalysisOptions["provider"];
  ranges: ClipSetupRange[];
  camera: {
    framing: "follow" | "manual" | "fit";
    camera_strategy: "adaptive" | "follow" | "manual";
    safe_framing: "fit" | "blur";
    vision_provider: "local" | "gemini";
    camera_motion: "steady" | "smooth" | "dynamic";
    camera_auto_zoom: boolean;
    camera_zoom: number;
    camera_dead_zone: number;
    focus_x: number;
    subject: "auto" | "left" | "right";
    aspect_ratio: "9:16" | "1:1" | "4:5" | "16:9";
    resolution: number;
  };
  captions: {
    mode: "none" | "auto" | "manual";
    text: string;
    style: "clean" | "bold" | "minimal";
    color: string;
    x: number;
    y: number;
    language: string;
    quality: "auto" | "fast" | "balanced" | "accurate";
    dialect: "none" | "algerian";
    font: "outfit" | "anton" | "noto-arabic";
    size: number;
  };
  audio: { volume: number; denoise: boolean; fade: number };
};

export type ClipSetupProps = {
  project: Project;
  busy?: boolean;
  initialSettings?: Partial<ClipSetupSettings>;
  availableProviders?: AnalysisOptions["provider"][];
  sourcePreview?: ReactNode;
  onGenerate: (settings: ClipSetupSettings) => void | Promise<void>;
  onCancel?: () => void;
  onReplaceSource?: () => void;
};

type Step = "source" | "moments" | "camera" | "captions" | "review";
const steps: { id: Step; label: string; icon: typeof Film }[] = [
  { id: "source", label: "Source", icon: Film },
  { id: "moments", label: "Moments", icon: Scissors },
  { id: "camera", label: "Camera", icon: Camera },
  { id: "captions", label: "Captions", icon: Captions },
  { id: "review", label: "Review", icon: Check },
];

const defaultSettings: ClipSetupSettings = {
  mode: "smart",
  target_duration: 30,
  tolerance: 0.3,
  max_clips: 5,
  topic: "",
  use_transcript: false,
  provider: "local",
  ranges: [],
  camera: {
    framing: "follow",
    camera_strategy: "adaptive",
    safe_framing: "fit",
    vision_provider: "local",
    camera_motion: "smooth",
    camera_auto_zoom: false,
    camera_zoom: 1,
    camera_dead_zone: 0.08,
    focus_x: 0.5,
    subject: "auto",
    aspect_ratio: "9:16",
    resolution: 720,
  },
  captions: {
    mode: "none",
    text: "",
    style: "clean",
    color: "#ffffff",
    x: 0.5,
    y: 0.86,
    language: "auto",
    quality: "balanced",
    dialect: "none",
    font: "outfit",
    size: 52,
  },
  audio: { volume: 1, denoise: false, fade: 0 },
};

function mergeSettings(initial?: Partial<ClipSetupSettings>): ClipSetupSettings {
  return {
    ...defaultSettings,
    ...initial,
    camera: { ...defaultSettings.camera, ...(initial?.camera || {}) },
    captions: { ...defaultSettings.captions, ...(initial?.captions || {}) },
    audio: { ...defaultSettings.audio, ...(initial?.audio || {}) },
    ranges: initial?.ranges?.map((range) => ({ ...range })) || [],
  };
}

type StoredSetupDraft = {
  settings?: Partial<ClipSetupSettings>;
  step?: Step;
  rangeStart?: string;
  rangeEnd?: string;
};

function draftKey(projectId: string) {
  return `clipflow-setup-draft-${projectId}`;
}

function readDraft(projectId: string, duration: number, initial?: Partial<ClipSetupSettings>) {
  try {
    const raw =
      sessionStorage.getItem(draftKey(projectId)) ||
      localStorage.getItem(draftKey(projectId));
    if (raw) {
      const stored = JSON.parse(raw) as StoredSetupDraft;
      return {
        settings: mergeSettings(stored.settings),
        step:
          stored.step && steps.some((item) => item.id === stored.step)
            ? stored.step
            : ("source" as Step),
        rangeStart: stored.rangeStart ?? "0",
        rangeEnd: stored.rangeEnd ?? String(Math.min(30, Math.max(1, Math.round(duration)))),
      };
    }
  } catch {
    // A private window or blocked storage should not prevent setup.
  }
  return {
    settings: mergeSettings(initial),
    step: "source" as Step,
    rangeStart: "0",
    rangeEnd: String(Math.min(30, Math.max(1, Math.round(duration)))),
  };
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

function formatDimensions(project: Project) {
  if (!project.width || !project.height) return "Source video";
  return `${project.width} × ${project.height}`;
}

function OptionCard({
  checked,
  title,
  detail,
  icon,
  onClick,
  children,
}: {
  checked: boolean;
  title: string;
  detail: string;
  icon: ReactNode;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      className={`clip-setup-option ${checked ? "is-selected" : ""}`}
      type="button"
      aria-pressed={checked}
      onClick={onClick}
    >
      <span className="clip-setup-option-icon">{icon}</span>
      <span className="clip-setup-option-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
        {children}
      </span>
      <span className="clip-setup-option-check" aria-hidden="true">
        {checked && <Check size={15} />}
      </span>
    </button>
  );
}

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="clip-setup-field-label">
      <span>{children}</span>
      {hint && <small>{hint}</small>}
    </span>
  );
}

export default function ClipSetup({
  project,
  busy = false,
  initialSettings,
  availableProviders,
  sourcePreview,
  onGenerate,
  onCancel,
  onReplaceSource,
}: ClipSetupProps) {
  const [draft] = useState(() => readDraft(project.id, project.duration, initialSettings));
  const [step, setStep] = useState<Step>(draft.step);
  const [settings, setSettings] = useState<ClipSetupSettings>(draft.settings);
  const [rangeStart, setRangeStart] = useState(draft.rangeStart ?? "0");
  const [rangeEnd, setRangeEnd] = useState(draft.rangeEnd ?? String(Math.min(30, Math.max(1, Math.round(project.duration)))));
  const [error, setError] = useState("");
  const [readiness, setReadiness] = useState<{source_ready: boolean; message?: string; speech?: {ready: boolean; provider: string; selected_model?: string; cached_models?: string[]; warning?: string}}>();
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/projects/${project.id}/readiness`, {signal: controller.signal})
      .then(async (response) => { if (!response.ok) throw new Error("Could not check this source. Reload the project."); return response.json(); })
      .then(setReadiness).catch((error) => { if (error.name !== "AbortError") setError(error.message); });
    return () => controller.abort();
  }, [project.id]);
  const sourceVideo = useRef<HTMLVideoElement>(null);
  const [previewTime, setPreviewTime] = useState(0);

  useEffect(() => {
    const value = JSON.stringify({ settings, step, rangeStart, rangeEnd } satisfies StoredSetupDraft);
    try {
      sessionStorage.setItem(draftKey(project.id), value);
      localStorage.setItem(draftKey(project.id), value);
    } catch {
      // Setup remains usable when storage is unavailable or full.
    }
  }, [project.id, settings, step, rangeStart, rangeEnd]);

  const stepIndex = steps.findIndex((item) => item.id === step);
  const update = <K extends keyof ClipSetupSettings>(
    key: K,
    value: ClipSetupSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));
  const updateCamera = <K extends keyof ClipSetupSettings["camera"]>(
    key: K,
    value: ClipSetupSettings["camera"][K],
  ) =>
    setSettings((current) => ({
      ...current,
      camera: { ...current.camera, [key]: value },
    }));
  const updateCaptions = <K extends keyof ClipSetupSettings["captions"]>(
    key: K,
    value: ClipSetupSettings["captions"][K],
  ) =>
    setSettings((current) => ({
      ...current,
      captions: { ...current.captions, [key]: value },
    }));
  const updateAudio = <K extends keyof ClipSetupSettings["audio"]>(
    key: K,
    value: ClipSetupSettings["audio"][K],
  ) =>
    setSettings((current) => ({
      ...current,
      audio: { ...current.audio, [key]: value },
    }));

  const addRange = () => {
    const start = Number(rangeStart);
    const end = Number(rangeEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      setError("Enter a start and end time for this moment.");
      return;
    }
    if (start < 0 || end > project.duration || end <= start) {
      setError(
        `Each range must be inside the source and longer than zero seconds (0–${formatDuration(project.duration)}).`,
      );
      return;
    }
    setError("");
    update("ranges", [...settings.ranges, { start, end }].sort((a, b) => a.start - b.start));
    setRangeStart(String(Math.min(end, Math.max(0, project.duration - 1))));
    setRangeEnd(String(Math.min(project.duration, end + 30)));
  };
  const removeRange = (index: number) =>
    update("ranges", settings.ranges.filter((_, itemIndex) => itemIndex !== index));

  const markRange = (which: "start" | "end") => {
    const value = previewTime.toFixed(1);
    setError("");
    if (which === "start") setRangeStart(value);
    else setRangeEnd(value);
  };

  const providerOptions = availableProviders?.length
    ? availableProviders
    : (["local"] as AnalysisOptions["provider"][]);
  const providerAvailable = providerOptions.includes(settings.provider);

  const validateNumbers = () => {
    const camera = settings.camera;
    const captions = settings.captions;
    const audio = settings.audio;
    const finite = (value: number) => Number.isFinite(value);
    if (
      !finite(settings.target_duration) ||
      settings.target_duration < 5 ||
      settings.target_duration > 300 ||
      !Number.isInteger(settings.max_clips) ||
      settings.max_clips < 1 ||
      settings.max_clips > 20
    ) {
      setError("Clip length must be 5–300 seconds and maximum clips must be 1–20.");
      return false;
    }
    if (!finite(settings.tolerance) || settings.tolerance < .1 || settings.tolerance > .5) {
      setError("The clip tolerance must be between 10% and 50%.");
      return false;
    }
    if (
      !finite(camera.camera_zoom) || camera.camera_zoom < 1 || camera.camera_zoom > 1.5 ||
      !finite(camera.camera_dead_zone) || camera.camera_dead_zone < 0 || camera.camera_dead_zone > 0.3 ||
      !finite(camera.focus_x) || camera.focus_x < 0 || camera.focus_x > 1 ||
      ![720, 1080].includes(camera.resolution) ||
      !["adaptive", "follow", "manual"].includes(camera.camera_strategy) ||
      !["fit", "blur"].includes(camera.safe_framing) ||
      !["local", "gemini"].includes(camera.vision_provider)
    ) {
      setError("Check the camera zoom, tracking room, and output resolution.");
      return false;
    }
    if (
      !finite(captions.x) || captions.x < .05 || captions.x > .95 ||
      !finite(captions.y) || captions.y < .05 || captions.y > .95 ||
      !/^#[0-9a-fA-F]{6}$/.test(captions.color) ||
      !["outfit", "anton", "noto-arabic"].includes(captions.font) ||
      !Number.isFinite(captions.size) || captions.size < 32 || captions.size > 90
    ) {
      setError("Check the caption position and color.");
      return false;
    }
    if (
      !finite(audio.volume) || audio.volume < 0 || audio.volume > 1 ||
      !finite(audio.fade) || audio.fade < 0 || audio.fade > 2
    ) {
      setError("Check the audio volume and fade values.");
      return false;
    }
    if (
      settings.ranges.some(
        (range) =>
          !finite(range.start) ||
          !finite(range.end) ||
          range.start < 0 ||
          range.end > project.duration ||
          range.end <= range.start,
      )
    ) {
      setError("Each selected moment must be inside the source and longer than zero seconds.");
      return false;
    }
    return true;
  };

  const validateStep = (currentStep: Step) => {
    if (currentStep === "source") return true;
    if (!validateNumbers()) return false;
    if (currentStep === "moments" && settings.mode === "smart" && !providerAvailable) {
      setError("Choose an available ranking provider, or configure it in Settings.");
      return false;
    }
    if (currentStep === "moments" && settings.mode === "manual" && settings.ranges.length === 0) {
      setError("Add at least one moment before continuing.");
      return false;
    }
    if (
      currentStep === "captions" &&
      settings.captions.mode === "manual" &&
      !settings.captions.text.trim()
    ) {
      setError("Add caption text or choose Auto captions / No captions.");
      return false;
    }
    setError("");
    return true;
  };
  const goNext = () => {
    if (!validateStep(step)) return;
    setStep(steps[Math.min(steps.length - 1, stepIndex + 1)].id);
  };
  const goBack = () => {
    setError("");
    if (stepIndex === 0) onCancel?.();
    else setStep(steps[stepIndex - 1].id);
  };
  const generate = async () => {
    if (!validateStep("moments") || !validateStep("captions")) return;
    setError("");
    await onGenerate(settings);
  };

  const chooseAutomaticSetup = async () => {
    const automatic: ClipSetupSettings = {
      ...settings,
      automatic: true,
      mode: "smart",
      provider: "local",
      use_transcript: true,
      camera: { ...settings.camera, framing: "follow", camera_strategy: "adaptive", safe_framing: "fit", vision_provider: "local", camera_motion: "smooth" },
      captions: { ...settings.captions, mode: "auto", quality: "auto" },
    };
    setSettings(automatic);
    setError("");
    await onGenerate(automatic);
  };

  const sourceMeta = useMemo(
    () => [formatDuration(project.duration), formatDimensions(project), `${project.fps || 0} fps`],
    [project.duration, project.fps, project.height, project.width],
  );
  return (
    <main className="clip-setup" aria-labelledby="clip-setup-title" data-tour="editor-generation">
      <div className="clip-setup-layout">
        <aside className="clip-setup-rail" aria-label="Setup steps">
          <div className="clip-setup-rail-intro">
            <h1 id="clip-setup-title">Set up clips</h1>
            <p>Choose moments, camera and captions before generating.</p>
          </div>
          <nav className="clip-setup-steps">
            {steps.map(({ id, label, icon: Icon }, index) => {
              const complete = index < stepIndex;
              return (
                <button
                  type="button"
                  key={id}
                  className={`clip-setup-step ${step === id ? "is-current" : ""} ${complete ? "is-complete" : ""}`}
                  onClick={() => {
                    if (index <= stepIndex) {
                      setError("");
                      setStep(id);
                    }
                  }}
                  disabled={index > stepIndex}
                  aria-current={step === id ? "step" : undefined}
                >
                  <span className="clip-setup-step-number">
                    {complete ? <Check size={14} /> : index + 1}
                  </span>
                  <span>{label}</span>
                  <Icon size={16} aria-hidden="true" />
                </button>
              );
            })}
          </nav>
          <div className="clip-setup-rail-foot">
            <Focus size={16} />
            <span>Your settings stay editable on every generated clip.</span>
          </div>
        </aside>

        <section className="clip-setup-stage">
          <div className="clip-setup-stage-heading">
            <div>
              <h2>
                {step === "source" && "Review your source"}
                {step === "moments" && "Which moments should become clips?"}
                {step === "camera" && "Set the framing."}
                {step === "captions" && "Set up captions"}
                {step === "review" && "Review and generate"}
              </h2>
            </div>
          </div>

          {step === "source" && (
            <div className="clip-setup-source-grid" data-tour="setup-source">
              <div className="clip-setup-preview" aria-label="Source preview">
                {sourcePreview ? (
                  sourcePreview
                ) : project.source_url ? (
                  <video
                    ref={sourceVideo}
                    src={project.source_url}
                    controls
                    preload="metadata"
                    onTimeUpdate={(event) => setPreviewTime(event.currentTarget.currentTime)}
                    aria-label="Source video preview"
                  />
                ) : project.thumbnail_url ? (
                  <img src={project.thumbnail_url} alt="Source thumbnail" />
                ) : (
                  <div className="clip-setup-preview-empty"><Film size={27} /><span>Preview will appear here</span></div>
                )}
                <span className="clip-setup-preview-duration">{formatDuration(project.duration)}</span>
              </div>
              <div className="clip-setup-source-copy">
                <h3>{project.title || "Untitled source"}</h3>
                <p>Clipflow will create a new set of editable clips from this source.</p>
                {readiness?.source_ready === false && <div className="source-recovery" role="alert"><p>{readiness.message}</p><button type="button" onClick={onReplaceSource}>Import source again</button></div>}
                <button className="clip-setup-automatic" type="button" disabled={busy || !readiness?.source_ready || readiness.speech?.ready === false} onClick={chooseAutomaticSetup}>
                  <Sparkles size={16} /> Create clips automatically
                </button>
                <small className="clip-setup-automatic-note">Find moments, preserve the subject, and add captions using your speech settings. Starts analysis now; review and render the resulting clips yourself.</small>
                {readiness?.speech && <p className="processing-readiness" role="status">{readiness.speech.ready ? `Speech: ${readiness.speech.selected_model || readiness.speech.provider}.` : "Speech needs more free disk space or a configured provider. Use manual moments without captions, or change speech settings."} {readiness.speech.warning}{readiness.speech.selected_model && !readiness.speech.cached_models?.includes(readiness.speech.selected_model) ? " A free model will download before the first run." : ""}</p>}
                <dl className="clip-setup-source-meta">
                  {sourceMeta.map((item, index) => <div key={item}><dt>{["Length", "Frame", "Rate"][index]}</dt><dd>{item}</dd></div>)}
                </dl>
              </div>
            </div>
          )}

          {step === "moments" && (
            <div className="clip-setup-form" data-tour="setup-moments">
              <div className="clip-setup-options clip-setup-options-wide">
                <OptionCard checked={settings.mode === "smart"} title="Smart highlights" detail="Find clear moments around scene changes and natural pauses." icon={<Sparkles size={19} />} onClick={() => update("mode", "smart")} />
                <OptionCard checked={settings.mode === "full"} title="Split the whole source" detail="Make a clean sequence of clips at the length you choose." icon={<Scissors size={19} />} onClick={() => update("mode", "full")} />
                <OptionCard checked={settings.mode === "manual"} title="Choose moments myself" detail="Add exact ranges when timing matters more than discovery." icon={<Focus size={19} />} onClick={() => update("mode", "manual")} />
              </div>
              {settings.mode !== "manual" ? (
                <div className="clip-setup-subgrid">
                  <label className="clip-setup-field"><FieldLabel hint="5–300 seconds">Clip length</FieldLabel><div className="clip-setup-number"><input type="number" min={5} max={300} value={settings.target_duration} onChange={(event) => update("target_duration", Math.max(5, Math.min(300, Number(event.target.value) || 5)))} /><span>sec</span></div></label>
                  <label className="clip-setup-field"><FieldLabel hint="1–20 clips">Maximum clips</FieldLabel><input type="number" min={1} max={20} value={settings.max_clips} onChange={(event) => update("max_clips", Math.max(1, Math.min(20, Number(event.target.value) || 1)))} /></label>
                  <label className="clip-setup-field clip-setup-field-wide"><FieldLabel hint="Optional">What should we look for?</FieldLabel><input type="text" maxLength={500} value={settings.topic} onChange={(event) => setSettings((current) => ({ ...current, topic: event.target.value, use_transcript: event.target.value.trim() ? true : current.use_transcript }))} placeholder="e.g. the clearest explanation" /><small className="clip-setup-inline-note">A topic automatically turns on speech analysis so Clipflow can find the right words.</small></label>
                </div>
              ) : (
                <div className="clip-setup-manual-ranges">
                  <div className="clip-setup-manual-source">
                    {project.source_url ? <video src={project.source_url} controls preload="metadata" onTimeUpdate={(event) => setPreviewTime(event.currentTarget.currentTime)} aria-label="Source video for marking moments" /> : project.thumbnail_url ? <img src={project.thumbnail_url} alt="Source thumbnail" /> : <div className="clip-setup-preview-empty"><Film size={22} /><span>Source preview unavailable</span></div>}
                    <div className="clip-setup-manual-source-controls">
                      <span>At {formatDuration(previewTime)}</span>
                      <button type="button" onClick={() => markRange("start")}>Mark start</button>
                      <button type="button" onClick={() => markRange("end")}>Mark end</button>
                    </div>
                  </div>
                  <p className="clip-setup-range-pending" role="status">Pending moment: <strong>{formatDuration(Number(rangeStart) || 0)} – {formatDuration(Number(rangeEnd) || 0)}</strong>. Mark both points, then add the moment.</p>
                  <div className="clip-setup-range-entry">
                    <label className="clip-setup-field"><FieldLabel>Start</FieldLabel><div className="clip-setup-number"><input type="number" min={0} max={project.duration} step="0.1" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /><span>sec</span></div></label>
                    <label className="clip-setup-field"><FieldLabel>End</FieldLabel><div className="clip-setup-number"><input type="number" min={0} max={project.duration} step="0.1" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /><span>sec</span></div></label>
                    <button className="clip-setup-add-range" type="button" onClick={addRange}><Plus size={16} /> Add moment</button>
                  </div>
                  {settings.ranges.length > 0 ? <ol className="clip-setup-ranges">{settings.ranges.map((range, index) => <li key={`${range.start}-${range.end}`}><span>Moment {index + 1}</span><strong>{formatDuration(range.start)} – {formatDuration(range.end)}</strong><button type="button" aria-label={`Remove moment ${index + 1}`} onClick={() => removeRange(index)}><Trash2 size={15} /></button></li>)}</ol> : <p className="clip-setup-empty-note">Add a range from the source timeline. Each range becomes one editable clip.</p>}
                </div>
              )}
              {settings.mode !== "manual" && <label className="clip-setup-checkline"><input type="checkbox" checked={settings.use_transcript || Boolean(settings.topic.trim())} disabled={Boolean(settings.topic.trim())} onChange={(event) => setSettings((current) => ({ ...current, use_transcript: event.target.checked }))} /><span><strong>Use speech when ranking</strong><small>{settings.topic.trim() ? "On because you added a topic. Transcription runs when you generate." : "Optional. Turn it on when spoken words should guide the highlights."}</small></span></label>}
              {settings.use_transcript && settings.mode !== "manual" && <>
                <label className="clip-setup-field clip-setup-provider"><FieldLabel hint={!providerAvailable ? "Unavailable saved provider" : undefined}>Speech provider</FieldLabel><select value={settings.provider} onChange={(event) => update("provider", event.target.value as AnalysisOptions["provider"])}>{!providerAvailable && <option value={settings.provider}>{settings.provider} (unavailable)</option>}{providerOptions.map((provider) => <option key={provider} value={provider}>{provider === "local" ? "On this computer" : provider[0].toUpperCase() + provider.slice(1)}</option>)}</select></label>
                <div className="clip-setup-subgrid clip-setup-speech-options"><label className="clip-setup-field"><FieldLabel>Speech language</FieldLabel><select value={settings.captions.language} onChange={(event) => updateCaptions("language", event.target.value)}><option value="auto">Detect automatically</option><option value="en">English</option><option value="fr">French</option><option value="ar">Arabic</option></select></label><label className="clip-setup-field"><FieldLabel>Transcription quality</FieldLabel><select value={settings.captions.quality} onChange={(event) => updateCaptions("quality", event.target.value as ClipSetupSettings["captions"]["quality"])}><option value="auto">Automatic · choose an available model</option><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="accurate">Accurate</option></select></label><label className="clip-setup-field"><FieldLabel>Dialect</FieldLabel><select value={settings.captions.dialect} onChange={(event) => updateCaptions("dialect", event.target.value as ClipSetupSettings["captions"]["dialect"])}><option value="none">None</option><option value="algerian">Algerian Darija</option></select></label></div>
              </>}
            </div>
          )}

          {step === "camera" && (
            <div className="clip-setup-form" data-tour="setup-camera">
              <div className="clip-setup-options clip-setup-options-wide">
                <OptionCard checked={settings.camera.camera_strategy === "adaptive"} title="Adaptive framing" detail="Preserve people, diagrams and the active subject as the crop changes." icon={<Sparkles size={19} />} onClick={() => { updateCamera("camera_strategy", "adaptive"); updateCamera("framing", "follow"); }} />
                <OptionCard checked={settings.camera.camera_strategy === "follow"} title="Follow subjects" detail="Keep the active subject in frame with a smooth crop." icon={<Focus size={19} />} onClick={() => { updateCamera("camera_strategy", "follow"); updateCamera("framing", "follow"); }} />
                <OptionCard checked={settings.camera.camera_strategy === "manual"} title="Manual crop" detail="Keep a fixed crop; add camera keyframes when editing a clip." icon={<Film size={19} />} onClick={() => { updateCamera("camera_strategy", "manual"); updateCamera("framing", "manual"); }} />
              </div>
              <div className="clip-setup-subgrid">
                <label className="clip-setup-field"><FieldLabel>Output shape</FieldLabel><select value={settings.camera.aspect_ratio} onChange={(event) => updateCamera("aspect_ratio", event.target.value as ClipSetupSettings["camera"]["aspect_ratio"])}>{["9:16", "1:1", "4:5", "16:9"].map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
                <label className="clip-setup-field"><FieldLabel>Resolution</FieldLabel><select value={settings.camera.resolution} onChange={(event) => updateCamera("resolution", Number(event.target.value))}><option value={720}>720p</option><option value={1080}>1080p</option></select></label>
                {settings.camera.camera_strategy !== "manual" && <label className="clip-setup-field"><FieldLabel>Subject position</FieldLabel><select value={settings.camera.subject} onChange={(event) => updateCamera("subject", event.target.value as ClipSetupSettings["camera"]["subject"])}><option value="auto">Auto</option><option value="left">Left</option><option value="right">Right</option></select></label>}
                {settings.camera.camera_strategy !== "manual" && <label className="clip-setup-field"><FieldLabel>Motion preset</FieldLabel><select value={settings.camera.camera_motion} onChange={(event) => updateCamera("camera_motion", event.target.value as ClipSetupSettings["camera"]["camera_motion"])}><option value="steady">Steady</option><option value="smooth">Smooth</option><option value="dynamic">Dynamic</option></select></label>}
                {settings.camera.camera_strategy === "adaptive" && <label className="clip-setup-field"><FieldLabel hint="Used when the subject is hard to track">Safety framing</FieldLabel><select value={settings.camera.safe_framing} onChange={(event) => updateCamera("safe_framing", event.target.value as ClipSetupSettings["camera"]["safe_framing"])}><option value="fit">Contain the whole frame</option><option value="blur">Blur the backdrop</option></select></label>}
                {settings.camera.camera_strategy === "adaptive" && <label className="clip-setup-field"><FieldLabel hint="Gemini is opt-in">Vision provider</FieldLabel><select value={settings.camera.vision_provider} onChange={(event) => updateCamera("vision_provider", event.target.value as ClipSetupSettings["camera"]["vision_provider"])}><option value="local">On this computer</option><option value="gemini">Gemini</option></select></label>}
              </div>
              {settings.camera.camera_strategy !== "manual" && <label className="clip-setup-checkline"><input type="checkbox" checked={settings.camera.camera_auto_zoom} onChange={(event) => setSettings((current) => ({ ...current, camera: { ...current.camera, camera_auto_zoom: event.target.checked, camera_zoom: event.target.checked ? Math.max(1.25, current.camera.camera_zoom) : current.camera.camera_zoom } }))} /><span><strong>Adjust zoom to face size</strong><small>Pull back when the face is close; cap the crop at your maximum zoom.</small></span></label>}
              {settings.camera.camera_strategy !== "manual" && <div className="clip-setup-range-fields">
                <label className="clip-setup-range-control"><FieldLabel>{settings.camera.camera_auto_zoom ? "Maximum zoom" : "Crop zoom"} <b>{settings.camera.camera_zoom.toFixed(2)}×</b></FieldLabel><input type="range" min={1} max={1.5} step={0.01} value={settings.camera.camera_zoom} onChange={(event) => updateCamera("camera_zoom", Number(event.target.value))} /></label>
                <label className="clip-setup-range-control"><FieldLabel>Tracking room <b>{Math.round(settings.camera.camera_dead_zone * 100)}%</b></FieldLabel><input type="range" min={0} max={0.3} step={0.01} value={settings.camera.camera_dead_zone} onChange={(event) => updateCamera("camera_dead_zone", Number(event.target.value))} /></label>
              </div>}
            </div>
          )}

          {step === "captions" && (
            <div className="clip-setup-form" data-tour="setup-captions">
              <div className="clip-setup-options clip-setup-options-wide">
                <OptionCard checked={settings.captions.mode === "none"} title="No captions" detail="Keep the source audio and frame clean." icon={<Volume2 size={19} />} onClick={() => updateCaptions("mode", "none")} />
                <OptionCard checked={settings.captions.mode === "auto"} title="Auto captions" detail="Transcribe spoken words into editable subtitles." icon={<Sparkles size={19} />} onClick={() => { updateCaptions("mode", "auto"); update("use_transcript", true); }} />
                <OptionCard checked={settings.captions.mode === "manual"} title="One manual caption" detail="Add a short overlay that stays on each generated clip." icon={<Captions size={19} />} onClick={() => updateCaptions("mode", "manual")} />
              </div>
              {settings.captions.mode === "manual" && <label className="clip-setup-field"><FieldLabel hint="Shown on every generated clip">Caption text</FieldLabel><textarea rows={3} maxLength={4000} value={settings.captions.text} onChange={(event) => updateCaptions("text", event.target.value)} placeholder="Write a short caption…" /></label>}
              {settings.captions.mode === "auto" && <div className="clip-setup-subgrid"><label className="clip-setup-field"><FieldLabel>Language</FieldLabel><select value={settings.captions.language} onChange={(event) => updateCaptions("language", event.target.value)}><option value="auto">Detect automatically</option><option value="en">English</option><option value="fr">French</option><option value="ar">Arabic</option></select></label><label className="clip-setup-field"><FieldLabel>Transcription quality</FieldLabel><select value={settings.captions.quality} onChange={(event) => updateCaptions("quality", event.target.value as ClipSetupSettings["captions"]["quality"])}><option value="auto">Automatic · choose an available model</option><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="accurate">Accurate</option></select></label><label className="clip-setup-field"><FieldLabel>Dialect</FieldLabel><select value={settings.captions.dialect} onChange={(event) => updateCaptions("dialect", event.target.value as ClipSetupSettings["captions"]["dialect"])}><option value="none">None</option><option value="algerian">Algerian Darija</option></select></label></div>}
              {settings.captions.mode !== "none" && <div className="clip-setup-subgrid"><label className="clip-setup-field"><FieldLabel>Style</FieldLabel><select value={settings.captions.style} onChange={(event) => updateCaptions("style", event.target.value as ClipSetupSettings["captions"]["style"])}><option value="clean">Clean</option><option value="bold">Bold</option><option value="minimal">Minimal</option></select></label><label className="clip-setup-field"><FieldLabel>Font</FieldLabel><select value={settings.captions.font} onChange={(event) => updateCaptions("font", event.target.value as ClipSetupSettings["captions"]["font"])}><option value="outfit">Outfit</option><option value="anton">Anton</option><option value="noto-arabic">Noto Arabic</option></select></label><label className="clip-setup-field"><FieldLabel hint="32–90 px">Size</FieldLabel><input type="number" min={32} max={90} value={settings.captions.size} onChange={(event) => updateCaptions("size", Math.max(32, Math.min(90, Number(event.target.value) || 52)))} /></label><label className="clip-setup-field"><FieldLabel>Color</FieldLabel><div className="clip-setup-color"><input type="color" value={settings.captions.color} onChange={(event) => updateCaptions("color", event.target.value)} /><span>{settings.captions.color}</span></div></label><label className="clip-setup-field"><FieldLabel>Position</FieldLabel><select value={settings.captions.y === 0.5 ? "center" : "bottom"} onChange={(event) => updateCaptions("y", event.target.value === "center" ? 0.5 : 0.86)}><option value="bottom">Bottom</option><option value="center">Center</option></select></label></div>}
            </div>
          )}

          {step === "review" && (
            <div className="clip-setup-review" data-tour="setup-review">
              <div className="clip-setup-review-hero"><div className="clip-setup-review-mark"><Check size={24} /></div><div><h3>{settings.mode === "manual" ? `${settings.ranges.length} moments selected` : settings.mode === "smart" ? (settings.use_transcript ? "Highlights with speech ranking" : "Structural highlights") : "Full source split"}</h3><p>{settings.mode === "smart" && !settings.use_transcript ? "Scene changes and natural pauses shape the first pass. You can edit every clip after generation." : "Clipflow will make a first pass you can edit clip by clip."}</p></div></div>
               <div className="clip-setup-review-grid"><div><span>Camera</span><strong>{settings.camera.camera_strategy === "adaptive" ? "Adaptive framing" : settings.camera.camera_strategy === "follow" ? "Follow subjects" : "Manual crop"}</strong></div><div><span>Captions</span><strong>{settings.captions.mode === "auto" ? `Auto · ${settings.captions.language === "auto" ? "detected language" : settings.captions.language}` : settings.captions.mode === "manual" ? "Manual overlay" : "Off"}</strong></div><div><span>Output</span><strong>{settings.camera.aspect_ratio} · {settings.camera.resolution}p</strong></div><div><span>Audio</span><strong>{settings.audio.denoise ? "Denoised" : "Original audio"}</strong></div></div>
              <details className="clip-setup-advanced"><summary>Audio finishing</summary><div className="clip-setup-range-fields"><label className="clip-setup-range-control"><FieldLabel>Volume <b>{Math.round(settings.audio.volume * 100)}%</b></FieldLabel><input type="range" min={0} max={1} step={0.05} value={settings.audio.volume} onChange={(event) => updateAudio("volume", Number(event.target.value))} /></label><label className="clip-setup-range-control"><FieldLabel>Fade <b>{settings.audio.fade.toFixed(1)} sec</b></FieldLabel><input type="range" min={0} max={2} step={0.1} value={settings.audio.fade} onChange={(event) => updateAudio("fade", Number(event.target.value))} /></label></div><label className="clip-setup-checkline"><input type="checkbox" checked={settings.audio.denoise} onChange={(event) => updateAudio("denoise", event.target.checked)} /><span><strong>Clean up background noise</strong><small>Useful for interviews and handheld recordings.</small></span></label></details>
            </div>
          )}

          {error && <p className="clip-setup-error" role="alert">{error}</p>}
          <div className="clip-setup-actions">
            <button className="clip-setup-back" type="button" onClick={goBack} disabled={busy}><ArrowLeft size={16} /> {stepIndex === 0 ? "Cancel" : "Back"}</button>
            {step === "review" ? <button className="clip-setup-generate" type="button" onClick={() => void generate()} disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />} {busy ? "Generating clips…" : "Generate clips"}</button> : <button className="clip-setup-next" type="button" onClick={goNext}>{step === "source" ? "Configure moments" : "Continue"} <ArrowRight size={16} /></button>}
          </div>
        </section>
      </div>
    </main>
  );
}
