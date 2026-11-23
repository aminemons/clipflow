import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Captions, Check, Clapperboard, Download, Film, FolderOpen, HardDrive,
  LoaderCircle, Play, Scissors, Settings2, Sparkles, Upload,
} from "lucide-react";
import type { EditBrief } from "./AutoEdit";
import type { Clip, Job, Project } from "./editorTypes";
import { motionGraphics, type MotionGraphic } from "./editRecipes";
import "./GuidedEdit.css";

const steps = ["Add footage", "Pick a moment", "Style it", "Watch it", "Download"];
const headings = ["Add a video", "Choose the part worth sharing", "Give the clip a look", "Watch your finished clip", "Save your clip"];
const goals = [
  { value: "story", label: "Tell a story", description: "Keep enough context for the ending to make sense." },
  { value: "social", label: "Share a highlight", description: "Start with a strong opening and keep it short." },
  { value: "visual", label: "Show something", description: "Put the footage first, even without dialogue." },
] as const;

type Props = {
  project: Project | null;
  clips: Clip[];
  selected?: Clip;
  fresh: boolean;
  busy: boolean;
  job: Job | null;
  canTranscribe: boolean;
  onUpload: (file: File) => void;
  onSubtitles: (file: File) => void;
  onDemo: () => void;
  onProjects: () => void;
  onSettings: () => void;
  onFind: (brief: EditBrief) => void;
  onAddRange: (start: number, end: number, format: EditBrief["format"]) => Promise<boolean>;
  onSelect: (clip: Clip) => void;
  onChange: (id: string, patch: Partial<Clip>) => void;
  onTranscribe: () => void;
  onRender: (id: string) => void;
  onExport: (id: string) => void;
  onCaptions: (id: string) => void;
  onAdvanced: (clip?: Clip) => void;
  onCancel: (id: string) => void;
};

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
const lengthOf = (clip: Clip) => Math.max(1, Math.round((
  clip.end - clip.start - (clip.pause_cuts ?? []).filter(gap => gap.start > clip.start && gap.end < clip.end)
    .reduce((total, gap) => total + gap.end - gap.start, 0)
) / (clip.playback_speed || 1)));
const stepKey = (id: string) => `clipflow-guide-step-${id}`;

function startingStep(project: Project | null, clip: Clip | undefined, fresh: boolean) {
  if (fresh || !project) return 0;
  let saved = 1;
  try { saved = Number(localStorage.getItem(stepKey(project.id)) ?? "1"); } catch { /* Editing still works. */ }
  if (!Number.isInteger(saved) || saved < 0 || saved > 4 || (!clip && saved > 1)) return 1;
  if (saved === 4 && !clip?.browser_proof_url && !clip?.download_url) return 3;
  return saved;
}

