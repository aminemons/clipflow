import { ApiError } from "../apiClient";
import type { EditBrief } from "../AutoEdit";
import type { ClipSetupSettings } from "../ClipSetup";
import type { Clip, Job, Project, ProviderSettings } from "../editorTypes";
import { transcriptFor } from "../studio/assistant";
import { filename, makeId, srt } from "../studio/model";
import { projects as previousProjects, readMedia as previousMedia } from "../studio/storage";
import type { SubtitleSegment } from "../subtitleImport";
import { list, put, read, remove, revise, transaction } from "./database";
import { automaticClip, clipDraft, configuredClip, intersectTranscript, moments, renderedCaptions, renderProject } from "./editing";
import { adobePackage, zipFiles } from "./zip";

type BrowserProject = Project & {
  sourceName: string;
  sourceBytes: number;
  trash?: { index: number; clip: Clip }[];
  approvals?: Record<string, number>;
};
type Artifact = { id: string; project: string; clip?: string; kind: "proof" | "export"; data: Blob; name: string };
type BrowserJob = Job & { operation: string; request?: unknown; artifact?: string; owner: string };
type JobContext = { id: string; signal: AbortSignal; report: (stage: string, progress?: number) => Promise<void> };
const owner = makeId();
const activeJobs = new Map<string, AbortController>();
const objectURLs = new Map<string, string>();
const now = () => new Date().toISOString();
const browserHelp = "Open the full desktop app or the cloud workspace for this option.";
const fail = (detail: string, status = 400) => { throw new ApiError(detail, status); };
const notAvailable = (feature: string) => fail(`${feature} needs the full processing workspace. ${browserHelp}`, 409);
const keys: Record<string, string> = {};
let settings: ProviderSettings = {
  transcription_provider: "local", whisper_model: "", highlight_provider: "local", higgsfield_enabled: false,
  groq_highlight_model: "llama-3.3-70b-versatile", openai_text_model: "gpt-5-mini", keys: {},
};

function objectURL(id: string, blob: Blob) {
  let url = objectURLs.get(id);
  if (!url) {
    url = URL.createObjectURL(blob);
    objectURLs.set(id, url);
  }
  return url;
}

function revoke(id: string) {
  const url = objectURLs.get(id);
  if (url) URL.revokeObjectURL(url);
  objectURLs.delete(id);
}

async function authorize() {
  const plan = await window.clipflowDesktop?.session().then(session => session.sharing).catch(() => false);
  return { key: keys.OPENAI_API_KEY ?? "", plan: plan === true };
}

function currentSettings() {
  const visibleKeys = Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, Boolean(value)]));
  return { ...settings, transcription_provider: keys.OPENAI_API_KEY ? "openai" : settings.transcription_provider, keys: visibleKeys };
}

async function health() {
  const auth = await authorize();
  return {
    ffmpeg: "VideoEncoder" in window, ffprobe: true, transcription: !!auth.key,
    configuration: {
      transcription: { provider: auth.key ? "openai" : "local", available: !!auth.key, configured: !!auth.key, message: auth.key ? "OpenAI timed transcription is ready." : "Import SRT/VTT subtitles, add an OpenAI key, or use local Whisper in the full desktop app." },
      highlights: { provider: settings.highlight_provider, available_providers: auth.key || auth.plan ? ["local", "openai"] : ["local"] },
      higgsfield: { configured: false, message: "Higgsfield generation is available in the full workspace." },
    },
  };
}

const artifactURL = async (id?: string) => {
  if (!id) return undefined;
  const blob = await read<Artifact>("artifacts", id);
  return blob ? objectURL(id, blob.data) : undefined;
};

