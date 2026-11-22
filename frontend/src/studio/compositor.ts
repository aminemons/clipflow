import { clamp, destinationFor, lengthOf, type Graphic, type Project } from "./model";
import type { SubtitleSegment } from "../subtitleImport";

export type Surface = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Frame = {
  width: number; height: number;
  draw: (ctx: Surface, x: number, y: number, width: number, height: number) => void;
};

export function videoFrame(video: HTMLVideoElement): Frame {
  return {
    width: video.videoWidth, height: video.videoHeight,
    draw: (ctx, x, y, w, h) => ctx.drawImage(video, x, y, w, h),
  };
}

export function canvasSize(project: Project, quality: 360 | 720 | 1080) {
  const ratio = destinationFor(project.destination).ratio;
  if (ratio === "16:9") return { width: Math.round(quality * 16 / 18) * 2, height: quality };
  if (ratio === "1:1") return { width: quality, height: quality };
  return { width: quality, height: Math.round(quality * 16 / 18) * 2 };
}

function box(ctx: Surface, x: number, y: number, w: number, h: number, radius: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}

function textLines(ctx: Surface, text: string, max: number, limit: number) {
  const pieces = text.trim().split(/\s+/).flatMap(word => {
    if (ctx.measureText(word).width <= max) return [word];
    const parts: string[] = [];
    let chunk = "";
    for (const character of word) {
      if (chunk && ctx.measureText(chunk + character).width > max) {
        parts.push(chunk);
        chunk = "";
      }
      chunk += character;
    }
    return [...parts, chunk];
  });
  const lines: string[] = [];
  let line = "";
  for (const piece of pieces) {
    const next = line ? `${line} ${piece}` : piece;
    if (line && ctx.measureText(next).width > max) {
      lines.push(line);
      line = piece;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > limit) {
    lines.length = limit;
    let finish = lines[limit - 1];
    while (finish.length && ctx.measureText(finish + "…").width > max) finish = finish.slice(0, -1);
    lines[limit - 1] = finish + "…";
  }
  return lines;
}

const face = '"Outfit", "Noto Studio Arabic", "Segoe UI", sans-serif';
const strong = '"Anton", "Noto Studio Arabic", "Segoe UI", sans-serif';

function graphicText(ctx: Surface, text: string, x: number, y: number, max: number, size: number, color: string, weight = 700) {
  ctx.font = `${weight} ${size}px ${face}`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = textLines(ctx, text, max, 3);
  lines.forEach((line, i) => ctx.fillText(line, x, y + (i - (lines.length - 1) / 2) * size * 1.04));
}

function paintGraphic(ctx: Surface, graphic: Graphic, t: number, project: Project, w: number, h: number, cutDuration: number) {
  const u = Math.min(w, h);
  const accent = project.cut.accent;
  const local = t - graphic.start;
  const intro = 1 - (1 - clamp(local / 0.42, 0, 1)) ** 3;
  const outro = clamp((graphic.duration - local) / 0.25, 0, 1);
  ctx.save();
  ctx.globalAlpha = Math.min(1, intro + 0.1) * outro;
  if (graphic.style === "flash") {
    ctx.globalAlpha = Math.sin(Math.PI * clamp(local / Math.min(graphic.duration, 0.55), 0, 1)) * 0.86;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  } else if (graphic.style === "progress") {
    const inset = u * 0.07;
    box(ctx, inset, h * 0.085, w - inset * 2, u * 0.013, u * 0.008, "#ffffff56");
    box(ctx, inset, h * 0.085, Math.max(1, (w - inset * 2) * t / cutDuration), u * 0.013, u * 0.008, accent);
    graphicText(ctx, graphic.text, w / 2, h * 0.125, w * 0.76, u * 0.035, "#ffffff");
  } else if (graphic.style === "chapter") {
    ctx.fillStyle = "#18221a";
    ctx.fillRect(0, 0, w, h);
    box(ctx, w * 0.40, h * 0.35, w * 0.20 * intro, u * 0.012, 4, accent);
    graphicText(ctx, graphic.text, w / 2, h * 0.48, w * 0.75, u * 0.088, "#f6f7ee", 800);
  } else if (graphic.style === "speaker") {
    const x = u * 0.08 - (1 - intro) * w * 0.46;
    box(ctx, x, h * 0.60, w * 0.67, u * 0.16, u * 0.025, "#17221de8");
    box(ctx, x, h * 0.60, u * 0.013, u * 0.16, 2, accent);
    graphicText(ctx, graphic.text, x + w * 0.334, h * 0.60 + u * 0.082, w * 0.57, u * 0.045, "#ffffff");
  } else if (graphic.style === "metric") {
    ctx.translate(w / 2, h * 0.34);
    const scale = 0.58 + 0.42 * intro + Math.sin(intro * Math.PI) * 0.15;
    ctx.scale(scale, scale);
    ctx.shadowColor = "#101711a8";
    ctx.shadowBlur = u * 0.06;
    graphicText(ctx, graphic.text, 0, 0, w * 0.70, u * 0.17, accent, 900);
  } else if (graphic.style === "cta" || graphic.style === "callout") {
    const center = h * (graphic.style === "cta" ? 0.52 : 0.35) + (1 - intro) * u * 0.12;
    box(ctx, w * 0.12, center - u * 0.10, w * 0.76, u * 0.20, u * (graphic.style === "cta" ? 0.08 : 0.025), accent);
    graphicText(ctx, graphic.text, w / 2, center, w * 0.66, u * 0.053, "#141b11", 800);
  } else if (graphic.style === "quote") {
    const center = h * 0.32;
    box(ctx, w * 0.09, center - u * 0.12, w * 0.82, u * 0.31, u * 0.035, "#17221deb");
    graphicText(ctx, "“", w * 0.18, center - u * 0.035, u * 0.16, u * 0.12, accent);
    graphicText(ctx, graphic.text, w * 0.55, center + u * 0.025, w * 0.59, u * 0.055, "#f8f8f1");
  } else if (graphic.style === "type" || graphic.style === "opening") {
    const y = h * 0.31;
    const count = Math.max(1, Math.ceil(Array.from(graphic.text).length * clamp(local / Math.min(1.55, graphic.duration * 0.72), 0, 1)));
    const display = graphic.style === "type" ? Array.from(graphic.text).slice(0, count).join("") + (count < Array.from(graphic.text).length ? "▍" : "") : graphic.text;
    const gradient = ctx.createLinearGradient(0, y - u * 0.22, 0, y + u * 0.24);
    gradient.addColorStop(0, "#0b150e00");
    gradient.addColorStop(0.45, "#0a130e9c");
    gradient.addColorStop(1, "#0b150e00");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, y - u * 0.22, w, u * 0.46);
    if (graphic.style === "opening") {
      ctx.beginPath();
      ctx.rect(w * 0.06, y - u * 0.20, w * 0.88 * intro, u * 0.40);
      ctx.clip();
    }
    graphicText(ctx, display, w / 2, y, w * 0.81, u * 0.079, "#ffffff", 800);
    box(ctx, w * 0.43, y + u * 0.125, w * 0.14 * intro, u * 0.012, u * 0.005, accent);
  }
  ctx.restore();
}

