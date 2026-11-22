const { contextBridge, ipcRenderer } = require("electron");
const invoke = (channel, ...args) => ipcRenderer.invoke(`clipflow:${channel}`, ...args);
contextBridge.exposeInMainWorld("clipflowDesktop", {
  session: () => invoke("session"),
  signIn: () => invoke("sign-in"),
  cancelSignIn: () => invoke("cancel-sign-in"),
  disconnect: () => invoke("disconnect"),
  usage: () => invoke("usage"),
  run: (spec, id) => invoke("run", spec, id),
  runKey: (spec, key, id) => invoke("run-key", spec, key, id),
  transcribe: (buffer, key, id, hints) => invoke("transcribe", buffer, key, id, hints),
  cancel: id => invoke("cancel", id),
});
