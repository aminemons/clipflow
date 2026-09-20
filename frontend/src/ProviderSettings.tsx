import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type {
  Health,
  ProviderSettings as ProviderSettingsType,
} from "./editorTypes";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export default function ProviderSettings({
  api,
  open,
  onClose,
  onHealth,
  onNotice,
  embedded = false,
}: {
  api: Api;
  open: boolean;
  onClose: () => void;
  onHealth: (health: Health) => void;
  onNotice: (message: string) => void;
  embedded?: boolean;
}) {
  const empty: ProviderSettingsType = {
    transcription_provider: "local",
    whisper_model: "",
    highlight_provider: "local",
    groq_highlight_model: "llama-3.3-70b-versatile",
    higgsfield_enabled: false,
    keys: { GROQ_API_KEY: false, HF_API_KEY: false, HF_API_SECRET: false },
  };
  const [form, setForm] = useState<ProviderSettingsType>(empty);
  const [credentials, setCredentials] = useState<Record<string, string>>({
    GROQ_API_KEY: "",
    HF_API_KEY: "",
    HF_API_SECRET: "",
  });
  const [clearKeys, setClearKeys] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    api<ProviderSettingsType>("/settings")
      .then((next) => setForm(next))
      .catch((error) =>
        setError(
          error instanceof Error ? error.message : "Settings unavailable.",
        ),
      );
  }, [open]);
  useEffect(() => {
    if (!open || embedded) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  function setCredential(key: string, value: string) {
    setCredentials((current) => ({ ...current, [key]: value }));
    setClearKeys((keys) => keys.filter((item) => item !== key));
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      const body = {
        transcription_provider: form.transcription_provider,
        whisper_model: form.whisper_model,
        highlight_provider: form.highlight_provider,
        openai_text_model: form.openai_text_model,
        anthropic_text_model: form.anthropic_text_model,
        gemini_text_model: form.gemini_text_model,
        ollama_text_model: form.ollama_text_model,
        groq_highlight_model: form.groq_highlight_model,
        higgsfield_enabled: form.higgsfield_enabled,
        credentials: Object.fromEntries(
          Object.entries(credentials).filter(([, value]) => value.trim()),
        ),
        clear_keys: clearKeys,
      };
      const next = await api<ProviderSettingsType>("/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setForm(next);
      setCredentials({ GROQ_API_KEY: "", HF_API_KEY: "", HF_API_SECRET: "" });
      setClearKeys([]);
      onHealth(await api<Health>("/health"));
      onNotice("Provider settings saved");
      if (!embedded) onClose();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not save provider settings.",
      );
    } finally {
      setSaving(false);
    }
  }
  const cloud =
    form.transcription_provider === "groq" ||
    !["local", "ollama"].includes(form.highlight_provider);
  return (
    <div
      className={embedded ? "settings-embedded" : "settings-modal"}
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label="Provider settings"
      onMouseDown={(event) =>
        !embedded && event.target === event.currentTarget && onClose()
      }
    >
      <aside className="settings-drawer">
        <div className="settings-drawer-head">
          <div>
            <div className="pane-title">Provider settings</div>
            <p>Choose where analysis runs. Blank credentials stay unchanged.</p>
          </div>
          {!embedded && (
            <button
              className="icon-button"
              aria-label="Close settings"
              onClick={onClose}
            >
              <X size={17} />
            </button>
          )}
        </div>
        <label className="settings-field">
          Transcription provider
          <select
            value={form.transcription_provider}
            onChange={(event) =>
              setForm({
                ...form,
                transcription_provider: event.target.value as "local" | "groq",
              })
            }
          >
            <option value="local">Local Whisper</option>
            <option value="groq">Groq</option>
          </select>
        </label>
        <label className="settings-field">
          Whisper model
          <select
            value={form.whisper_model}
            onChange={(event) =>
              setForm({
                ...form,
                whisper_model: event.target
                  .value as ProviderSettingsType["whisper_model"],
              })
            }
          >
            {(
              [
                "",
                "tiny",
                "base",
                "small",
                "medium",
                "large-v3",
                "large-v3-turbo",
              ] as const
            ).map((model) => (
              <option key={model} value={model}>
                {model || "Auto (quality preset)"}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          Highlight provider
          <select
            value={form.highlight_provider}
            onChange={(event) =>
              setForm({
                ...form,
                highlight_provider: event.target
                  .value as ProviderSettingsType["highlight_provider"],
              })
            }
          >
            <option value="local">Free local ranking</option>
            <option value="groq">Groq</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="ollama">Ollama · self-hosted</option>
          </select>
        </label>
        {cloud && (
          <p className="settings-cloud-note">
            Cloud providers send transcript or highlight text to your selected
            provider and may incur provider charges.
          </p>
        )}
        <div className="settings-divider" />
        <div className="settings-subtitle">Text analysis models</div>
        <p className="page-hint">
          These models select transcript highlights. Speech recognition uses the
          transcription provider above. Ollama requires a separate installation
          and a downloaded model on the machine running Clipflow's video engine.
        </p>
        {(
          [
            ["openai_text_model", "OpenAI", "OPENAI_API_KEY"],
            ["anthropic_text_model", "Claude", "ANTHROPIC_API_KEY"],
            ["gemini_text_model", "Gemini", "GEMINI_API_KEY"],
            ["ollama_text_model", "Ollama", null],
          ] as const
        ).map(([field, label, key]) => (
          <div className="model-provider-row" key={field}>
            <label className="settings-field">
              {label} model ID
              <input
                value={form[field] || ""}
                maxLength={150}
                onChange={(e) => setForm({ ...form, [field]: e.target.value })}
              />
            </label>
            {key && (
              <CredentialField
                label={`${label} API key`}
                name={key}
                present={!!form.keys[key]}
                value={credentials[key] || ""}
                onChange={setCredential}
                clear={clearKeys.includes(key)}
                onClear={() =>
                  setClearKeys((current) =>
                    current.includes(key)
                      ? current.filter((k) => k !== key)
                      : [...current, key],
                  )
                }
              />
            )}
          </div>
        ))}
        <div className="settings-divider" />
        <div className="settings-subtitle">Speech and video credentials</div>
        <CredentialField
          label="Groq API key"
          name="GROQ_API_KEY"
          present={form.keys.GROQ_API_KEY}
          value={credentials.GROQ_API_KEY}
          onChange={setCredential}
          clear={clearKeys.includes("GROQ_API_KEY")}
          onClear={() =>
            setClearKeys((keys) =>
              keys.includes("GROQ_API_KEY")
                ? keys.filter((item) => item !== "GROQ_API_KEY")
                : [...keys, "GROQ_API_KEY"],
            )
          }
        />
        <CredentialField
          label="Higgsfield API key"
          name="HF_API_KEY"
          present={form.keys.HF_API_KEY}
          value={credentials.HF_API_KEY}
          onChange={setCredential}
          clear={clearKeys.includes("HF_API_KEY")}
          onClear={() =>
            setClearKeys((keys) =>
              keys.includes("HF_API_KEY")
                ? keys.filter((item) => item !== "HF_API_KEY")
                : [...keys, "HF_API_KEY"],
            )
          }
        />
        <CredentialField
          label="Higgsfield API secret"
          name="HF_API_SECRET"
          present={form.keys.HF_API_SECRET}
          value={credentials.HF_API_SECRET}
          onChange={setCredential}
          clear={clearKeys.includes("HF_API_SECRET")}
          onClear={() =>
            setClearKeys((keys) =>
              keys.includes("HF_API_SECRET")
                ? keys.filter((item) => item !== "HF_API_SECRET")
                : [...keys, "HF_API_SECRET"],
            )
          }
        />
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={form.higgsfield_enabled}
            onChange={(event) =>
              setForm({ ...form, higgsfield_enabled: event.target.checked })
            }
          />
          <span>Enable Higgsfield generation</span>
        </label>
        {error && <p className="settings-error">{error}</p>}
        <button
          className="lime-button settings-save"
          disabled={saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </aside>
    </div>
  );
}
function CredentialField({
  label,
  name,
  present,
  value,
  onChange,
  clear,
  onClear,
}: {
  label: string;
  name: string;
  present: boolean;
  value: string;
  onChange: (name: string, value: string) => void;
  clear: boolean;
  onClear: () => void;
}) {
  return (
    <label className="settings-field credential-field">
      {label}
      <input
        type="password"
        autoComplete="new-password"
        value={value}
        placeholder={present ? "Saved · enter to replace" : "Not configured"}
        onChange={(event) => onChange(name, event.target.value)}
      />
      <span>
        <small>
          {present
            ? "A credential is saved on the server."
            : "No credential saved."}
        </small>
        {present && (
          <button
            type="button"
            className={clear ? "clear-key active" : "clear-key"}
            onClick={onClear}
          >
            {clear ? "Will clear" : "Clear"}
          </button>
        )}
      </span>
    </label>
  );
}
