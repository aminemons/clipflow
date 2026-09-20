import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { HostedGate } from "./HostedGate";

const renderApp = () =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <HostedGate>
        <App />
      </HostedGate>
    </StrictMode>,
  );

// Keep the private local font opt-in out of hosted bundles, where the files
// are intentionally absent. Local development still loads them when present.
const fontsReady =
  import.meta.env.VITE_CLIPFLOW_MODE === "hosted"
    ? Promise.resolve()
    : import("./local-fonts.css");
fontsReady.then(renderApp);
