import { runRecipe, transcribeWave, validKey, validRecipe } from "../../shared/openai.mjs";

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "2500kb" } } };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && origin !== `https://${host}` && origin !== `http://${host}`) return res.status(403).json({ error: "Open the editor directly to use AI." });
  if (!validKey(req.headers["x-clipflow-key"])) return res.status(401).json({ error: "Add your OpenAI developer key in AI settings first." });

  const key = req.headers["x-clipflow-key"];
  const signal = AbortSignal.timeout(53_000);
  try {
    if (req.body?.task === "recipe" && validRecipe(req.body.recipe)) {
      const text = await runRecipe(key, req.body.recipe, signal);
      return res.status(200).json({ text });
    }
    if (req.body?.task === "transcribe" && typeof req.body.audio === "string" && req.body.audio.length < 2_150_000 && /^UklGR[A-Za-z0-9+/=]+$/.test(req.body.audio)) {
      const segments = await transcribeWave(key, Buffer.from(req.body.audio, "base64"), signal);
      return res.status(200).json({ segments });
    }
    return res.status(400).json({ error: "This edit request is invalid or too large." });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 502;
    const message = status !== 502 ? error.message : error.name === "TimeoutError"
      ? "OpenAI took too long. Retry the edit request." : "OpenAI did not return a usable result. Try again.";
    return res.status(status).json({ error: message });
  }
}
