import { app, BrowserWindow, ipcMain, net, protocol, safeStorage, shell } from "electron";
import { createChatGPT } from "@siwc/local";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { runRecipe, transcribeWave, validKey, validRecipe } from "./shared/openai.mjs";

const scheme = "clipflow-studio";
const home = `${scheme}://local/browser.html`;
const isEditorUrl = value => typeof value === "string" && value.split("#", 1)[0] === home;
const directory = join(import.meta.dirname, "renderer");
const requests = new Map();
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'";

protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName("Clipflow Studio");
let window;
let chatgpt;

const vault = {
  id: "clipflow-os-encryption-v1",
  isAvailable() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    return process.platform !== "linux" || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(safeStorage.getSelectedStorageBackend());
  },
  encrypt(value) {
    if (!this.isAvailable()) throw new Error("Enable your operating system’s credential storage to connect ChatGPT.");
    return safeStorage.encryptString(value);
  },
  decrypt(value) {
    if (!this.isAvailable()) throw new Error("Unlock your operating system’s credential storage to connect ChatGPT.");
    return safeStorage.decryptString(Buffer.from(value));
  },
};

function register(channel, handler) {
  ipcMain.handle(`clipflow:${channel}`, (event, ...args) => {
    if (!window || event.sender !== window.webContents || !isEditorUrl(event.senderFrame?.url)) throw new Error("This request came from outside the local editor.");
    return handler(...args);
  });
}

async function withOperation(id, work) {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || requests.has(id) || requests.size >= 2) throw new Error("Finish the current AI request before starting another.");
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    return await work(AbortSignal.any([controller.signal, AbortSignal.timeout(75_000)]));
  } finally {
    requests.delete(id);
  }
}

app.whenReady().then(() => {
  chatgpt = createChatGPT({
    appName: "Clipflow Studio", appId: "clipflow-studio", redirectPort: 0, sendHostId: true,
    storageDir: join(app.getPath("userData"), "chatgpt"), credentialEncryption: vault,
    async openBrowser(value) {
      const target = new URL(value);
      if (target.origin !== "https://auth.openai.com") throw new Error("Unexpected ChatGPT sign-in address.");
      await shell.openExternal(target.href);
    },
  });

  protocol.handle(scheme, async request => {
    const url = new URL(request.url);
    if (url.hostname !== "local" || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 404 });
    try {
      const file = resolve(directory, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(directory + sep)) return new Response(null, { status: 404 });
      const response = await net.fetch(pathToFileURL(file).href, { method: request.method, headers: request.headers });
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", csp);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  register("session", () => chatgpt.getSession());
  register("sign-in", () => {
    if (!vault.isAvailable()) throw new Error("ChatGPT sign-in needs the operating system’s secure credential store.");
    return chatgpt.signIn({ reconsent: true });
  });
  register("cancel-sign-in", () => chatgpt.cancelSignIn());
  register("disconnect", () => chatgpt.disconnect());
  register("usage", () => shell.openExternal("https://chatgpt.com/settings/usage"));
  register("cancel", id => { requests.get(id)?.abort(); });
  register("run", (spec, id) => {
    if (!validRecipe(spec)) throw new Error("The edit request is invalid.");
    return withOperation(id, async signal => {
      const session = await chatgpt.getSession();
      if (!session.sharing) throw new Error("Connect ChatGPT and approve plan usage first.");
      const models = await chatgpt.listModels({ signal });
      const model = models.find(item => item.slug === "gpt-5-mini")
        ?? models.find(item => /gpt-(5|6).*mini|gpt-(5|6).*sol/i.test(item.slug))
        ?? models[0];
      if (!model) throw new Error("This account has no eligible ChatGPT models.");
      return (await chatgpt.streamResponse({ model: model.slug, instructions: spec.instructions, input: spec.input, signal })).text;
    });
  });
  register("run-key", (spec, key, id) => {
    if (!validKey(key) || !validRecipe(spec)) throw new Error("The OpenAI key or edit request is invalid.");
    return withOperation(id, signal => runRecipe(key, spec, signal));
  });
  register("transcribe", (buffer, key, id, hints) => {
    if (!validKey(key) || !(buffer instanceof ArrayBuffer) || buffer.byteLength < 44 || buffer.byteLength > 1_600_000 || Buffer.from(buffer, 0, 4).toString() !== "RIFF") throw new Error("The OpenAI key or audio chunk is invalid.");
    return withOperation(id, signal => transcribeWave(key, buffer, signal, hints));
  });

  function open() {
    window = new BrowserWindow({
      width: 1480, height: 960, minWidth: 420, minHeight: 540, backgroundColor: "#f2f4ed",
      title: "Clipflow Studio", autoHideMenuBar: true, icon: join(directory, "studio/icon-512.png"),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(import.meta.dirname, "preload.cjs") },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (["https://commons.wikimedia.org/wiki/File:Fog_covering_mountain_time_lapse.webm", "https://github.com/aminemons/clipflow/releases", "https://clipflow-aminemons.vercel.app/index.html"].includes(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => { if (!isEditorUrl(url)) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_target, _permission, callback) => callback(false));
    void window.loadURL(home);
  }
  open();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) open(); });
});

app.on("window-all-closed", () => {
  chatgpt?.cancelSignIn();
  for (const request of requests.values()) request.abort();
  if (process.platform !== "darwin") app.quit();
});