async function publicProject(value: BrowserProject): Promise<Project> {
  const source = await read<Blob>("sources", value.id);
  const thumbnail = await read<Blob>("sources", value.id + ":thumbnail");
  const clips = await Promise.all(value.clips.map(async clip => {
    const saved = clip.download_url ? await read<Artifact>("artifacts", clip.download_url) : undefined;
    const proof = clip.auto_proof?.revision === (clip.revision ?? 1) ? await artifactURL(clip.auto_proof.job_id + ":" + clip.id) : undefined;
    return { ...clip, download_url: saved ? objectURL(saved.id, saved.data) : undefined, download_name: saved?.name, browser_proof_url: proof };
  }));
  return { ...value, source_url: source ? objectURL(value.id, source) : undefined,
    thumbnail_url: thumbnail ? objectURL(value.id + ":thumbnail", thumbnail) : undefined,
    clips, can_restore_clips: !!value.trash?.length };
}

async function publicJob(job: BrowserJob): Promise<Job> {
  const { artifact, owner: jobOwner, ...row } = job;
  const stale = !activeJobs.has(job.id) && jobOwner !== owner && Date.now() - Date.parse(row.updated_at ?? "") > 120_000;
  if (stale && (row.status === "queued" || row.status === "running")) return { ...row, status: "error", error: "Local processing was interrupted. Retry this job." };
  const link = artifact ? await read<Artifact>("artifacts", artifact) : undefined;
  return { ...row, download_url: link ? objectURL(link.id, link.data) : undefined, download_name: link?.name };
}

async function getProject(id: string) {
  return await read<BrowserProject>("projects", id) ?? fail("Project not found.", 404);
}
function findClip(project: BrowserProject, id: string) {
  return project.clips.find(clip => clip.id === id) ?? fail("Clip not found.", 404);
}
async function sourceOf(id: string) {
  return await read<Blob>("sources", id) ?? fail("This project’s source is unavailable.", 404);
}

async function saveProject(project: BrowserProject, source: Blob, thumbnail?: Blob) {
  await transaction(["projects", "sources"], "readwrite", tx => {
    const bytes = tx.objectStore("sources");
    bytes.put(source, project.id);
    if (thumbnail) bytes.put(thumbnail, project.id + ":thumbnail");
    return tx.objectStore("projects").put(project, project.id);
  });
}

async function editProject<R>(id: string, edit: (project: BrowserProject) => R) {
  return revise<BrowserProject, R>("projects", id, project => {
    if (!project) return fail("Project not found.", 404);
    const result = edit(project);
    project.updated_at = now();
    return [project, result];
  });
}

let migration: Promise<void> | undefined;
function migrateProjects() {
  migration ??= (async () => {
    const marker = "clipflow-migrated-studio-projects";
    if (localStorage.getItem(marker)) return;
    for (const item of await previousProjects()) {
      if (item.demo || await read("projects", item.id)) continue;
      const blob = await previousMedia(item.id);
      if (!blob) continue;
      const project: BrowserProject = {
        id: item.id, created_at: new Date(item.updated).toISOString(), updated_at: new Date(item.updated).toISOString(),
        title: item.title, sourceName: item.sourceName, sourceBytes: blob.size,
        width: item.width, height: item.height, duration: item.duration, fps: 30, transcript: item.transcript, clips: [],
      };
      const first = item.cut.graphics.find(graphic => graphic.text && ["opening", "speaker", "callout"].includes(graphic.style));
      const spans = item.cut.spans;
      const chronological = spans.every((span, i) => !i || span.start >= spans[i - 1].end);
      const ranges = chronological ? [{ start: spans[0].start, end: spans[spans.length - 1].end,
        pause_cuts: spans.slice(1).map((span, i) => ({ start: spans[i].end, end: span.start })) }] : spans;
      project.clips = ranges.map(range => clipDraft(project, {
        ...range, title: item.title, selected: true, caption_enabled: item.cut.captions,
        framing: item.cut.frame === "fill" ? "manual" : item.cut.frame, caption_color: item.cut.accent,
        caption_size: Math.round(52 * item.cut.captionSize / 100), focus_x: item.cut.focus / 100,
        camera_zoom: item.cut.zoom / 100, audio_volume: item.cut.volume / 100,
        audio_fade: item.cut.fade ? 0.12 : 0, aspect_ratio: item.destination === "wide" ? "16:9" : item.destination === "square" ? "1:1" : "9:16",
        motion_graphic: first ? { preset: first.style as "opening" | "speaker" | "callout", text: first.text } : undefined,
      }));
      await saveProject(project, blob);
    }
    localStorage.setItem(marker, "1");
  })().catch(error => {
    migration = undefined;
    console.warn("Clipflow could not bring earlier studio projects into this workspace.", error);
  });
  return migration;
}

