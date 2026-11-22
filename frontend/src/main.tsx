import { browserWorkspace } from "./browser/mode";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { HostedGate } from "./HostedGate";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HostedGate>
      <App />
    </HostedGate>
  </StrictMode>,
);


if (import.meta.env.PROD && browserWorkspace && !window.clipflowDesktop && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/studio-sw.js").then(() => navigator.serviceWorker.ready).then(async registration => {
    await Promise.all([import("./browser/api"), import("./studio/media"), import("./browser/camera")]);
    const urls = performance.getEntriesByType("resource").map(entry => new URL(entry.name))
      .filter(url => url.origin === location.origin && url.pathname.startsWith("/assets/")).map(url => url.pathname);
    registration.active?.postMessage({ type: "CACHE_STUDIO_ASSETS", urls });
  }).catch(() => undefined);
}
