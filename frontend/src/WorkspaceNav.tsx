import {
  Clapperboard,
  Download,
  FolderOpen,
  HelpCircle,
  Plus,
  Settings2,
  Send,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { TourPage } from "./GuidedTour";
import { useEffect, useState } from "react";
import { useHostedAuth } from "./HostedGate";

export default function WorkspaceNav({
  page,
  onNavigate,
  onNew,
  onTour,
  hasProject,
  projectTitle,
  compact,
  onCompact,
  activeJobs,
}: {
  page: TourPage;
  onNavigate: (page: TourPage) => void;
  onNew: () => void;
  onTour: () => void;
  hasProject: boolean;
  projectTitle?: string;
  compact: boolean;
  onCompact: () => void;
  activeJobs: number;
}) {
  const { hosted } = useHostedAuth();
  const [desktopReady, setDesktopReady] = useState(false);
  useEffect(() => {
    fetch("/api/desktop")
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => setDesktopReady(!!r?.available))
      .catch(() => undefined);
  }, []);
  return (
    <aside
      className={`workspace-nav ${compact ? "nav-compact" : ""}`}
      aria-label="Main navigation"
    >
      <button
        className="workspace-brand"
        onClick={() => onNavigate("projects")}
        aria-label="Clipflow projects"
      >
        <span>
          <Clapperboard size={21} />
        </span>
        <strong>clipflow</strong>
      </button>
      <button className="nav-new" onClick={onNew} title="New project">
        <Plus size={18} />
        <span>New project</span>
      </button>
      <nav>
        {(
          [
            { id: "projects", label: "Projects", icon: FolderOpen },
            { id: "editor", label: "Editor", icon: Clapperboard },
            { id: "exports", label: "Exports", icon: Download },
            { id: "publish", label: "Publish", icon: Send },
            { id: "settings", label: "Settings", icon: Settings2 },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            data-tour={`${id}-nav`}
            className={page === id ? "nav-active" : ""}
            aria-current={page === id ? "page" : undefined}
            onClick={() => onNavigate(id)}
            title={
              id === "editor" && hasProject ? `Continue ${projectTitle}` : label
            }
          >
            <Icon size={19} />
            <span>{label}</span>
            {id === "exports" && activeJobs > 0 && <b>{activeJobs}</b>}
          </button>
        ))}
      </nav>
      {hasProject && (
        <div className="nav-current">
          <span>Open project</span>
          <button onClick={() => onNavigate("editor")} title={projectTitle}>
            {projectTitle}
          </button>
        </div>
      )}
      <div className="nav-bottom">
        {desktopReady && (
          <button
            title="Download Windows desktop app · unzip and run Clipflow.exe"
            onClick={() => {
              window.location.href = "/api/desktop/download";
            }}
          >
            <Download size={18} />
            <span>Download desktop</span>
          </button>
        )}
        <button onClick={onTour} title="Take a guided tour">
          <HelpCircle size={18} />
          <span>Take a tour</span>
        </button>
        <button
          onClick={onCompact}
          title={compact ? "Expand navigation" : "Collapse navigation"}
        >
          {compact ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          <span>Collapse sidebar</span>
        </button>
        <p>{hosted ? "Saved in this private workspace" : "Saved on this computer"}</p>
      </div>
    </aside>
  );
}
