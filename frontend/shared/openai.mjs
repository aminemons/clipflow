const api = "https://api.openai.com/v1";
const headers = key => ({ Authorization: `Bearer ${key}` });
export const validKey = key => typeof key === "string" && /^sk-[A-Za-z0-9_-]{15,400}$/.test(key);
export const validRecipe = value => value && typeof value.instructions === "string" && value.instructions.length <= 6_000
  && typeof value.input === "string" && value.input.length <= 135_000
  && value.format && typeof value.format === "object" && JSON.stringify(value.format).length < 20_000;

async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    const error = new Error({
      400: "OpenAI rejected this request. Check model access, transcript length and audio format.",
      401: "OpenAI did not accept this API key.",
      403: "This key does not have permission to use the requested OpenAI model.",
      429: "The OpenAI account hit a usage or billing limit.",
    }[response.status] || "OpenAI could not complete this request. Try again.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function runRecipe(key, recipe, signal) {
  const data = await readResponse(await fetch(`${api}/responses`, {
    method: "POST", headers: { ...headers(key), "Content-Type": "application/json" }, signal,
    body: JSON.stringify({
      model: "gpt-5-mini", instructions: recipe.instructions, input: recipe.input,
      text: { format: recipe.format }, reasoning: { effort: "minimal" },
      max_output_tokens: 3500, store: false,
    }),
  }));
  const text = data.output?.flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text).join("");
  if (data.status !== "completed" || !text) throw new Error("GPT returned no complete edit suggestion. Try a shorter transcript or a more specific brief.");
  return text;
}

export async function transcribeWave(key, bytes, signal) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "clipflow.wav");
  form.set("model", "whisper-1");
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const data = await readResponse(await fetch(`${api}/audio/transcriptions`, {
    method: "POST", headers: headers(key), body: form, signal,
  }));
  return (Array.isArray(data.segments) ? data.segments : []).map(({ start, end, text }) => ({ start, end, text }));
}
