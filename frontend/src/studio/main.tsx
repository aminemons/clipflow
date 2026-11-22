import { createRoot } from "react-dom/client";
import StudioApp from "./App";
import "./studio.css";

createRoot(document.getElementById("root")!).render(<StudioApp />);

if (import.meta.env.PROD && !window.clipflowDesktop && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/studio-sw.js").then(() => navigator.serviceWorker.ready).then(async registration => {
    // Fetch the editor's lazy media module while online so export survives an offline reload.
    await import("./media");
    const urls = performance.getEntriesByType("resource").map(entry => new URL(entry.name)).filter(url => url.origin === location.origin && url.pathname.startsWith("/assets/")).map(url => url.pathname);
    registration.active?.postMessage({ type: "CACHE_STUDIO_ASSETS", urls });
  }).catch(() => undefined);
}
