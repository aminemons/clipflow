import { useState } from "react";
import { Check, Copy, Save } from "lucide-react";
import type { Clip } from "./editorTypes";
import { captionFont } from "./captionLayout";

type Preset = { id: string; name: string; note: string; values: Partial<Clip> };
const builtin: Preset[] = [
  {
    id: "clean",
    name: "Clean subtitles",
    note: "White, lower frame",
    values: {
      caption_style: "clean",
      caption_font: "outfit", caption_size: 60,
      caption_color: "#ffffff",
      caption_x: 0.5,
      caption_y: 0.84,
      caption_enabled: true,
    },
  },
  {
    id: "bold",
    name: "Bold highlight",
    note: "Yellow, easy to read",
    values: {
      caption_style: "bold",
      caption_font: "anton", caption_size: 68,
      caption_color: "#ffe16b",
      caption_x: 0.5,
      caption_y: 0.75,
      caption_enabled: true,
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    note: "Light type, lower frame",
    values: {
      caption_style: "minimal",
      caption_font: "outfit", caption_size: 46,
      caption_color: "#ffffff",
      caption_x: 0.5,
      caption_y: 0.88,
      caption_enabled: true,
    },
  },
  {
    id: "center",
    name: "Center title",
    note: "Bold, middle of frame",
    values: {
      caption_style: "bold",
      caption_font: "noto-arabic", caption_size: 60,
      caption_color: "#ffffff",
      caption_x: 0.5,
      caption_y: 0.5,
      caption_enabled: true,
    },
  },
];
const fields = [
  "caption_style",
  "caption_font",
  "caption_size",
  "caption_color",
  "caption_x",
  "caption_y",
  "caption_enabled",
  "caption_position",
] as const;
export default function CaptionPresets({
  clip,
  onApply,
  onApplyAll,
  disabled,
}: {
  clip: Clip;
  onApply: (values: Partial<Clip>) => void;
  onApplyAll: (values: Partial<Clip>) => void;
  disabled: boolean;
}) {
  const [custom, setCustom] = useState<Preset[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("clipflow:caption-presets") || "[]",
      );
    } catch {
      return [];
    }
  });
  const [name, setName] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const current = () =>
    Object.fromEntries(
      fields.filter((f) => clip[f] !== undefined).map((f) => [f, clip[f]]),
    ) as Partial<Clip>;
  function save() {
    if (!name.trim()) return;
    const next = [
      ...custom.filter((p) => p.name !== name.trim()),
      {
        id: `custom-${Date.now()}`,
        name: name.trim(),
        note: "Your saved style",
        values: current(),
      },
    ].slice(-8);
    localStorage.setItem("clipflow:caption-presets", JSON.stringify(next));
    setCustom(next);
    setName("");
  }
  return (
    <div className="caption-preset-tool">
      <label className="caption-font-control">Font
        <select disabled={disabled} value={clip.caption_font || "outfit"} onChange={(e) => onApply({caption_font: e.target.value as Clip["caption_font"]})}>
          <option value="outfit">Outfit · modern</option><option value="anton">Anton · bold headlines</option><option value="noto-arabic">Noto Sans Arabic · عربي</option>
        </select>
      </label>
      <label className="caption-font-control">Size · {clip.caption_size ?? 52}px
        <input disabled={disabled} type="range" min={32} max={90} value={clip.caption_size ?? 52} onChange={(e) => onApply({caption_size: Number(e.target.value)})} />
      </label>
      <details open>
        <summary>
          Caption presets <span>{builtin.length + custom.length}</span>
        </summary>
        <div className="caption-presets">
          {[...builtin, ...custom].map((p) => (
            <button
              disabled={disabled}
              key={p.id}
              onClick={() => onApply(p.values)}
              title={p.note}
            >
              <span
                style={{
                  color: p.values.caption_color,
                  fontFamily: captionFont(p.values.caption_font),
                  fontWeight: p.values.caption_style === "bold" ? 800 : 500,
                }}
              >
                Your story
              </span>
              <strong>{p.name}</strong>
            </button>
          ))}
        </div>
        <div className="preset-save">
          <input
            aria-label="New caption preset name"
            maxLength={40}
            placeholder="Name this style"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            disabled={disabled || !name.trim()}
            aria-label="Save caption preset"
            onClick={save}
          >
            <Save size={17} />
          </button>
        </div>
        {custom.length > 0 && (
          <button
            className="text-action"
            onClick={() => {
              localStorage.removeItem("clipflow:caption-presets");
              setCustom([]);
            }}
          >
            Clear saved presets
          </button>
        )}
      </details>
      <button
        className="secondary-action"
        disabled={disabled}
        onClick={() => setConfirmAll(true)}
      >
        <Copy size={14} />
        Apply this style to all clips
      </button>
      {confirmAll && (
        <div className="inline-confirm">
          <p>
            Replace caption styling on every clip? Caption text and timing stay
            unchanged.
          </p>
          <button
            disabled={disabled}
            onClick={() => {
              onApplyAll(current());
              setConfirmAll(false);
            }}
          >
            <Check size={14} />
            Apply to all
          </button>
          <button onClick={() => setConfirmAll(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
