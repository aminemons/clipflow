/** Read SRT/WebVTT cues into source-time segments without changing their text. */

export type SubtitleSegment = {
  start: number;
  end: number;
  text: string;
};

const MAX_SEGMENTS = 10_000;
const MAX_CUE_LINES = 20;
const MAX_LINE_LENGTH = 10_000;

function parseTimestamp(raw: string) {
  const value = raw.trim().replace(",", ".");
  const match = /^(?:(\d+):)?(\d{2}):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) {
    throw new Error("A subtitle has an invalid timestamp.");
  }

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (match[1] && minutes >= 60)
    throw new Error("A subtitle has an invalid timestamp.");
  const milliseconds = match[4] ? Number(match[4].padEnd(3, "0")) : 0;
  const result = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;

  if (!Number.isFinite(result)) {
    throw new Error("A subtitle has an invalid timestamp.");
  }
  return result;
}

function isBlockHeader(line: string) {
  return /^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(line);
}

function cleanCueText(lines: string[]) {
  return lines
    .join(" ")
    .replace(/<[^>]*>/g, "")
    .trim();
}

export function parseSubtitles(
  text: string,
  duration: number,
): SubtitleSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The source video has an invalid duration.");
  }

  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split("\n");
  const segments: SubtitleSegment[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > MAX_LINE_LENGTH) {
      throw new Error("This subtitle file has an excessively long line.");
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // WebVTT metadata and NOTE comments run until the next blank line. They
    // may contain arrows, so skip the whole block before looking for cues.
    if (trimmed === "WEBVTT" || isBlockHeader(trimmed)) {
      while (index + 1 < lines.length && lines[index + 1].trim()) {
        index += 1;
        if (lines[index].length > MAX_LINE_LENGTH) {
          throw new Error("This subtitle file has an excessively long line.");
        }
      }
      continue;
    }

    if (!trimmed.includes("-->")) continue;
    if ((trimmed.match(/-->/g) ?? []).length !== 1) {
      throw new Error("A subtitle has an invalid time range.");
    }

    const [from, rawTo] = trimmed.split("-->");
    const start = parseTimestamp(from);
    const endToken = rawTo.trim().split(/\s+/)[0];
    const end = parseTimestamp(endToken);
    if (end <= start) {
      throw new Error("Each subtitle must end after it starts.");
    }

    const body: string[] = [];
    while (index + 1 < lines.length && lines[index + 1].trim()) {
      index += 1;
      if (lines[index].length > MAX_LINE_LENGTH) {
        throw new Error("This subtitle file has an excessively long line.");
      }
      body.push(lines[index]);
      if (body.length > MAX_CUE_LINES) {
        throw new Error("A subtitle has too many text lines.");
      }
    }

    if (start >= duration) continue;
    const clean = cleanCueText(body);
    if (!clean) continue;

    segments.push({
      start: Math.round(start * 1000) / 1000,
      end: Math.min(duration, Math.round(end * 1000) / 1000),
      text: clean,
    });
    if (segments.length > MAX_SEGMENTS) {
      throw new Error("This file has too many subtitle segments.");
    }
  }

  if (!segments.length) {
    throw new Error(
      "No subtitles match this source. Use an SRT or VTT file with source-video timestamps.",
    );
  }
  return segments.sort((a, b) => a.start - b.start);
}