export default function GuidedEdit(props: Props) {
  const { project, clips, busy } = props;
  const clip = props.selected?.suggestion_status === "discarded" ? undefined : props.selected;
  const [step, setStep] = useState(() => startingStep(project, clip, props.fresh));
  const [furthest, setFurthest] = useState(step);
  const [goal, setGoal] = useState<EditBrief["style"]>(project?.auto_edit?.style ?? "social");
  const [format, setFormat] = useState<EditBrief["format"]>(project?.auto_edit?.format ?? "9:16");
  const [topic, setTopic] = useState(project?.auto_edit?.focus ?? "");
  const [rangeStart, setRangeStart] = useState("0");
  const [rangeEnd, setRangeEnd] = useState(String(Math.min(22, project?.duration ?? 22)));
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeSaving, setRangeSaving] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [failedMedia, setFailedMedia] = useState("");
  const [dragging, setDragging] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const subtitles = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const progress = props.job && ["queued", "running"].includes(props.job.status) ? props.job : null;
  const proof = clip?.browser_proof_url || clip?.download_url;
  const ready = Boolean(proof && proof !== failedMedia);
  const media = step >= 3 ? ready ? proof : undefined : project?.source_url;
  const montage = step > 0 && step < 3 ? clip : undefined;
  const hasCaptions = Boolean(clip && (clip.caption_text || (clip.transcript ?? project?.transcript ?? []).some(cue => cue.end > clip.start && cue.start < clip.end)));
  const batch = project?.auto_edit;
  const candidates = clips.filter(item => item.suggestion_status !== "discarded");
  const latest = candidates.filter(item => item.generation_id === batch?.job_id);
  const choices = latest.length ? [...latest, ...candidates.filter(item => item.id === clip?.id && item.generation_id !== batch?.job_id)] : candidates;
  const start = Number(rangeStart);
  const end = Number(rangeEnd);
  const usableRange = Boolean(rangeStart.trim() && rangeEnd.trim() && Number.isFinite(start) && Number.isFinite(end)
    && start >= 0 && end - start >= 0.1 && end <= (project?.duration ?? 0));
  const unlocked = !project ? 0 : !clip ? 1 : ready ? 4 : 3;

  function move(next: number) {
    setStep(next);
    setFurthest(previous => Math.max(previous, next));
    if (project) {
      try { localStorage.setItem(stepKey(project.id), String(next)); } catch { /* The session can continue. */ }
    }
    requestAnimationFrame(() => {
      heading.current?.closest(".workspace-route")?.scrollTo({ top: 0 });
      heading.current?.focus({ preventScroll: true });
    });
  }

  useEffect(() => {
    const element = video.current;
    if (!element || !montage || element.readyState === 0) return;
    element.pause();
    element.currentTime = montage.start;
  }, [media, montage?.id, montage?.start]);

  useEffect(() => {
    if (!clip && step > 1) setStep(project ? 1 : 0);
  }, [clip, step, project]);

  function find() {
    props.onFind({ style: goal, format, focus: goal === "visual" ? "" : topic.trim(), opening_text: "", count: 3, download_speech: false, visible_captions: false });
    setBriefOpen(false);
  }

  async function addRange() {
    if (!usableRange || busy || rangeSaving) return;
    setRangeSaving(true);
    try {
      if (await props.onAddRange(start, end, format)) {
        setRangeOpen(false);
        move(2);
      }
    } finally { setRangeSaving(false); }
  }

  function changeGraphic(preset: MotionGraphic["preset"], text: string) {
    if (clip) props.onChange(clip.id, { motion_graphic: { preset, text } });
  }

  return <main className="workspace-page guided-edit">
    <header className="page-heading guided-heading">
      <div><h1>Make a clip</h1><p>{project ? project.title : "Turn a longer recording into a short video."}</p></div>
      {project && <button className="secondary-action" disabled={busy} onClick={() => props.onAdvanced(clip)}><Settings2 size={17} /> Advanced editor</button>}
    </header>

    <nav className="guided-steps" aria-label="Clip-making steps">
      {steps.map((label, index) => <button type="button" key={label} disabled={busy || rangeSaving || index > Math.min(unlocked, furthest)}
        aria-current={step === index ? "step" : undefined} onClick={() => move(index)}>
        <span aria-hidden="true">{index < step ? <Check size={15} /> : index + 1}</span><strong>{label}</strong>
      </button>)}
    </nav>

    <div className={`guided-layout${project && step > 0 ? " has-project" : ""}`}>
      <section className="guided-panel" aria-labelledby="guided-step-title">
        <div className="guided-panel-body">
          <h2 id="guided-step-title" ref={heading} tabIndex={-1}>{headings[step]}</h2>
          {step === 0 && <>
            <p>Choose the longer recording you want to make a clip from.</p>
            <button type="button" className={`guided-drop${dragging ? " is-dragging" : ""}`} disabled={busy}
              onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); const file = event.dataTransfer.files[0]; if (file && !busy) props.onUpload(file); }}
              onClick={() => upload.current?.click()}>
              <span><Upload size={25} /></span><strong>Choose a video</strong><small>Drop a file here or click to browse · MP4, MOV, WebM</small>
            </button>
            <div className="guided-inline">
              <button className="secondary-action" disabled={busy} onClick={props.onDemo}><Film size={16} /> Try a sample</button>
              <button className="secondary-action" disabled={busy} onClick={props.onProjects}><FolderOpen size={16} /> Saved projects</button>
            </div>
            {project && <button className="text-action" disabled={busy} onClick={() => move(1)}>Keep working on {project.title}</button>}
          </>}

          {step === 1 && project && <>
            <p>{choices.length && !briefOpen ? "Pick a moment and press play to hear it before you continue." : "Tell ClipFlow what you want to make, then play a few suggested moments."}</p>
            <div hidden={choices.length > 0 && !briefOpen}>
            <fieldset className="guided-choices" disabled={busy}>
              <legend>What should the clip do?</legend>
              {goals.map(item => <label key={item.value} className={goal === item.value ? "is-selected" : ""}>
                <input type="radio" name="guide-goal" checked={goal === item.value} onChange={() => setGoal(item.value)} />
                <span><strong>{item.label}</strong><small>{item.description}</small></span>
              </label>)}
            </fieldset>
            <label className="guided-field">Where will you post it?
              <select value={format} disabled={busy} onChange={event => setFormat(event.target.value as EditBrief["format"])}>
                <option value="9:16">Vertical · Reels, Shorts, TikTok</option>
                <option value="4:5">Portrait · social feed</option>
                <option value="16:9">Wide · YouTube, web</option>
              </select>
            </label>
            {goal !== "visual" && <label className="guided-field">What should it focus on? <small>Optional</small>
              <input value={topic} maxLength={120} disabled={busy} placeholder="For example, the part where you show the result" onChange={event => setTopic(event.target.value)} />
            </label>}
            {!project.transcript?.length && !props.canTranscribe && goal !== "visual" && <div className="guided-note">
              <span>Add subtitles if you want ClipFlow to choose a moment based on what was said.</span>
              <button type="button" className="text-action" disabled={busy} onClick={() => subtitles.current?.click()}>Import subtitles</button>
            </div>}
            <button className={choices.length ? "secondary-action" : "primary-action"} disabled={busy || rangeSaving} onClick={find}><Sparkles size={16} /> {choices.length ? "Find new moments" : "Find moments"}</button>
            </div>
            {batch?.warning && !progress && <p className="guided-note guided-process-note" role="status">{batch.warning}</p>}
            {choices.length > 0 && <fieldset className="guided-choices guided-moments" disabled={busy}>
              <legend>Which moment should we use?</legend>
              {choices.map(item => <label key={item.id} className={clip?.id === item.id ? "is-selected" : ""}>
                <input type="radio" name="guide-moment" checked={clip?.id === item.id} onChange={() => { setFurthest(1); props.onSelect(item); }} />
                <span><strong>{item.title}</strong><small>{clock(item.start)}–{clock(item.end)} in source · {lengthOf(item)} sec</small>{item.reason && <small>{item.reason}</small>}</span>
              </label>)}
            </fieldset>}
            {choices.length > 0 && <button className="text-action" type="button" disabled={busy} aria-expanded={briefOpen} onClick={() => setBriefOpen(value => !value)}>
              {briefOpen ? "Hide goal and format" : "Change goal or format"}
            </button>}
            <details className="guided-details" open={rangeOpen} onToggle={event => setRangeOpen(event.currentTarget.open)}>
              <summary>Choose your own section</summary>
              <p>Use the time shown on the source video to enter where to start and stop.</p>
              <div className="guided-inline">
                <label className="guided-field">Start (seconds)<input type="number" min={0} max={project.duration} step="0.1" value={rangeStart} onChange={event => setRangeStart(event.target.value)} /></label>
                <label className="guided-field">End (seconds)<input type="number" min={0} max={project.duration} step="0.1" value={rangeEnd} onChange={event => setRangeEnd(event.target.value)} /></label>
              </div>
              <button className="secondary-action" onClick={() => void addRange()} disabled={!usableRange || busy || rangeSaving}><Scissors size={16} /> Use this section</button>
            </details>
          </>}

          {step === 2 && clip && <>
            <p>The defaults work for most clips. Change anything you want to see in your preview.</p>
            <label className="guided-field">How should the video fit?
              <select value={clip.framing} disabled={busy} onChange={event => {
                const framing = event.target.value as Clip["framing"];
                props.onChange(clip.id, { framing, camera_strategy: framing === "follow" ? "adaptive" : "manual", focus_x: 0.5, camera_zoom: 1, camera_keyframes: [] });
              }}>
                <option value="follow">Keep the subject in frame</option>
                <option value="fit">Show the whole video</option>
                <option value="blur">Show the whole video with a blurred background</option>
                <option value="manual">Fill the screen from the center</option>
              </select>
            </label>
            <label className="guided-check">
              <input type="checkbox" checked={hasCaptions && clip.caption_enabled !== false} disabled={busy || !hasCaptions}
                onChange={event => props.onChange(clip.id, { caption_enabled: event.target.checked })} /> Show subtitles
            </label>
            {hasCaptions ? <label className="guided-field">Subtitle style
              <select value={clip.caption_style} disabled={busy || clip.caption_enabled === false}
                onChange={event => props.onChange(clip.id, { caption_style: event.target.value as Clip["caption_style"] })}>
                <option value="clean">Clean</option><option value="bold">Bold</option><option value="minimal">Minimal</option>
              </select>
            </label> : <div className="guided-inline">
              <button className="secondary-action" disabled={busy} onClick={() => subtitles.current?.click()}><Captions size={16} /> Import SRT or VTT</button>
              {props.canTranscribe ? <button className="secondary-action" disabled={busy} onClick={props.onTranscribe}>Create subtitles</button>
                : <button className="text-action" onClick={props.onSettings}>Set up automatic subtitles</button>}
            </div>}
            <details className="guided-details">
              <summary>Add a title or animation</summary>
              <label className="guided-field">What should appear on screen?
                <select value={clip.motion_graphic?.preset || ""} disabled={busy} onChange={event => {
                  const preset = motionGraphics.find(item => item.id === event.target.value);
                  if (preset) changeGraphic(preset.id, clip.motion_graphic?.text || "");
                  else props.onChange(clip.id, { motion_graphic: null });
                }}>
                  <option value="">None</option>
                  {motionGraphics.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
                </select>
              </label>
              {clip.motion_graphic && !["flash", "zoom"].includes(clip.motion_graphic.preset) && <label className="guided-field">On-screen text
                <input value={clip.motion_graphic.text} maxLength={72} disabled={busy} placeholder="Type the words viewers should see"
                  onChange={event => changeGraphic(clip.motion_graphic!.preset, event.target.value)} />
              </label>}
            </details>
          </>}

          {step === 3 && clip && <>
            <p>Play the preview with sound before you save it.</p>
            <ul className="guided-review">
              <li><Play size={16} /> The opening makes sense on its own.</li>
              <li><Film size={16} /> The main subject stays visible through the cut.</li>
              <li><Captions size={16} /> The speech is clear and any subtitles are correct.</li>
            </ul>
            {!ready && !progress && <button className="primary-action" disabled={busy} onClick={() => props.onRender(clip.id)}><Play size={17} /> Render preview</button>}
          </>}

          {step === 4 && clip && <>
            <p>Save the video to your device, ready to post.</p>
            <div className="guided-file">
              <span><Film size={21} /></span><div><strong>{clip.download_name || clip.title}</strong>
                <small>{lengthOf(clip)} sec · {clip.aspect_ratio ?? "9:16"} · {clip.resolution}p</small></div>
            </div>
            {clip.download_url ? <a className="primary-action" href={clip.download_url} download={clip.download_name || true}><Download size={17} /> Download video</a>
              : <button className="primary-action" disabled={busy} onClick={() => props.onExport(clip.id)}><Download size={17} /> Prepare download</button>}
            {hasCaptions && <button className="text-action guided-srt" disabled={busy} onClick={() => props.onCaptions(clip.id)}><Captions size={16} /> Download subtitles separately</button>}
          </>}

          {progress && <div className="guided-progress" role="status">
            <div><LoaderCircle className="spin" size={16} /><strong>{progress.stage || "Working on your clip"}</strong>
              <button className="text-action" type="button" onClick={() => props.onCancel(progress.id)}>Cancel</button></div>
            <progress max={100} value={progress.progress ?? 0} aria-label="Processing progress" />
          </div>}
        </div>

        {step > 0 && <footer className="guided-panel-footer">
          <button type="button" className="secondary-action" disabled={busy || rangeSaving} onClick={() => move(step - 1)}><ArrowLeft size={17} /> Back</button>
          {step === 1 && <button className="primary-action" disabled={!clip || busy || rangeSaving} onClick={() => {
            if (clip && clip.aspect_ratio !== format) props.onChange(clip.id, { aspect_ratio: format });
            move(2);
          }}>Use this moment</button>}
          {step === 2 && <button className="primary-action" disabled={!clip || busy} onClick={() => {
            if (!clip) return;
            move(3);
            if (!ready) props.onRender(clip.id);
          }}>Preview my clip</button>}
          {step === 3 && <button className="primary-action" disabled={!ready || busy} onClick={() => {
            if (!clip) return;
            move(4);
            if (!clip.download_url) props.onExport(clip.id);
          }}>Looks good</button>}
          {step === 4 && <button className="secondary-action" disabled={busy} onClick={props.onProjects}><FolderOpen size={16} /> My projects</button>}
        </footer>}
      </section>

      <section className="guided-viewer" aria-label={step < 3 ? "Source preview" : "Finished video"}>
        <div className="guided-viewer-header"><span><Clapperboard size={17} /> {step < 3 ? "Source preview" : "Finished video"}</span>
          {montage && !rangeOpen ? <small>{clock(montage.start)}–{clock(montage.end)} in source</small>
            : step < 3 && project ? <small>{clock(project.duration)} source</small> : null}
        </div>
        <div className="guided-video">
          {media && media !== failedMedia ? <video key={media} ref={video} src={media} controls playsInline preload="metadata" aria-label={step < 3 ? "Source video" : "Rendered clip"}
            onLoadedMetadata={event => { if (montage && !rangeOpen) event.currentTarget.currentTime = montage.start; }}
            onPlay={event => {
              const element = event.currentTarget;
              if (montage && !rangeOpen && (element.currentTime < montage.start || element.currentTime >= montage.end)) element.currentTime = montage.start;
            }}
            onTimeUpdate={event => { if (montage && !rangeOpen && event.currentTarget.currentTime >= montage.end) event.currentTarget.pause(); }}
            onError={() => setFailedMedia(media)} /> : !project
            ? <img src="/studio/sample.webp" alt="Mist moving over a mountain in the sample video" />
            : <div className="guided-viewer-empty">{progress ? <LoaderCircle size={28} className="spin" /> : <Film size={29} />}
              <p>{media === failedMedia ? "This video couldn’t be played." : progress ? "Your preview is on the way." : "Your rendered preview will appear here."}</p></div>}
        </div>
        <div className="guided-viewer-caption">
          {!project ? <><span>Sample footage</span><button className="text-action" disabled={busy} onClick={props.onDemo}>Try this video</button></>
            : <><HardDrive size={15} /> <span>{step < 3 ? "Footage and edits are saved on this device." : "The preview uses your final framing, graphics, and audio."}</span></>}
        </div>
      </section>
    </div>
    <input type="file" ref={upload} accept="video/*,.mp4,.mov,.webm,.mkv" aria-label="Choose source video" hidden onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) props.onUpload(file);
    }} />
    <input type="file" ref={subtitles} accept=".srt,.vtt" aria-label="Choose subtitles file" hidden onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) props.onSubtitles(file);
    }} />
  </main>;
}
