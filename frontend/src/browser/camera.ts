import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import type { Clip } from "../editorTypes";

type Keyframe = NonNullable<Clip["camera_keyframes"]>[number];
type FaceBox = { boundingBox: DOMRectReadOnly };
type BrowserDetector = { detect: (canvas: HTMLCanvasElement | OffscreenCanvas) => Promise<FaceBox[]> };
const bound = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));

/** Track a face when exposed by the browser, otherwise follow persistent motion. */
export async function browserCamera(source: Blob, clip: Clip, signal: AbortSignal): Promise<Keyframe[]> {
  if (clip.framing !== "follow" || clip.camera_strategy === "manual" || clip.camera_keyframes?.length) return [];
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source) });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !await video.canDecode()) return [];
    const candidate = (window as Window & { FaceDetector?: new (options: { fastMode: boolean; maxDetectedFaces: number }) => BrowserDetector }).FaceDetector;
    let detector: BrowserDetector | undefined;
    try { if (candidate) detector = new candidate({ fastMode: true, maxDetectedFaces: 4 }); } catch { /* Motion remains available. */ }
    const sink = new CanvasSink(video, { width: 112, poolSize: 2 });
    const count = bound(Math.ceil((clip.end - clip.start) / 0.7) + 1, 2, 150);
    const times = Array.from({ length: count }, (_, i) => clip.start + (clip.end - clip.start - 0.008) * i / (count - 1));
    const result: Keyframe[] = [];
    const easing = clip.camera_motion === "dynamic" ? 0.62 : clip.camera_motion === "steady" ? 0.20 : 0.38;
    const deadZone = clip.camera_dead_zone ?? 0.08;
    let previous: Uint8ClampedArray | undefined;
    const initial = clip.subject === "left" ? 0.22 : clip.subject === "right" ? 0.78 : clip.focus_x;
    let x = initial;
    let zoom = clip.camera_zoom ?? 1;
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      signal.throwIfAborted();
      if (!frame) continue;
      const { canvas } = frame;
      const context = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
      if (!context) continue;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let faces: FaceBox[] = [];
      if (detector) {
        try { faces = await detector.detect(canvas); } catch { detector = undefined; }
      }
      const pick = faces.filter(({ boundingBox: box }) => clip.subject === "left" ? box.x + box.width / 2 <= canvas.width / 2 :
        clip.subject === "right" ? box.x + box.width / 2 >= canvas.width / 2 : true)
        .sort((a, b) => b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0]?.boundingBox;
      let goal = x;
      if (pick) {
        goal = (pick.x + pick.width / 2) / canvas.width;
        if (clip.camera_auto_zoom) zoom += (bound(canvas.height * 0.24 / pick.height, 1, 1.5) - zoom) * easing;
      } else if (previous?.length === data.length) {
        let weight = 0;
        let center = 0;
        let points = 0;
        for (let y = Math.ceil(canvas.height * 0.10); y < canvas.height * 0.82; y += 2) {
          for (let column = 2; column < canvas.width - 2; column += 2) {
            if ((clip.subject === "left" && column > canvas.width * 0.56) || (clip.subject === "right" && column < canvas.width * 0.44)) continue;
            const index = (y * canvas.width + column) * 4;
            const difference = Math.max(0, Math.abs(data[index + 1] - previous[index + 1]) - 14);
            center += column / canvas.width * difference;
            weight += difference;
            points++;
          }
        }
        if (weight > points * 0.9 && weight < points * 36) goal = center / weight;
      }
      previous = data;
      if (Math.abs(goal - x) > deadZone) x += (goal - x) * easing;
      result.push({ time: frame.timestamp, x: bound(x, 0, 1), y: 0.5, zoom });
    }
    return result;
  } finally {
    input.dispose();
  }
}
