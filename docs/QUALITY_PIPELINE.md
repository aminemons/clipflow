# Clip quality: current path and next upgrade

Clipflow keeps analysis separate from editing. Analysis proposes source ranges and
camera targets; the renderer receives validated timestamps and coordinates. A
provider response cannot execute code or replace the original video.

## Current path

1. Import or upload a source and probe its duration, dimensions and audio.
2. Reuse embedded subtitles if available. Otherwise transcribe with local
   faster-whisper or optional Groq. Balanced and accurate local modes request
   word timestamps; the fast mode skips alignment to reduce processing time.
3. Find scene and pause boundaries, then make bounded clip candidates. Transcript
   and word edges help avoid cutting speech. The local ranker scores the
   candidates. Groq, OpenAI, Claude, Gemini or Ollama can instead rank a
   30-candidate shortlist by ID; local code still checks duration and overlap.
4. The local ranker may use a bounded audio-dynamics signal as a small tie-breaker
   among transcript-backed candidates. It decodes mono audio in short windows,
   normalizes loudness variation within the source, and has no effect when audio
   is unavailable. It is not a learned estimate of engagement or virality.
5. Review suggestions in the editor. The current camera controller follows a
   detected face or motion and can switch to a fit layout for screen content.
   Gemini can inspect sampled frames when configured. Neither path currently
   identifies the speaking person from synchronized audio and video.
6. Render with FFmpeg. Aligned words drive caption cues that split at readable
   lengths and speech gaps or clause boundaries, including punctuation-aware
   handling for Arabic text. Cues remain tied to the saved words; edited text uses
   segment timing until it is realigned.

The ranking score is a sorting aid, not a predicted view count or virality score.
The human review and rendered proof remain necessary before export or publishing.

## Next quality gate

The next camera improvement should be a separate, cached analysis pass:
timestamped face tracks plus audio-visual speaking confidence. The camera
controller should change targets only after sustained confidence, and use fit
framing when tracks are missing or a slide occupies the frame. Keep the model
optional until its checkpoint redistribution terms, CPU speed, and accuracy on
real multi-speaker podcasts are established. The LR-ASD project and Cutawan
provide practical starting points; they are not evidence that Clipflow already
has speaker-aware reframing.

For moment quality, compare each ranking change on fixed podcast examples. The
current audio-dynamics tie-breaker is deliberately small and should be retained
only if blinded review improves the keep rate without increasing false highlights.
Rhapsody provides a podcast-focused dataset and evaluation reference; it does not
validate Clipflow ranking quality.
Record whether the start contains a hook, the middle supplies context, and the
end completes a thought. Count cuts through words, missing faces, caption
errors, and clips a reviewer actually keeps. Include Arabic, Algerian Arabic,
French, English, two-speaker shots and screen shares. Rhapsody's podcast
highlight results are a reason to evaluate model suggestions rather than assume
a general LLM will find the strongest moment. WhisperX is a possible future
forced-alignment option for word timing; assess its runtime, language coverage,
and especially Arabic dialect quality before making it part of the default path.

Optional API providers should contribute evidence and proposals, never bypass
the local timeline validator or render pipeline. A future Gemini full-video
review can add visual context to candidate ranking; its output still needs
source-grounded ranges and local render verification. No API key is required
for the baseline workflow.

References: [faster-whisper](https://github.com/SYSTRAN/faster-whisper),
[Groq speech timestamps](https://console.groq.com/docs/speech-to-text),
[Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding),
[LR-ASD](https://github.com/Junhua-Liao/LR-ASD),
[Cutawan](https://github.com/JeremySNR/cutawan),
[Rhapsody](https://arxiv.org/abs/2505.19429), and
[WhisperX](https://github.com/m-bain/whisperX).
