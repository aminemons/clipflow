import type { TranscriptSegment } from "./TranscriptPanel";

export type Clip = {
  id: string;
  title: string;
  start: number;
  end: number;
  selected?: boolean;
  framing: "follow" | "manual" | "fit";
  focus_x: number;
  smoothing: number;
  caption_text: string;
  caption_style: "clean" | "bold" | "minimal";
  caption_color: string;
  caption_position: "bottom" | "center";
  caption_x?: number;
  caption_y?: number;
  caption_enabled?: boolean;
  playback_speed?: number;
  audio_volume?: number;
  audio_denoise?: boolean;
  audio_fade?: number;
  transcript?: TranscriptSegment[];
  resolution: number;
  status: string;
  download_url?: string;
  revision?: number;
  reason?: string;
  score?: number;
  reviewed?: boolean;
  suggestion_status?: "pending" | "kept" | "discarded";
  subject?: "auto" | "left" | "right";
};

export type Project = {
  id: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  source_url?: string;
  thumbnail_url?: string;
  clips: Clip[];
  transcript?: { start: number; end: number; text: string }[];
  can_restore_clips?: boolean;
  created_at?: string;
  active_job_id?: string;
};

export type Job = {
  clip_titles?: string[];
  id: string;
  project_id?: string;
  kind?: string;
  created_at?: string;
  updated_at?: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  stage?: string;
  progress?: number;
  error?: string;
  warning?: string;
  download_url?: string;
};

export type Health = {
  ffmpeg?: boolean;
  ffprobe?: boolean;
  transcription?: boolean;
  configuration?: {
    transcription?: {
      provider?: string;
      available?: boolean;
      configured?: boolean;
      model?: string;
      message?: string;
    };
    highlights?: { provider?: string; groq_available?: boolean };
    higgsfield?: { configured?: boolean; message?: string };
  };
  storage?: { free_bytes?: number };
};

export type ProviderSettings = {
  transcription_provider: "local" | "groq";
  whisper_model:
    | ""
    | "tiny"
    | "base"
    | "small"
    | "medium"
    | "large-v3"
    | "large-v3-turbo";
  highlight_provider: "local" | "groq";
  groq_highlight_model: string;
  higgsfield_enabled: boolean;
  keys: { GROQ_API_KEY: boolean; HF_API_KEY: boolean; HF_API_SECRET: boolean };
};

export type AnalysisOptions = {
  mode: "full" | "smart";
  targetDuration: number;
  tolerance: number;
  strictMax: number | null;
  maxClips: number;
  topic: string;
  useTranscript: boolean;
  provider: "local" | "groq";
};

export type TranscriptionOptions = {
  scope: "clip" | "source";
  quality: "fast" | "balanced" | "accurate";
  language: string;
  dialect: "none" | "algerian";
  prompt: string;
  force: boolean;
};