function paintCaption(ctx: Surface, cue: SubtitleSegment, time: number, project: Project, w: number, h: number) {
  const { captionStyle: style, captionSize, accent } = project.cut;
  const safe = destinationFor(project.destination);
  const u = Math.min(w, h);
  const baseSize = u * (style === "Bold" ? 0.069 : 0.059) * captionSize / 100;
  const limit = w * (1 - safe.safeRight - 0.10);
  ctx.font = `${style === "Bold" ? 400 : 700} ${baseSize}px ${style === "Bold" ? strong : face}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = style === "Bold" ? cue.text.toLocaleUpperCase() : cue.text;
  const words = text.trim().split(/\s+/);
  const allowance = Math.max(3, Math.floor(7 * 100 / captionSize));
  const pageCount = Math.ceil(words.length / allowance);
  const fraction = clamp((time - cue.start) / (cue.end - cue.start), 0, 0.999);
  const page = Math.floor(fraction * pageCount);
  const lines = textLines(ctx, words.slice(page * allowance, (page + 1) * allowance).join(" "), limit, 3);
  const lineHeight = baseSize * 1.19;
  const x = w * (0.50 - (safe.safeRight - 0.08) / 2);
  const y = h * (1 - safe.safeBottom) - (lines.length - 0.5) * lineHeight;
  if (style === "Editorial") box(ctx, x - u * 0.035, y - baseSize * 0.78, u * 0.07, u * 0.009, 2, accent);
  for (const [index, line] of lines.entries()) {
    const row = y + index * lineHeight;
    const textWidth = ctx.measureText(line).width;
    if (style === "Boxed" || style === "Highlight") {
      box(ctx, x - textWidth / 2 - u * 0.023, row - lineHeight * 0.48, textWidth + u * 0.046, lineHeight * 0.96, u * 0.015, style === "Boxed" ? "#111713e8" : accent);
    } else {
      ctx.lineWidth = u * 0.012;
      ctx.strokeStyle = "#0e150ede";
      ctx.lineJoin = "round";
      ctx.strokeText(line, x, row);
    }
    ctx.fillStyle = style === "Highlight" ? "#10170b" : "#ffffff";
    ctx.fillText(line, x, row);
  }
}

export function paint(ctx: Surface, frame: Frame, project: Project, time: number, cues: SubtitleSegment[], guides = false, source = false, cutDuration = lengthOf(project.cut.spans)) {
  const { width: w, height: h } = ctx.canvas;
  const cut = project.cut;
  const graphics = source ? [] : cut.graphics.filter(item => time >= item.start && time < item.start + item.duration);
  const punch = graphics.find(item => item.style === "zoom");
  const animatedZoom = punch ? 1 + Math.sin(Math.PI * clamp((time - punch.start) / punch.duration, 0, 1)) * 0.22 : 1;
  const place = (scale: number, focus: number) => {
    const dw = frame.width * scale;
    const dh = frame.height * scale;
    frame.draw(ctx, dw > w ? (w - dw) * focus : (w - dw) / 2, (h - dh) / 2, dw, dh);
  };
  ctx.save();
  ctx.fillStyle = "#171f19";
  ctx.fillRect(0, 0, w, h);
  const fill = Math.max(w / frame.width, h / frame.height);
  const fit = Math.min(w / frame.width, h / frame.height);
  if (!source && cut.frame === "blur") {
    ctx.filter = `blur(${Math.min(w, h) * 0.035}px) brightness(0.57)`;
    place(fill * 1.14, cut.focus / 100);
    ctx.filter = "none";
  }
  place(source ? fit : (cut.frame === "fill" ? fill : fit) * cut.zoom / 100 * animatedZoom, source ? 0.5 : cut.focus / 100);
  for (const graphic of graphics) {
    if (graphic.style !== "zoom") paintGraphic(ctx, graphic, time, project, w, h, cutDuration);
  }
  if (!source && cut.captions) {
    const cue = cues.find(item => time >= item.start && time < item.end);
    if (cue) paintCaption(ctx, cue, time, project, w, h);
  }
  if (!source && guides) {
    const safe = destinationFor(project.destination);
    ctx.strokeStyle = "#e8ffa8bd";
    ctx.lineWidth = Math.max(1, w / 360);
    ctx.setLineDash([w * 0.015, w * 0.012]);
    ctx.strokeRect(w * 0.08, h * 0.085, w * (0.92 - safe.safeRight), h * (0.915 - safe.safeBottom));
  }
  ctx.restore();
}

export async function loadStudioFonts() {
  if (typeof document !== "undefined") {
    await Promise.allSettled(['700 24px "Outfit"', '24px "Anton"', '24px "Noto Studio Arabic"'].map(font => document.fonts.load(font)));
  }
}
