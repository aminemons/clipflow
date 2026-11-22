import { Zip, ZipPassThrough } from "fflate";
import type { Clip, Project } from "../editorTypes";
import { srt } from "../studio/model";
import { renderedCaptions, renderProject } from "./editing";

export async function zipFiles(files: { name: string; data: Blob | string }[], signal?: AbortSignal) {
  const parts: BlobPart[] = [];
  const archive = new Zip((error, data) => {
    if (error) throw error;
    parts.push(new Uint8Array(data));
  });
  try {
    for (const { name, data } of files) {
      signal?.throwIfAborted();
      const file = new ZipPassThrough(name);
      archive.add(file);
      if (typeof data === "string") {
        file.push(new TextEncoder().encode(data), true);
        continue;
      }
      const reader = data.stream().getReader();
      try {
        for (;;) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          file.push(value);
        }
        file.push(new Uint8Array(), true);
      } finally {
        await reader.cancel();
      }
    }
    archive.end();
    return new Blob(parts, { type: "application/zip" });
  } catch (error) {
    archive.terminate();
    throw error;
  }
}

const escapeXml = (text: string) => text.replace(/[<>&"'"]/g, value => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;", "'":"&apos;" })[value] ?? value);

export async function adobePackage(project: Project, clips: Clip[], source: Blob, sourceName: string) {
  const fps = Math.max(1, Math.round(project.fps || 30));
  const frame = (s: number) => Math.round(s * fps);
  const name = "source." + (sourceName.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "mp4");
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const trimmed = clips.flatMap(clip => renderProject(project, clip).cut.spans.map(span => ({ start: span.start, end: span.end, title: clip.title })));
  const placements = trimmed.reduce<{ start: number; end: number; sourceStart: number; sourceEnd: number; title: string }[]>((items, span) => {
    const start = items[items.length - 1]?.end ?? 0;
    items.push({ start, end: start + span.end - span.start, sourceStart: span.start, sourceEnd: span.end, title: span.title });
    return items;
  }, []);
  const track = (type: "video" | "audio") => placements.map((item, i) => {
    const file = type === "video" && i === 0 ? `<file id="file-1"><name>${name}</name><pathurl>file://localhost/media/${name}</pathurl>${rate}<duration>${frame(project.duration)}</duration><media><video><samplecharacteristics><width>${project.width}</width><height>${project.height}</height></samplecharacteristics></video><audio/></media></file>` : '<file id="file-1"/>';
    return `<clipitem id="${type}-${i + 1}"><name>${escapeXml(item.title)}</name><enabled>TRUE</enabled><duration>${frame(project.duration)}</duration>${rate}<start>${frame(item.start)}</start><end>${frame(item.end)}</end><in>${frame(item.sourceStart)}</in><out>${frame(item.sourceEnd)}</out>${file}<sourcetrack><mediatype>${type}</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>`;
  }).join("");
  let captionOffset = 0;
  const cues = clips.flatMap(clip => {
    const raw = renderedCaptions(project, clip);
    const speed = clip.playback_speed || 1;
    const result = raw.map(cue => ({...cue,start: cue.start * speed + captionOffset, end: cue.end * speed + captionOffset}));
    captionOffset += renderProject(project, clip).cut.spans.reduce((t, span) => t + span.end - span.start, 0);
    return result;
  });
  const duration = placements[placements.length - 1]?.end ?? 0;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE xmeml><xmeml version="5"><sequence id="sequence-1"><name>${escapeXml(project.title)}</name><duration>${frame(duration)}</duration>${rate}<media><video><format><samplecharacteristics>${rate}<width>${project.width}</width><height>${project.height}</height></samplecharacteristics></format><track>${track("video")}</track></video><audio><track>${track("audio")}</track></audio></media></sequence></xmeml>`;
  const jsx = `(function () {
  app.beginUndoGroup("Clipflow Handoff");
  try {
    var folder = new File($.fileName).parent;
    var imported = app.project.importFile(new ImportOptions(new File(folder.fsName + "/media/${name}")));
    var comp = app.project.items.addComp(${JSON.stringify(project.title)}, ${project.width}, ${project.height}, 1, ${Math.max(0.04, duration)}, ${fps});
    var ranges = ${JSON.stringify(placements)};
    for (var i=0; i<ranges.length; i++) {
      var row = ranges[i], layer = comp.layers.add(imported);
      layer.name = row.title;
      layer.startTime = row.start - row.sourceStart;
      layer.inPoint = row.start;
      layer.outPoint = row.end;
    }
    var captions = ${JSON.stringify(cues)};
    for (var j=0; j<captions.length; j++) {
      var cue = captions[j], text = comp.layers.addText(cue.text);
      text.inPoint = cue.start;
      text.outPoint = cue.end;
      text.property("ADBE Transform Group").property("ADBE Position").setValue([comp.width * 0.5, comp.height * 0.82]);
      var sourceText = text.property("ADBE Text Properties").property("ADBE Text Document");
      var style = sourceText.value;
      style.justification = ParagraphJustification.CENTER_JUSTIFY;
      sourceText.setValue(style);
    }
    comp.openInViewer();
  } finally { app.endUndoGroup(); }
})();`;
  return zipFiles([
    { name: "Premiere.xml", data: xml }, { name: "after-effects.jsx", data: jsx },
    { name: "captions.srt", data: srt(cues) }, { name: "clip-settings.json", data: JSON.stringify(clips, null, 2) },
    { name: "README.txt", data: "Extract the entire archive. Import Premiere.xml into Premiere and relink media/source if prompted. In After Effects, use File > Scripts > Run Script File and choose after-effects.jsx. These are editable source-speed trims and captions. Reapply your crop, speed and effects with clip-settings.json as reference." },
    { name: `media/${name}`, data: source },
  ]);
}
