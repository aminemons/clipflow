import type { TranscriptSegment } from "./TranscriptPanel";

export type Clip = {
  id: string;
  generation_id?: string;
  title: string;
  start: number;
  end: number;
  selected?: boolean;
  framing: "follow" | "manual" | "fit" | "blur";
  aspect_ratio?: "9:16" | "1:1" | "4:5" | "16:9";
  focus_x: number;
  camera_motion?: "steady" | "smooth" | "dynamic";
  camera_zoom?: number;
  camera_auto_zoom?: boolean;
  camera_strategy?: "adaptive" | "follow" | "manual";
  vision_provider?: "local" | "gemini";
  safe_framing?: "fit" | "blur";
  camera_dead_zone?: number;
  camera_keyframes?: { time: number; x: number; y: number; zoom: number }[];
  smoothing: number;
  caption_text: string;
  caption_style: "clean" | "bold" | "minimal";
  caption_color: string;
  caption_font?: "outfit" | "anton" | "noto-arabic";
  caption_size?: number;
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
  generation_settings?: import("./ClipSetup").ClipSetupSettings;
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
  updated_at?: string;
  favorite?: boolean;
  archived?: boolean;
  tags?: string[];
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
    highlights?: {
      provider?: string;
      groq_available?: boolean;
      available_providers?: string[];
    };
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
  highlight_provider:
    | "local"
    | "groq"
    | "openai"
    | "anthropic"
    | "gemini"
    | "ollama";
  groq_highlight_model: string;
  higgsfield_enabled: boolean;
  keys: Record<string, boolean>;
  openai_text_model?: string;
  anthropic_text_model?: string;
  gemini_text_model?: string;
  ollama_text_model?: string;
};

export type AnalysisOptions = {
  mode: "full" | "smart";
  targetDuration: number;
  tolerance: number;
  strictMax: number | null;
  maxClips: number;
  topic: string;
  useTranscript: boolean;
  provider: "local" | "groq" | "openai" | "anthropic" | "gemini" | "ollama";
};

export type TranscriptionOptions = {
  scope: "clip" | "source";
  quality: "fast" | "balanced" | "accurate";
  language: string;
  dialect: "none" | "algerian";
  prompt: string;
  force: boolean;
};
