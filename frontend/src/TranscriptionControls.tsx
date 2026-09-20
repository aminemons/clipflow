import { useEffect, useRef, useState } from "react";
import { Mic2, Settings2 } from "lucide-react";
import "./TranscriptionControls.css";

export type TranscriptionRequest = {
  scope: "clip" | "source";
  quality: "fast" | "balanced" | "accurate";
  language: string;
  dialect: "none" | "algerian";
  prompt: string;
  force: boolean;
};
type Props = {
  projectId: string;
  clipId?: string;
  clipDuration: number;
  sourceDuration: number;
  busy: boolean;
  available?: boolean;
  settingsOpen?: boolean;
  hasTranscript: boolean;
  onTranscribe: (options: TranscriptionRequest) => Promise<void>;
  onOpenSettings: () => void;
};
const durationLabel = (seconds: number) =>
  seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;

export default function TranscriptionControls({
  projectId,
  clipId,
  clipDuration,
  sourceDuration,
  busy,
  available = true,
  settingsOpen = false,
  hasTranscript,
  onTranscribe,
  onOpenSettings,
}: Props) {
  const [scope, setScope] = useState<"clip" | "source">("clip");
  const [quality, setQuality] =
    useState<TranscriptionRequest["quality"]>("balanced");
  const [language, setLanguage] = useState("auto");
  const [dialect, setDialect] = useState<"none" | "algerian">("none");
  const [prompt, setPrompt] = useState("");
  const [force, setForce] = useState(false);
  const [provider, setProvider] = useState("local");
  const [error, setError] = useState("");
  const initialized = useRef<string | null>(null);
  useEffect(() => {
    fetch("/api/settings")
      .then((response) => (response.ok ? response.json() : null))
      .then((settings) => {
        if (!settings) return;
        setProvider(settings.transcription_provider);
        if (initialized.current === projectId) return;
        initialized.current = projectId;
        setQuality(settings.transcription_quality || "balanced");
        setLanguage(settings.transcription_language || "auto");
        setDialect(settings.transcription_dialect || "none");
        setPrompt(settings.transcription_prompt || "");
      })
      .catch(() => undefined);
  }, [projectId, busy, settingsOpen]);
  const chosenScope = clipId ? scope : "source";
  async function start() {
    setError("");
    try {
      await onTranscribe({
        scope: chosenScope,
        quality,
        language,
        dialect,
        prompt,
        force,
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not start transcription.",
      );
    }
  }
  return (
    <section className="speech-controls" aria-label="Transcription options">
      <div className="speech-heading">
        <strong>Transcription</strong>
        <button
          className="speech-settings"
          aria-label="Speech provider settings"
          onClick={onOpenSettings}
        >
          <Settings2 size={14} />
          {provider === "groq" ? "Groq" : "On this computer"}
        </button>
      </div>
      <div className="speech-scope">
        <button
          aria-pressed={chosenScope === "clip"}
          disabled={!clipId || busy}
          onClick={() => setScope("clip")}
        >
          This clip <span>{durationLabel(clipDuration)}</span>
        </button>
        <button
          aria-pressed={chosenScope === "source"}
          disabled={busy}
          onClick={() => setScope("source")}
        >
          Full source <span>{durationLabel(sourceDuration)}</span>
        </button>
      </div>
      <label>
        Spoken language
        <select
          aria-label="Speech language"
          disabled={busy}
          value={dialect === "algerian" ? "darija" : language}
          onChange={(e) => {
            const darija = e.target.value === "darija";
            setDialect(darija ? "algerian" : "none");
            setLanguage(darija ? "ar" : e.target.value);
            if (darija) setQuality("accurate");
          }}
        >
          <option value="auto">Detect language</option>
          <option value="darija">Arabic · Algerian Darija</option>
          <option value="ar">Arabic</option>
          <option value="fr">French</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>
        Recognition quality
        <select
          aria-label="Recognition quality"
          disabled={busy}
          value={quality}
          onChange={(e) =>
            setQuality(e.target.value as TranscriptionRequest["quality"])
          }
        >
          <option value="fast">
            Quick draft · {provider === "groq" ? "large-v3-turbo" : "tiny"}
          </option>
          <option value="balanced">
            Balanced · {provider === "groq" ? "large-v3" : "small"}
          </option>
          <option value="accurate">Thorough · large-v3</option>
        </select>
      </label>
      {dialect === "algerian" && (
        <p className="speech-advice">
          Darija can mix Arabic and French. Use large-v3 and check the result;
          quick drafts often miss dialect words.
        </p>
      )}
      {quality === "accurate" && provider === "local" && (
        <p className="speech-advice">
          Large-v3 needs about 4 GB of free cache space and takes longer on CPU.
          Groq runs recognition remotely.
        </p>
      )}
      <details>
        <summary>Names &amp; retry options</summary>
        <label>
          Names or vocabulary
          <input
            aria-label="Transcription vocabulary"
            maxLength={500}
            value={prompt}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="People, places, technical terms"
          />
        </label>
        <label className="speech-force">
          <input
            type="checkbox"
            checked={force}
            disabled={busy}
            onChange={(e) => setForce(e.target.checked)}
          />{" "}
          Generate again instead of reusing saved captions
        </label>
      </details>
      <button
        className="speech-start"
        disabled={!projectId || busy}
        onClick={() => available ? void start() : onOpenSettings()}
      >
        <Mic2 size={14} />
        {busy
          ? "Processing…"
          : !available ? "Set up transcription" : hasTranscript
            ? "Update captions"
            : "Generate captions"}
      </button>
      {error && (
        <p className="speech-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