async function queue(project: string | undefined, operation: string, kind: string, request: unknown, work: (context: JobContext) => Promise<string | void>) {
  const id = makeId();
  const controller = new AbortController();
  const job: BrowserJob = {
    id, owner, operation, kind, request, project_id: project, status: "queued", stage: "Queued on this device",
    progress: 0, created_at: now(), updated_at: now(),
  };
  activeJobs.set(id, controller);
  try { await put("jobs", id, job); } catch (error) { activeJobs.delete(id); throw error; }
  const save = async (values: Partial<BrowserJob>) => {
    Object.assign(job, values, { updated_at: now() });
    await put("jobs", id, job);
  };
  window.setTimeout(() => {
    void (async () => {
      await save({ status: "running", stage: "Processing on this device" });
      try {
        const artifact = await work({ id, signal: controller.signal, report: (stage, progress) => save({ stage, ...(progress === undefined ? {} : { progress }) }) });
        await save({ status: "done", progress: 100, stage: "Complete", artifact: artifact || undefined,
          project_id: job.project_id || (operation === "upload" || operation === "demo" ? id : undefined) });
      } catch (e) {
        const incomplete = (await list<Artifact>("artifacts")).filter(artifact => artifact.id === id || artifact.id.startsWith(id + ":"));
        await Promise.allSettled(incomplete.map(artifact => remove("artifacts", artifact.id)));
        await save(controller.signal.aborted ? { status: "cancelled", stage: "Cancelled" } : {
          status: "error", stage: "Could not finish", error: e instanceof Error ? e.message : "Local processing failed.",
        });
      }
    })().catch(error => console.error("Could not save local job state.", error)).finally(() => activeJobs.delete(id));
  }, 10);
  return { ...job };
}

async function importSource(type: "upload" | "demo", file?: File) {
  if (file && file.size > 500_000_000) return fail("Choose a source under 500 MB.");
  return queue(undefined, type, type + "_job", undefined, async context => {
    const video = file ? file : await fetch("/studio/sample.mp4", { signal: context.signal }).then(async response => {
      if (!response.ok) throw new Error("The demo video could not be loaded.");
      return new File([await response.blob()], "Above the cloudline.mp4", { type: "video/mp4" });
    });
    const info = await (await import("../studio/media")).probe(video);
    context.signal.throwIfAborted();
    const project: BrowserProject = { id: context.id, title: video.name.replace(/\.[^.]+$/, ""), sourceName: video.name,
      sourceBytes: video.size, created_at: now(), updated_at: now(), fps: 30, ...info, clips: [] };
    let thumbnail;
    if (type === "demo") {
      const { sampleTranscript } = await import("../studio/model");
      project.transcript = sampleTranscript;
      thumbnail = await fetch("/studio/sample.webp", { signal: context.signal }).then(res => res.ok ? res.blob() : undefined);
    }
    await saveProject(project, video, thumbnail);
    void navigator.storage?.persist?.().catch(() => undefined);
  });
}

