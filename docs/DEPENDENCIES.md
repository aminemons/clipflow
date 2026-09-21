# Dependencies and licenses

This inventory covers the direct runtime and build dependencies currently declared by Clipflow. License names should be checked again when dependency versions are pinned for a release.

| Dependency | Role | License/source |
|---|---|---|
| Python | Runtime | [PSF License](https://docs.python.org/3/license.html) |
| FastAPI | HTTP API | [MIT](https://github.com/fastapi/fastapi/blob/master/LICENSE) |
| Uvicorn | ASGI server | [BSD-3-Clause](https://github.com/encode/uvicorn/blob/master/LICENSE.md) |
| python-multipart | Upload parsing | [Apache-2.0](https://github.com/Kludex/python-multipart/blob/master/LICENSE.txt) |
| OpenCV (`opencv-python-headless`) | Frame analysis and focus detection | [Apache-2.0](https://github.com/opencv/opencv-python/blob/4.x/LICENSE.txt) |
| yt-dlp | YouTube/URL ingestion | [Unlicense](https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE) |
| FFmpeg / FFprobe | Decode, crop, encode, probe | [LGPL-2.1-or-later; some optional codecs/builds are GPL](https://ffmpeg.org/legal.html) |
| Node.js / npm | Frontend build/runtime tooling | [Node.js license](https://github.com/nodejs/node/blob/main/LICENSE) and npm package licenses |
| React / React DOM | Frontend UI | [MIT](https://github.com/facebook/react/blob/main/LICENSE) |
| Vite and `@vitejs/plugin-react` | Frontend build | [MIT](https://github.com/vitejs/vite/blob/main/LICENSE) |
| TypeScript | Frontend type checking | [Apache-2.0](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) |
| lucide-react | UI icons | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |
| faster-whisper | Local transcription | [MIT](https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE) plus model-specific terms |

The frontend includes a package lockfile and uses npm ci for repeatable installation. The Whisper model is a separate download; its model terms apply separately from the Python package license.

Clipflow's optional Groq and Higgsfield adapters use HTTP APIs. Their accounts, credits, provider terms, and output licenses are separate from this dependency inventory. Core editing and local transcription do not require either account.

Portable builds include Outfit under the SIL Open Font License; its notice is bundled at `frontend/public/fonts/OFL.txt`. Private Neue Einstellung reference files are not tracked, requested by the frontend, or included in distributable archives. The released frontend uses the bundled Outfit, Anton, and Noto Sans Arabic fonts.
