import {
  ALL_FORMATS, AudioSample, AudioSampleSink, BlobSource, BufferTarget, CanvasSink, CanvasSource,
  Input, Mp4OutputFormat, Output, WebMOutputFormat, AudioSampleSource, canEncodeAudio, canEncodeVideo,
  type InputAudioTrack,
} from "mediabunny";
import { canvasSize, loadStudioFonts, paint } from "./compositor";
import { clamp, clipCues, lengthOf, type Project } from "./model";

const inputFor = (source: Blob) => new Input({ formats: ALL_FORMATS, source: new BlobSource(source) });

export async function probe(source: Blob) {
  const video = document.createElement("video");
  const url = URL.createObjectURL(source);
  try {
    return await new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The browser could not read this video in time.")), 15_000);
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        const { duration, videoWidth: width, videoHeight: height } = video;
        if (!Number.isFinite(duration) || duration < 0.05 || duration > 86_400 || !width || !height) reject(new Error("Choose a playable video under 24 hours long."));
        else resolve({ duration, width, height });
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("This video codec cannot be played here. Try an H.264 MP4 or a VP9 WebM."));
      };
      video.preload = "metadata";
      video.src = url;
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

const throwIfStopped = (signal?: AbortSignal) => signal?.throwIfAborted();

export async function waveform(source: Blob, duration: number, signal: AbortSignal) {
  const input = inputFor(source);
  const levels = Array.from({ length: 112 }, () => 0);
  try {
    const audio = await input.getPrimaryAudioTrack();
    if (!audio || !await audio.canDecode() || duration > 900) return [];
    for await (const sample of new AudioSampleSink(audio).samples(0, duration)) {
      try {
        throwIfStopped(signal);
        const index = clamp(Math.floor(sample.timestamp / duration * levels.length), 0, levels.length - 1);
        const channel = new Float32Array(sample.numberOfFrames);
        sample.copyTo(channel, { format: "f32-planar", planeIndex: 0 });
        let power = 0;
        for (let i = 0; i < channel.length; i += 8) power += channel[i] * channel[i];
        levels[index] = Math.max(levels[index], Math.sqrt(power / Math.ceil(channel.length / 8)));
      } finally {
        sample.close();
      }
    }
    const high = Math.max(0.1, ...levels);
    return levels.map(level => Math.min(1, (level / high) ** 0.58));
  } finally {
    input.dispose();
  }
}

export function audioGain(project: Project, time: number, total: number) {
  const fade = project.cut.fade ? clamp(Math.min(time / 0.10, (total - time) / 0.16), 0, 1) : 1;
  return project.cut.volume / 100 * fade;
}

async function encodeAudio(track: InputAudioTrack, source: AudioSampleSource, project: Project, signal: AbortSignal) {
  const sink = new AudioSampleSink(track);
  const total = lengthOf(project.cut.spans);
  let offset = 0;
  let writtenEnd = 0;
  for (const span of project.cut.spans) {
    for await (const sample of sink.samples(span.start, span.end)) {
      try {
        throwIfStopped(signal);
        const from = Math.max(0, Math.ceil((span.start - sample.timestamp) * sample.sampleRate - 1e-6));
        const to = Math.min(sample.numberOfFrames, Math.floor((span.end - sample.timestamp) * sample.sampleRate + 1e-6));
        if (to <= from) continue;
        const timestamp = Math.max(writtenEnd, offset + sample.timestamp + from / sample.sampleRate - span.start);
        const data = new Float32Array((to - from) * sample.numberOfChannels);
        sample.copyTo(data, { format: "f32", planeIndex: 0, frameOffset: from, frameCount: to - from });
        for (let frame = 0; frame < to - from; frame++) {
          const gain = audioGain(project, timestamp + frame / sample.sampleRate, total);
          for (let ch = 0; ch < sample.numberOfChannels; ch++) {
            const index = frame * sample.numberOfChannels + ch;
            data[index] = clamp(data[index] * gain, -1, 1);
          }
        }
        const segment = new AudioSample({ data, format: "f32", timestamp, numberOfChannels: sample.numberOfChannels, sampleRate: sample.sampleRate });
        try {
          await source.add(segment);
          writtenEnd = timestamp + segment.duration;
        } finally {
          segment.close();
        }
      } finally {
        sample.close();
      }
    }
    offset += span.end - span.start;
  }
  source.close();
}

