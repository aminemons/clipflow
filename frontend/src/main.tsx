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