async function render(project: BrowserProject, clip: Clip, type: "proof" | "export", context: JobContext, index = 0, count = 1) {
  const source = await sourceOf(project.id);
  const { renderClip } = await import("../studio/media");
  const profile = renderProject(project, clip);
  if (clip.framing === "follow" && !clip.camera_keyframes?.length) {
    await context.report(`Analyzing framing for ${clip.title}`, Math.round(index / count * 100));
    const { browserCamera } = await import("./camera");
    try {
      const keys = await browserCamera(source, clip, context.signal);
      if (keys.length) profile.cut.keyframes = keys;
      else if (clip.camera_strategy === "adaptive") profile.cut.frame = clip.safe_framing ?? "fit";
    } catch {
      context.signal.throwIfAborted();
      if (clip.camera_strategy === "adaptive") profile.cut.frame = clip.safe_framing ?? "fit";
    }
  }
  const quality = ([180, 360, 720, 1080].includes(clip.resolution) ? clip.resolution : 720) as 180 | 360 | 720 | 1080;
  await context.report(`Rendering ${clip.title}`, Math.round(index / count * 100));
  const result = await renderClip(source, profile, quality, context.signal, progress => {
    // Keep reports outside the encoding dependency graph.
    void context.report(`Rendering ${clip.title}`, Math.min(99, Math.round((index + progress) / count * 100))).catch(() => undefined);
  }, "auto");
  const artifact: Artifact = {
    id: context.id + ":" + clip.id, clip: clip.id, project: project.id, kind: type, data: result.data, name: `${filename(clip.title)}.${result.extension}`,
  };
  await put("artifacts", artifact.id, artifact);
  return artifact;
}

async function transcribe(project: BrowserProject, body: { clip_id?: string; language?: string; initial_prompt?: string }, context: JobContext) {
  const auth = await authorize();
  if (!auth.key) throw new Error("Add an OpenAI developer key in Settings or import SRT/VTT. The full desktop app also supports offline Whisper.");
  const media = await sourceOf(project.id);
  const transcript = await transcriptFor(media, project.duration, auth.key, context.signal, label => { void context.report(label); }, { language: body.language, prompt: body.initial_prompt });
  context.signal.throwIfAborted();
  await applyTranscript(project.id, transcript, body.clip_id);
  return transcript;
}

async function applyTranscript(project: string, transcript: SubtitleSegment[], clipId?: string) {
  await editProject(project, current => {
    if (clipId) {
      const clip = findClip(current, clipId);
      Object.assign(clip, { transcript: intersectTranscript(transcript, clip), revision: (clip.revision || 1) + 1, download_url: undefined, auto_proof: undefined, status: "draft" });
    } else {
      current.transcript = transcript;
      for (const clip of current.clips) if (!clip.transcript && !clip.caption_text) {
        Object.assign(clip, { revision: (clip.revision || 1) + 1, download_url: undefined, auto_proof: undefined, status: "draft" });
      }
    }
  });
}