export async function renderClip(
  media: Blob, project: Project, quality: 720 | 1080, signal: AbortSignal,
  onProgress: (progress: number) => void, preferred: "auto" | "webm",
) {
  const input = inputFor(media);
  const internal = new AbortController();
  const cancel = () => internal.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  let output: Output | undefined;
  try {
    const outputSize = canvasSize(project, quality);
    const { width, height } = outputSize;
    const [videoTrack, audioTrack] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(), loadStudioFonts()]);
    throwIfStopped(signal);
    if (!videoTrack || !await videoTrack.canDecode()) throw new Error("This browser can play the footage but cannot decode it for export. Try Chrome or Edge and an H.264 MP4.");
    if (audioTrack && project.cut.volume > 0 && !await audioTrack.canDecode()) throw new Error("The source audio codec cannot be decoded here. Convert the source to H.264/AAC or set clip volume to zero.");
    const exportAudio = audioTrack && project.cut.volume > 0 ? audioTrack : null;
    const sampleRate = exportAudio ? await exportAudio.getSampleRate() : 48000;
    const numberOfChannels = exportAudio ? await exportAudio.getNumberOfChannels() : 2;
    const fps = 30;
    const bitrate = quality === 1080 ? 6_000_000 : 3_200_000;
    const videoOptions = { width, height, bitrate, frameRate: fps };
    const audioOptions = { sampleRate, numberOfChannels, bitrate: 128_000 };
    const mp4 = preferred !== "webm" && await canEncodeVideo("avc", videoOptions) && (!exportAudio || await canEncodeAudio("aac", audioOptions));
    if (!mp4 && (!await canEncodeVideo("vp9", videoOptions) || (exportAudio && !await canEncodeAudio("opus", audioOptions)))) {
      throw new Error("This browser does not offer an encoder for this video and audio combination. Try current Chrome or Edge.");
    }
    const target = new BufferTarget();
    output = new Output({ format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(), target });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("The browser could not create the video canvas.");
    const videoSource = new CanvasSource(canvas, { codec: mp4 ? "avc" : "vp9", bitrate });
    output.addVideoTrack(videoSource, { frameRate: fps });
    const audioSource = exportAudio ? new AudioSampleSource({ codec: mp4 ? "aac" : "opus", bitrate: 128_000 }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    const activeOutput = output;
    const cues = clipCues(project);
    const total = lengthOf(project.cut.spans);
    const sink = new CanvasSink(videoTrack, { width: Math.min(1920, project.width), poolSize: 2 });
    const videoWork = async () => {
      let offset = 0;
      let frameIndex = 0;
      let lastReport = 0;
      for (const span of project.cut.spans) {
        const nextOffset = offset + span.end - span.start;
        const startIndex = frameIndex;
        const stopIndex = Math.ceil(nextOffset * fps - 1e-5);
        const times = Array.from({ length: stopIndex - startIndex }, (_, index) => span.start + Math.max(0, (startIndex + index) / fps - offset));
        for await (const frame of sink.canvasesAtTimestamps(times)) {
          throwIfStopped(internal.signal);
          const time = frameIndex / fps;
          if (frame) {
            const image = frame.canvas;
            paint(ctx, { width: image.width, height: image.height, draw: (context, x, y, w, h) => context.drawImage(image, x, y, w, h) }, project, time, cues, false, false, total);
          } else if (frameIndex === 0) {
            ctx.fillStyle = "#171f19";
            ctx.fillRect(0, 0, width, height);
          }
          await videoSource.add(time, Math.min(1 / fps, total - time), { keyFrame: frameIndex === startIndex });
          frameIndex++;
          const now = performance.now();
          if (now - lastReport > 120) {
            lastReport = now;
            onProgress(Math.min(0.96, time / total * 0.96));
          }
        }
        offset = nextOffset;
      }
      videoSource.close();
    };
    const stopWork = async (error: unknown) => {
      internal.abort(error);
      await activeOutput.cancel().catch(() => undefined);
      throw error;
    };
    const results = await Promise.allSettled([
      videoWork().catch(stopWork),
      exportAudio && audioSource ? encodeAudio(exportAudio, audioSource, project, internal.signal).catch(stopWork) : Promise.resolve(),
    ]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    throwIfStopped(signal);
    await output.finalize();
    if (!target.buffer) throw new Error("The encoder returned an empty file.");
    onProgress(1);
    return { data: new Blob([target.buffer], { type: mp4 ? "video/mp4" : "video/webm" }), extension: mp4 ? "mp4" : "webm" };
  } catch (error) {
    await output?.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    input.dispose();
  }
}

export async function* audioChunks(media: Blob, duration: number, signal: AbortSignal) {
  const input = inputFor(media);
  const rate = 16_000;
  const chunkSeconds = 48;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !await track.canDecode()) throw new Error("There is no decodable audio track. You can still import an SRT or VTT transcript.");
    const sink = new AudioSampleSink(track);
    for (let start = 0; start < duration; start += chunkSeconds) {
      throwIfStopped(signal);
      const end = Math.min(duration, start + chunkSeconds);
      const count = Math.ceil((end - start) * rate);
      const result = new Int16Array(count);
      let strength = 0;
      for await (const sample of sink.samples(start, end)) {
        try {
          throwIfStopped(signal);
          const left = new Float32Array(sample.numberOfFrames);
          sample.copyTo(left, { format: "f32-planar", planeIndex: 0 });
          const first = Math.max(0, Math.ceil((sample.timestamp - start) * rate));
          const last = Math.min(count, Math.ceil((sample.timestamp + sample.duration - start) * rate));
          for (let j = first; j < last; j++) {
            const position = (start + j / rate - sample.timestamp) * sample.sampleRate;
            const index = clamp(Math.floor(position), 0, left.length - 1);
            const value = left[index];
            strength = Math.max(strength, Math.abs(value));
            result[j] = Math.round(clamp(value, -1, 1) * 32767);
          }
        } finally {
          sample.close();
        }
      }
      if (strength < 0.008) continue;
      const wave = new DataView(new ArrayBuffer(44));
      const label = (offset: number, text: string) => [...text].forEach((character, i) => wave.setUint8(offset + i, character.charCodeAt(0)));
      label(0, "RIFF"); wave.setUint32(4, 36 + count * 2, true); label(8, "WAVE"); label(12, "fmt ");
      wave.setUint32(16, 16, true); wave.setUint16(20, 1, true); wave.setUint16(22, 1, true);
      wave.setUint32(24, rate, true); wave.setUint32(28, rate * 2, true);
      wave.setUint16(32, 2, true); wave.setUint16(34, 16, true); label(36, "data"); wave.setUint32(40, count * 2, true);
      yield { start, end, file: new Blob([wave.buffer, result], { type: "audio/wav" }) };
    }
  } finally {
    input.dispose();
  }
}
