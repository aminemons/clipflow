# Clipflow Studio Desktop

Open **AI settings → Continue with ChatGPT** to connect an eligible ChatGPT Plus or Pro plan for GPT clip suggestions, graphic copy and publishing copy. Projects and footage are saved locally. Manual editing works without an account. Timed speech transcription currently uses the developer API key.

The Windows portable release contains the full app. Extract the entire folder, then open `Clipflow.exe`.

## Build from source

Requires Node.js 22.12 or newer, Git and npm.

```sh
npm ci
npm run prepare-app
npm start
```

Run `npm run package:win` to build the unsigned Windows x64 distribution in `.build/release`. Package the entire generated folder.

The build fetches a pinned commit of OpenAI’s Sign in with ChatGPT DevKit and bundles its local Node runtime and notices. The DevKit license limits its use to noncommercial purposes. The operating-system secret store encrypts OAuth credentials and the desktop process keeps them out of the editor UI.
