import { captionStyles, destinations, goals, makeId, motions, type Project } from "./model";

type DatabaseStore = "projects" | "media";
const databaseName = "clipflow-local-studio";

function connect(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("projects", { keyPath: "id" });
      request.result.createObjectStore("media");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(stores: DatabaseStore[], mode: IDBTransactionMode, action: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> {
  const db = await connect();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const request = action(tx);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error("The local save was interrupted."));
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error("Local storage is unavailable."));
    });
  } finally {
    db.close();
  }
}

export const projects = () => run<Project[]>(["projects"], "readonly", tx => tx.objectStore("projects").getAll());
export const readMedia = (id: string) => run<Blob | undefined>(["media"], "readonly", tx => tx.objectStore("media").get(id));
export const saveEdit = (project: Project) => run<IDBValidKey>(["projects"], "readwrite", tx => tx.objectStore("projects").put(project));
export const saveProject = (project: Project, media: Blob) => run<IDBValidKey>(["projects", "media"], "readwrite", tx => {
  tx.objectStore("media").put(media, project.id);
  return tx.objectStore("projects").put(project);
});
export const removeProject = (id: string) => run<undefined>(["projects", "media"], "readwrite", tx => {
  tx.objectStore("media").delete(id);
  return tx.objectStore("projects").delete(id);
});

const magic = "CLIPFLOW1\n";
const maxMetadata = 12 * 1024 * 1024;

export function projectFile(project: Project, media: Blob) {
  const json = new TextEncoder().encode(JSON.stringify(project));
  if (json.byteLength > maxMetadata) throw new Error("This project has too much metadata to back up.");
  const header = new TextEncoder().encode(magic + String(json.byteLength).padStart(8, "0") + "\n");
  return new Blob([header, json, media], { type: "application/octet-stream" });
}

function validateProject(p: Project) {
  const number = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  const string = (value: string, max: number) => typeof value === "string" && value.length <= max;
  const sourceRange = (value: { start: number; end: number }) => value && number(value.start, 0, p.duration) && number(value.end, 0, p.duration) && value.end > value.start;
  return p && string(p.title, 300) && string(p.sourceName, 500) && string(p.sourceType, 100)
    && number(p.duration, 0.05, 86400) && number(p.width, 1, 16384) && number(p.height, 1, 16384)
    && destinations.some(item => item.id === p.destination) && goals.includes(p.goal)
    && number(p.target, 5, 120) && string(p.subject, 500) && string(p.notes, 4000)
    && typeof p.approved === "boolean" && typeof p.demo === "boolean"
    && Array.isArray(p.transcript) && p.transcript.length <= 10000
    && p.transcript.every(cue => sourceRange(cue) && string(cue.text, 12000))
    && Array.isArray(p.candidates) && p.candidates.length <= 30
    && p.candidates.every(item => sourceRange(item) && string(item.id, 100) && string(item.title, 300) && string(item.reason, 600) && string(item.hook, 500))
    && p.cut && Array.isArray(p.cut.spans) && p.cut.spans.length > 0 && p.cut.spans.length <= 100
    && p.cut.spans.every(span => sourceRange(span) && string(span.id, 100))
    && Array.isArray(p.cut.graphics) && p.cut.graphics.length <= 30
    && p.cut.graphics.every(item => item && string(item.id, 100) && motions.some(motion => motion.id === item.style)
      && number(item.start, 0, 86400) && number(item.duration, 0.12, 86400) && string(item.text, 160))
    && typeof p.cut.captions === "boolean" && typeof p.cut.fade === "boolean" && captionStyles.includes(p.cut.captionStyle)
    && number(p.cut.captionSize, 70, 145) && /^#[0-9a-f]{6}$/i.test(p.cut.accent) && ["fill", "fit", "blur"].includes(p.cut.frame)
    && number(p.cut.focus, 0, 100) && number(p.cut.zoom, 100, 180) && number(p.cut.volume, 0, 150);
}

export async function openProjectFile(file: Blob) {
  const headerSize = magic.length + 9;
  const header = await file.slice(0, headerSize).text();
  if (!header.startsWith(magic) || !/^\d{8}\n$/.test(header.slice(magic.length))) throw new Error("Choose a .clipflow backup made by this editor.");
  const metadataSize = Number(header.slice(magic.length));
  if (metadataSize <= 0 || metadataSize > maxMetadata || headerSize + metadataSize >= file.size) throw new Error("This project backup is incomplete.");
  const project = JSON.parse(await file.slice(headerSize, headerSize + metadataSize).text()) as Project;
  if (!validateProject(project)) throw new Error("The project settings in this backup are unsupported.");
  const media = file.slice(headerSize + metadataSize, file.size, project.sourceType);
  return { project: { ...project, id: makeId(), updated: Date.now() }, media };
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