const jobKinds = { generate: "generate_clips_job", "auto-edit": "auto_edit_job", preview: "preview_job", export: "export_job", transcribe: "transcribe_job" } as const;
type Operation = keyof typeof jobKinds;
async function startProjectJob(id: string, operation: Operation, data: unknown) {
  const project = await getProject(id);
  const running = (await list<BrowserJob>("jobs")).find(job => job.project_id === id && activeJobs.has(job.id));
  if (running) return fail("Wait for the current job to finish.", 409);
  return queue(id, operation, jobKinds[operation], data, async context => {
    const auth = await authorize();
    if (operation === "transcribe") {
      await transcribe(project, data as { clip_id?: string }, context);
      return;
    }
    if (operation === "preview") {
      const clip = findClip(project, (data as { clip_id: string }).clip_id);
      const artifact = await render(project, clip, "proof", context);
      context.signal.throwIfAborted();
      await editProject(id, current => {
        const saved = current.clips.find(item => item.id === clip.id && item.revision === clip.revision);
        if (saved) saved.auto_proof = { job_id: context.id, revision: clip.revision || 1 };
      });
      return artifact.id;
    }
    if (operation === "export") {
      const ids = [...new Set((data as { clip_ids: string[] }).clip_ids)];
      if (!ids.length) return fail("Choose clips to export.");
      const clips = ids.map(id => findClip(project, id));
      const artifacts: Artifact[] = [];
      for (const [index, clip] of clips.entries()) {
        const proof = clip.auto_proof?.revision === (clip.revision || 1)
          ? await read<Artifact>("artifacts", clip.auto_proof.job_id + ":" + clip.id) : undefined;
        if (proof?.kind === "proof" && proof.project === id && proof.clip === clip.id) {
          context.signal.throwIfAborted();
          const final: Artifact = { ...proof, id: context.id + ":" + clip.id, kind: "export" };
          await put("artifacts", final.id, final);
          artifacts.push(final);
        } else {
          artifacts.push(await render(project, clip, "export", context, index, clips.length));
        }
      }
      context.signal.throwIfAborted();
      let artifactId = artifacts[0].id;
      if (artifacts.length > 1) {
        const archive = await zipFiles(artifacts.map((artifact, index) => ({ name: `${index + 1}-${artifact.name}`, data: artifact.data })), context.signal);
        artifactId = context.id;
        await put("artifacts", artifactId, { id: artifactId, project: project.id, kind: "export", data: archive, name: `${filename(project.title)}-clips.zip` } satisfies Artifact);
      }
      await editProject(id, current => {
        for (const [index, clip] of clips.entries()) {
          const currentClip = current.clips.find(item => item.id === clip.id);
          if (currentClip && currentClip.revision === clip.revision) Object.assign(currentClip, { download_url: artifacts[index].id, status: "exported" });
        }
      });
      return artifactId;
    }
    if (operation === "generate") {
      const options = data as ClipSetupSettings;
      if (!["local", "openai"].includes(options.provider)) return notAvailable(options.provider + " highlight selection");
      if (options.camera.vision_provider === "gemini") return notAvailable("Gemini vision analysis");
      if (options.provider === "openai" && !auth.key && !auth.plan) return fail("Connect OpenAI in Processing & providers first.");
      if (options.captions.mode === "auto" && !project.transcript?.length && auth.key) {
        project.transcript = await transcribe(project, { language: options.captions.language }, context);
      }
      const ranges = await moments(project, options, auth, context.signal, label => { void context.report(label); });
      if (!ranges.length) return fail("Add a time range or choose a different clip mode.");
      context.signal.throwIfAborted();
      const clips = ranges.map((range, index) => configuredClip(project, range, options, context.id, index));
      await editProject(id, current => { current.clips.push(...clips); current.generation_settings = options; });
      return;
    }
    const { render_preview: preview = true, ...brief } = data as EditBrief & { render_preview?: boolean };
    if (!preview) await context.report("Finding moments", 5);
    let warning: string | undefined;
    if (brief.style !== "visual" && !project.transcript?.length && auth.key) {
      try { project.transcript = await transcribe(project, {}, context); } catch (e) {
        context.signal.throwIfAborted();
        warning = e instanceof Error ? e.message : "Automatic speech recognition was unavailable.";
      }
    }
    if (!project.transcript?.length && brief.style !== "visual") warning ??= "No timed dialogue was available. Review this visual draft or import a transcript.";
    const ranges = await moments(project, { mode:"smart", max_clips:brief.count, use_transcript:brief.style !== "visual",
      topic:brief.focus, target_duration:brief.style === "social" ? 22 : 30, ranges:[], provider: (auth.key || auth.plan) && settings.highlight_provider === "openai" ? "openai" : "local" }, auth, context.signal, label => { void context.report(label); });
    const clips = ranges.map((range, index) => automaticClip(project, range, brief, context.id, index));
    for (const [index, clip] of (preview ? clips : []).entries()) {
      await render(project, clip, "proof", context, index, clips.length);
      clip.auto_proof = { job_id: context.id, revision: clip.revision || 1 };
    }
    context.signal.throwIfAborted();
    await editProject(id, current => { current.clips.push(...clips); current.auto_edit = { ...brief, job_id: context.id, warning }; });
  });
}

async function clean(project: string, proofsOnly: boolean, clip?: string) {
  const items = (await list<Artifact>("artifacts")).filter(item => item.project === project && (!clip || item.clip === clip) && (!proofsOnly || item.kind === "proof"));
  for (const item of items) { await remove("artifacts", item.id); revoke(item.id); }
  return { freed_bytes: items.reduce((sum, item) => sum + item.data.size, 0), removed_count: items.length };
}

