import type { Clip } from "./editorTypes";

export type LibraryFilter =
  "all" | "pending" | "kept" | "exported" | "discarded";
export type LibraryPatch = Pick<
  Partial<Clip>,
  "selected" | "reviewed" | "suggestion_status"
>;

export function isSuggestion(clip: Clip) {
  return Boolean(clip.reason) || clip.score !== undefined;
}

export function isDiscarded(clip: Clip) {
  return clip.suggestion_status === "discarded";
}

export function matchesLibraryFilter(
  clip: Clip,
  filter: LibraryFilter,
  query: string,
) {
  if (!clip.title.toLowerCase().includes(query.trim().toLowerCase()))
    return false;
  if (filter === "discarded") return isDiscarded(clip);
  if (isDiscarded(clip)) return false;
  if (filter === "pending")
    return (
      isSuggestion(clip) &&
      (!clip.suggestion_status || clip.suggestion_status === "pending")
    );
  if (filter === "kept") return Boolean(clip.reviewed);
  if (filter === "exported") return clip.status === "exported";
  return true;
}

/** Keep/discard changes export selection too; mirror the API while saving. */
export function libraryPatch(patch: LibraryPatch): LibraryPatch {
  if (!patch.suggestion_status) return patch;
  return {
    ...patch,
    reviewed: patch.suggestion_status !== "pending",
    selected: patch.suggestion_status === "kept",
  };
}

export function exportClipIds(clips: Clip[]) {
  return clips
    .filter((clip) => clip.selected && !isDiscarded(clip))
    .map((clip) => clip.id);
}
