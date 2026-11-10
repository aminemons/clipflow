export const motionGraphics = [
  { id: "opening", name: "Opening title", purpose: "Tell viewers what this clip is about.", example: "The decision that changed everything" },
  { id: "speaker", name: "Speaker ID", purpose: "Introduce a person while they speak.", example: "Maya Chen / Film editor" },
  { id: "callout", name: "Key takeaway", purpose: "Put one important number or idea on screen.", example: "3 days to finish the cut" },
] as const;

export type MotionGraphic = {
  preset: (typeof motionGraphics)[number]["id"];
  text: string;
};

export const insertPrompts = [
  { name: "Editorial detail", prompt: "Five-second editorial B-roll of [subject] in [setting]. Close-up on one telling detail, natural side light, slow push-in, clean background. No text or logos." },
  { name: "Show the process", prompt: "Close-up of [object] as [action] happens once. Stable camera, clear hands and tools, soft daylight. Hold briefly on the finished result. No text or logos." },
  { name: "Abstract motion", prompt: "Minimal motion graphic: [shape] assembles from simple pieces on a [color] background, eases into place, and holds. Crisp flat design, no letters, no logos." },
  { name: "Change of scene", prompt: "Wide establishing shot of [place] at [time]. One gentle lateral camera move. Leave room around the subject for a vertical crop. No text or logos." },
] as const;