const noPublishing = {
  providers: Object.fromEntries(["youtube", "instagram", "tiktok"].map(platform => [platform, { configured: false, enabled: false, accounts: [] }])),
  notes: Object.fromEntries(["youtube", "instagram", "tiktok"].map(platform => [platform, "Connect publishing accounts in the full desktop or cloud workspace."])),
};

async function routes(path: string, init?: RequestInit): Promise<unknown> {
  init?.signal?.throwIfAborted();
  const [base, query] = path.split("?");
  const [resource, id, action, item] = base.split("/").slice(1);
  const method = init?.method ?? "GET";
  const body = init?.body instanceof FormData ? init.body : typeof init?.body === "string" ? JSON.parse(init.body) : {};

  if (base === "/health") return health();
  if (base === "/settings") {
    if (method === "PUT") {
      const { credentials, clear_keys: clearKeys, ...options } = body;
      for (const key of clearKeys ?? []) delete keys[key];
      for (const [key, value] of Object.entries(credentials ?? {})) if (typeof value === "string" && value.trim()) keys[key] = value.trim();
      settings = { ...settings, ...options };
    }
    return currentSettings();
  }
  if (base === "/storage") {
    const [records, artifacts, estimate] = await Promise.all([list<BrowserProject>("projects"), list<Artifact>("artifacts"), navigator.storage.estimate()]);
    const source = records.reduce((sum, value) => sum + value.sourceBytes, 0);
    const renders = artifacts.reduce((sum, value) => sum + value.data.size, 0);
    return { used: { source_bytes: source, export_bytes: renders, media_bytes: 0, model_bytes: 0, total_bytes: source + renders }, free_bytes: Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0)), cached_at: now() };
  }
  if (resource === "jobs") {
    if (!id) return Promise.all((await list<BrowserJob>("jobs")).sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).map(publicJob));
    const job = await read<BrowserJob>("jobs", id) ?? fail("Job not found.", 404);
    if (action === "cancel") activeJobs.get(id)?.abort();
    if (action === "retry") {
      if (job.project_id && job.operation in jobKinds) return startProjectJob(job.project_id, job.operation as Operation, job.request);
      if (job.operation === "demo") return importSource("demo");
      return fail("Choose the source file again to retry this import.");
    }
    return publicJob(job);
  }
  if (base === "/publishing/settings" && method === "GET") return noPublishing;
  if (base === "/publishing/history") return { attempts: [] };
  if (resource === "publishing") return notAvailable("Connected social publishing");
  if (resource === "sources" || id === "youtube" || resource === "desktop-import") return notAvailable("YouTube link import");
  if (resource === "generations") return notAvailable("Higgsfield");
  if (resource !== "projects") return fail("This operation is unavailable.", 404);
  if (!id) {
    await migrateProjects();
    const records = await list<BrowserProject>("projects");
    return Promise.all(records.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).map(publicProject));
  }
  if (id === "demo") return importSource("demo");
  if (id === "upload") {
    const file = body instanceof FormData ? body.get("file") : undefined;
    if (!(file instanceof File)) return fail("Choose a source video.");
    return importSource("upload", file);
  }
  if (!action) {
    if (method === "DELETE") {
      if ((await list<BrowserJob>("jobs")).some(row => row.project_id === id && activeJobs.has(row.id))) return fail("Wait for this project’s current job before removing it.", 409);
      await clean(id, false);
      await transaction(["projects", "sources"], "readwrite", tx => {
        tx.objectStore("sources").delete(id);
        tx.objectStore("sources").delete(id + ":thumbnail");
        return tx.objectStore("projects").delete(id);
      });
      revoke(id);
      revoke(id + ":thumbnail");
      return;
    }
    if (method === "PATCH") {
      await editProject(id, value => {
        for (const key of ["archived", "favorite", "title", "tags"] as const) if (key in body) Object.assign(value, { [key]: body[key] });
      });
    }
    return publicProject(await getProject(id));
  }

  if (action === "readiness") {
    const config = await health();
    return { source_ready: !!await read<Blob>("sources", id), speech: { ready: config.transcription, provider: config.configuration.transcription.provider, warning: config.transcription ? undefined : config.configuration.transcription.message } };
  }
  if (action === "cleanup") return clean(id, true);
  if (action in jobKinds && method === "POST") return startProjectJob(id, action as Operation, body);
  if (action === "transcript") {
    await applyTranscript(id, body.segments, body.clip_id);
    return publicProject(await getProject(id));
  }
  if (action === "edit-package") {
    const current = await getProject(id);
    const clips = (new URLSearchParams(query).get("clip_ids") ?? "").split(",").filter(Boolean).map(key => findClip(current, key));
    if (!clips.length) return fail("Choose clips for the Adobe package.");
    return adobePackage(current, clips, await sourceOf(id), current.sourceName);
  }
  if (action === "approvals") {
    if (method === "POST") await editProject(id, current => {
      current.approvals ??= {};
      for (const key of body.clip_ids) {
        const clip = findClip(current, key);
        if (body.action === "revoke") delete current.approvals[key];
        else if (clip.download_url) current.approvals[key] = clip.revision ?? 1;
      }
    });
    const current = await getProject(id);
    const publicValue = await publicProject(current);
    return { approvals: current.clips.filter(clip => clip.id in (current.approvals || {})).map(clip => ({ clip_id: clip.id, status: "approved",
      revision: current.approvals![clip.id], valid: current.approvals![clip.id] === clip.revision && !!clip.download_url,
      artifact_url: publicValue.clips.find(item => item.id === clip.id)?.download_url })) };
  }
  if (action === "publish") return notAvailable("Direct publishing");
  if (action !== "clips") return fail("This project operation is unavailable.", 404);

  if (item === "bulk") {
    await editProject(id, value => {
      if (body.action === "restore") {
        for (const entry of value.trash ?? []) value.clips.splice(Math.min(entry.index, value.clips.length), 0, entry.clip);
        value.trash = [];
      } else {
        const ids: string[] = body.clip_ids ?? [];
        value.trash = value.clips.map((clip, index) => ({ clip, index })).filter(entry => ids.includes(entry.clip.id));
        value.clips = value.clips.filter(clip => !ids.includes(clip.id));
      }
    });
    return publicProject(await getProject(id));
  }
  if (item && base.endsWith("/captions")) {
    const project = await getProject(id);
    return new Blob([srt(renderedCaptions(project, findClip(project, item)))], { type:"text/plain;charset=utf-8" });
  }
  if (method === "DELETE") {
    await editProject(id, current => {
      findClip(current, item);
      current.clips = current.clips.filter(clip => clip.id !== item);
      current.trash = (current.trash ?? []).filter(entry => entry.clip.id !== item);
    });
    await clean(id, false, item);
    return;
  }
  if (method === "POST") return editProject(id, current => {
    const clip = clipDraft(current, body);
    if (body.source_clip_id) {
      const source = findClip(current, body.source_clip_id);
      if (source.transcript) clip.transcript = intersectTranscript(source.transcript, clip);
    }
    current.clips.push(clip);
    return clip;
  });
  if (method === "PATCH") return editProject(id, current => {
    const clip = findClip(current, item);
    const mediaEdit = Object.keys(body).some(key => !["selected", "reviewed", "suggestion_status", "id", "revision", "download_url", "auto_proof", "browser_proof_url"].includes(key));
    const validated = mediaEdit ? clipDraft(current, { ...clip, ...body }) : clip;
    Object.assign(clip, {
      ...body, id: item, start: validated.start, end: validated.end, revision: (clip.revision || 1) + Number(mediaEdit),
      download_url: mediaEdit ? undefined : clip.download_url, auto_proof: mediaEdit ? undefined : clip.auto_proof, status: mediaEdit ? "draft" : clip.status,
    });
    return { ...clip, download_url: undefined };
  });
  return fail("This clip operation is unavailable.", 404);
}

export async function browserApi<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await routes(path, init) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "QuotaExceededError") throw new ApiError("Device storage is full. Clear some previews or free up disk space.", 507);
    throw error;
  }
}
