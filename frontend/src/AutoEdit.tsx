import { useState } from "react";
import { Clapperboard, Download, Film, Play, Scissors } from "lucide-react";
import type { Clip, Job, Project } from "./editorTypes";
import "./AutoEdit.css";

export type EditBrief = {
  style: "story" | "social" | "visual";
  format: "9:16" | "4:5" | "16:9";
  focus: string;
  opening_text: string;
  count: 1 | 3;
  download_speech: boolean;
  visible_captions: boolean;
};

const recipes = [
  { id: "story", name: "Story cut", detail: "Keep the setup and payoff. Use steady framing and clean subtitles." },
  { id: "social", name: "Social cut", detail: "Find a shorter moment with a clear hook, stronger captions and a closer crop." },
  { id: "visual", name: "Visual cut", detail: "Pick a moment from movement and scene changes. Keep the whole shot in view." },
] as const;

export default function AutoEdit({
  project, clips, job, busy, onMake, onManual, onExport,
}: {
  project: Project;
  clips: Clip[];
  job: Job | null;
  busy: boolean;
  onMake: (brief: EditBrief) => void;
  onManual: (clip?: Clip) => void;
  onExport: (ids: string[]) => void;
}) {
  const batch = project.auto_edit;
  const drafts = batch
    ? clips.filter((clip) => clip.generation_id === batch.job_id && clip.suggestion_status !== "discarded")
    : [];
  const [choice, setChoice] = useState("");
  const [briefOpen, setBriefOpen] = useState(!drafts.length);
  const [failedPreview, setFailedPreview] = useState("");
  const [brief, setBrief] = useState<EditBrief>(() => ({
    style: batch?.style ?? "story",
    format: batch?.format ?? "9:16",
    focus: batch?.focus ?? "",
    opening_text: batch?.opening_text ?? "",
    count: batch?.count ?? 1,
    download_speech: batch?.download_speech ?? false,
    visible_captions: batch?.visible_captions ?? false,
  }));
  const cut = drafts.find((clip) => clip.id === choice) ?? drafts[0];
  const recipe = recipes.find((item) => item.id === batch?.style);
  const proof = cut?.auto_proof && (cut.revision ?? 1) === cut.auto_proof.revision
    ? `/api/projects/${project.id}/clips/${cut.id}/previews/${cut.auto_proof.job_id}`
    : "";
  const preview = cut?.download_url || proof;
  const showBrief = briefOpen || !cut;

  return (
    <main className="auto-room">
      <div className="auto-screen">
        <div className="auto-screen-label">
          <Film size={16} />
          {cut ? "Rendered first cut" : "Source footage"}
          {cut && <span>{cut.aspect_ratio} · {Math.round(cut.end - cut.start)} sec</span>}
        </div>
        <div className="auto-player">
          {cut ? (
            preview && failedPreview !== preview ? (
              <video key={preview} src={preview} controls playsInline preload="metadata"
                aria-label="Rendered cut preview" onError={() => setFailedPreview(preview)} />
            ) : (
              <div className="auto-screen-empty">
                <Film size={30} />
                <p>{proof ? "This preview was removed from storage." : "This cut has been edited since the first preview."}</p>
                <button className="secondary-action" onClick={() => onManual(cut)}>Open cut to preview current edits</button>
              </div>
            )
          ) : (
            <video key={project.id} src={project.source_url} poster={project.thumbnail_url}
              controls playsInline preload="metadata" aria-label="Original footage" />
          )}
        </div>
        {drafts.length > 1 && (
          <div className="auto-drafts" aria-label="Rendered cuts">
            {drafts.map((clip, index) => (
              <button type="button" key={clip.id} aria-pressed={cut?.id === clip.id}
                onClick={() => setChoice(clip.id)}>
                <Play size={14} /> Cut {index + 1} <span>{Math.round(clip.end - clip.start)} sec</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="auto-brief">
        {showBrief ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            onMake({
              ...brief,
              focus: brief.style === "visual" ? "" : brief.focus.trim(),
              opening_text: brief.opening_text.trim(),
            });
          }}>
            <h1>{cut ? "Make another cut" : "What are we making?"}</h1>
            <p>Choose a direction. Clipflow will find the moment, frame it, finish the sound and render a cut for you to watch.</p>
            <fieldset className="auto-recipes">
              <legend>Editing style</legend>
              {recipes.map(({ id, name, detail }) => (
                <label key={id}>
                  <input type="radio" name="auto-edit-style" checked={brief.style === id}
                    onChange={() => setBrief({ ...brief, style: id })} />
                  <span><strong>{name}</strong><small>{detail}</small></span>
                </label>
              ))}
            </fieldset>
            <label className="auto-field">
              Where will it go?
              <select value={brief.format} onChange={(event) =>
                setBrief({ ...brief, format: event.target.value as EditBrief["format"] })}>
                <option value="9:16">Shorts, Reels or TikTok · vertical</option>
                <option value="4:5">Social feed · portrait</option>
                <option value="16:9">YouTube or web · wide</option>
              </select>
            </label>
            {brief.style !== "visual" && (
              <label className="auto-field">
                Topic to look for (optional)
                <input value={brief.focus} maxLength={120} placeholder="For example, the turning point"
                  onChange={(event) => setBrief({ ...brief, focus: event.target.value })} />
              </label>
            )}
            <details className="auto-options">
              <summary>Title, alternate cuts and captions</summary>
              <label className="auto-field">
                Opening title (optional)
                <input value={brief.opening_text} maxLength={72}
                  onChange={(event) => setBrief({ ...brief, opening_text: event.target.value })} />
              </label>
              <label className="auto-check">
                <input type="checkbox" checked={brief.count === 3} onChange={(event) =>
                  setBrief({ ...brief, count: event.target.checked ? 3 : 1 })} />
                Look for up to three cuts
              </label>
              {brief.style !== "visual" && (
                <>
                  <label className="auto-check">
                    <input type="checkbox" checked={brief.visible_captions} onChange={(event) =>
                      setBrief({ ...brief, visible_captions: event.target.checked })} />
                    My video already has captions on screen
                  </label>
                  <label className="auto-check">
                    <input type="checkbox" checked={brief.download_speech} onChange={(event) =>
                      setBrief({ ...brief, download_speech: event.target.checked })} />
                    Download the local speech model if needed
                  </label>
                </>
              )}
            </details>
            <button className="primary-action auto-submit" disabled={busy}><Clapperboard size={17} /> Make my edit</button>
          </form>
        ) : (
          <div className="auto-result">
            <h1>Your cut is ready</h1>
            <p>Watch it with sound. If it works for you, export it. You can also try a different direction.</p>
            <h2>{cut.title}</h2>
            {cut.reason && <p>Why this moment: {cut.reason}.</p>}
            <dl>
              <div><dt>Style</dt><dd>{recipe?.name}</dd></div>
              <div><dt>Subtitles</dt><dd>{cut.caption_enabled && cut.transcript?.length
                ? "Added"
                : batch?.visible_captions ? "From the source" : "Off"}</dd></div>
            </dl>
            {cut.download_url ? (
              <a className="primary-action auto-submit" href={cut.download_url}><Download size={17} /> Download MP4</a>
            ) : (
              <button className="primary-action auto-submit" disabled={busy} onClick={() => onExport([cut.id])}>
                <Download size={17} /> Export this cut
              </button>
            )}
            <button type="button" className="secondary-action" onClick={() => setBriefOpen(true)}>Try another direction</button>
          </div>
        )}
        {job && busy && (
          <div className="auto-progress" role="status">
            <span>{job.stage || "Preparing the edit"} · {job.progress ?? 0}%</span>
            <progress max={100} value={job.progress ?? 0} />
          </div>
        )}
        {batch?.warning && <p className="auto-warning">{batch.warning}</p>}
        <button type="button" className="text-action auto-manual" onClick={() => onManual(cut)}>
          <Scissors size={15} /> Open editing tools
        </button>
      </div>
    </main>
  );
}
