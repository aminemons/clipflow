# Optional integrations and design assets

Clipflow’s assessment baseline remains fully local: FFmpeg/OpenCV/yt-dlp, manual captions, and local MP4/SRT/ZIP export work without accounts, API keys, or paid services. The integrations below are optional adapters and must fail closed without changing that baseline.

## Higgsfield API

Official docs: [Higgsfield API docs](https://docs.higgsfield.ai/docs) and [Higgsfield API overview](https://www.higgsfield.company/creator-hub/help-center/integrations/what-is-the-higgsfield-api).

The API is an authenticated asynchronous image/video generation API. The documented request lifecycle is:

1. Create server-side credentials in Higgsfield Console.
2. Submit JSON to a model endpoint on `https://api.higgsfield.ai` with `Authorization: Key <API_KEY_ID>:<API_KEY_SECRET>`.
3. Poll the returned `status_url`, or receive a webhook, then download the result.

The official example endpoint is `POST /higgsfield-ai/soul/v2/standard`; request bodies depend on the selected model. Input uploads go to Higgsfield storage when required. Outputs are retained for at least seven days, so an adapter should download successful results to local storage promptly.

The website subscription and API are separate products. API access uses a separate prepaid USD balance and pay-per-generation billing; the help page currently states a $5 minimum top-up and that video rates depend on output seconds/configuration. No account, key, or billable request was used for Clipflow validation.

The current adapter configuration uses `HF_API_KEY` and `HF_API_SECRET`, server-side only. Keep the adapter disabled when either is absent. Higgsfield is suitable for optional generated B-roll, thumbnails, or creative variants. The official API documentation does not establish it as Clipflow’s segmentation, subject tracking, crop, trim/extend, or local export engine.

### Verified text-to-video endpoint

The official [OpenAPI reference](https://docs.higgsfield.ai/docs/openapi.json) currently documents a no-image-input text-to-video route for Kling:

```text
POST https://api.higgsfield.ai/kling-video/v2.5-turbo/pro/text-to-video
Authorization: Key <HF_API_KEY_ID>:<HF_API_SECRET>
Content-Type: application/json
```

The documented JSON body is `{ "prompt": string, "duration": 5 | 10, "cfg_scale": number (0..1, default 0.5), "negative_prompt": string (optional) }`; only `prompt` is required. The same OpenAPI reference also documents Minimax Hailuo text-to-video at `/minimax/hailuo-2.3/standard/text-to-video` with `{ "prompt": string, "duration": 6 | 10, "prompt_optimizer": boolean (default true) }`.

Both routes return a `RequestStatus` object with `status`, `request_id`, `status_url`, and `cancel_url`. Poll `GET https://api.higgsfield.ai/requests/{request_id}/status` until `status` is `completed`, `failed`, `canceled`, or `nsfw`; a completed response contains `video: { "url": string }`. The OpenAPI schema also allows `error` for failure states. The documented text-to-video schemas do not expose a vertical aspect-ratio field, so Clipflow should post-process a successful B-roll result locally to 9:16 or treat its framing as provider-dependent. Do not promise native vertical output from these endpoints.

## Groq Whisper transcription

Official docs: [Groq Speech to Text](https://console.groq.com/docs/speech-to-text).

Groq documents OpenAI-compatible endpoints:

- `POST https://api.groq.com/openai/v1/audio/transcriptions`
- `POST https://api.groq.com/openai/v1/audio/translations`

The documented models are `whisper-large-v3` and `whisper-large-v3-turbo`. Uploads support common audio/video formats including MP4, with a 25 MB free-tier limit and 100 MB development-tier limit; larger media needs a URL or local FFmpeg extraction/chunking. Segment and word timestamps are supported through the response format/options documented by Groq. Use a server-side `GROQ_API_KEY` only when the user opts in, and show provider/network/cost state in the UI. No Groq request was made during validation.

## Local faster-whisper

Official project: [SYSTRAN faster-whisper](https://github.com/SYSTRAN/faster-whisper). It runs Whisper through CTranslate2 and downloads a model on first use. The current build installs and requires it for the transcription route; model storage and CPU/GPU performance still vary, so the health endpoint should report a clear unavailable state when setup is incomplete. A local transcription adapter can remain entirely offline after model download; it should write segment timestamps into Clipflow’s existing transcript shape and preserve manual caption overrides. The project is MIT licensed, while each downloaded model may carry separate terms.

## Mall of Travels typography reference

The inspected source of truth is `C:\idh\mall-last\src\styles.scss` and `src/assets/fonts/neue-einstellung/`. The primary family is **Neue Einstellung**, with local WOFF2 files for weights 300, 400, 500, 600, 700, and 800. The CSS sets `--font-family: "Neue Einstellung", "Montserrat", sans-serif`; it uses Noto Sans Arabic as the RTL fallback. The source also imports Google-hosted Montserrat and Noto Sans Arabic.

The source comment identifies Neue Einstellung as commercial and deliberately says the declarations resolve an already licensed local installation. No font license file was found beside the six WOFF2 assets. The six files were copied into Clipflow’s `frontend/public/fonts` under the user-authorized local reuse decision; retain this provenance note and do not redistribute them outside that authorized build without the asset owner’s license confirmation. The exact family is a visual reference, not an OSS dependency.

## Design skill used for review

The requested public Anthropic `frontend-design` skill is installed at `C:\Users\bouba\.codex\skills\frontend-design`. Its `SKILL.md` and `LICENSE.txt` were inspected; the skill is Apache-2.0 licensed. It informed the visual review guidance only. It did not add runtime dependencies or require external accounts.
