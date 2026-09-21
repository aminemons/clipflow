import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./GuidedTour.css";

export type TourPage =
  "projects" | "editor" | "exports" | "publish" | "settings";
export type GuidedTourProps = {
  page: TourPage;
  onNavigate: (page: TourPage) => void;
  onReveal?: (target: string) => void;
  hasProject: boolean;
  hasClips?: boolean;
  onClose?: () => void;
  replayToken: number;
};
type TourStep = {
  page: TourPage;
  chapter: string;
  target?: string;
  title: string;
  body: string;
  needsProject?: boolean;
  needsClips?: boolean;
};
type Geometry = {
  rect: { top: number; left: number; width: number; height: number };
  popover: { top: number; left: number };
  placement: "above" | "below" | "center";
};

const STORAGE_KEY = "clipflow:tour:v3";
const POPOVER_WIDTH = 360;
const ESTIMATED_HEIGHT = 310;
const tourSteps: TourStep[] = [
  {
    page: "projects",
    chapter: "Start",
    target: "projects-nav",
    title: "Your project library",
    body: "Projects keep the source, editable clips, captions, and exports together. Start here whenever you need to return to work.",
  },
  {
    page: "projects",
    chapter: "Start",
    target: "new-project",
    title: "Import a source",
    body: "Choose a local video or inspect a YouTube link first. After Check video, choose a download quality and import. If YouTube blocks the request, upload your video file instead. Importing does not generate clips.",
  },
  {
    page: "projects",
    chapter: "Start",
    target: "project-library",
    title: "Open the source",
    body: "Open a project from the library to continue. Rename, tag, favorite, or archive projects from the library controls.",
  },
  {
    page: "editor",
    chapter: "Configure",
    target: "editor-generation",
    title: "Configure before generating",
    body: "Clip setup is one reviewable pass: choose moments, framing, captions, and audio, then Generate clips.",
    needsProject: true,
  },
  {
    page: "editor",
    chapter: "Configure",
    target: "setup-source",
    title: "Check source details",
    body: "Confirm the duration and dimensions. Use the source preview to mark exact ranges when you want manual moments.",
    needsProject: true,
  },
  {
    page: "editor",
    chapter: "Configure",
    target: "setup-moments",
    title: "Choose moments",
    body: "Smart highlights rank spoken or structural moments. Full source splits the whole video. Manual mode uses the ranges you add.",
    needsProject: true,
  },
  {
    page: "editor",
    chapter: "Configure",
    target: "setup-camera",
    title: "Choose the crop",
    body: "Adaptive and follow framing are evaluated during rendering. Fit preserves the full source; manual crop gives you a fixed composition.",
    needsProject: true,
  },
  {
    page: "editor",
    chapter: "Configure",
    target: "setup-captions",
    title: "Set captions and audio",
    body: "Choose automatic captions, one manual overlay, or no captions. Pick the font, size, color, position, language, and audio cleanup before generating.",
    needsProject: true,
  },
  {
    page: "editor",
    chapter: "Configure",
    target: "setup-review",
    title: "Review the generation pass",
    body: "Check the summary, then Generate clips. The results remain editable; generation does not publish or export by itself.",
    needsProject: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-library",
    title: "Review the clip library",
    body: "Generated clips stay in the library as separate editable items. Select one to work on it without changing which clips are checked for export.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-selection",
    title: "Choose export clips",
    body: "Use the library selection controls to choose the clips that will be exported. Working on a clip does not silently change this selection.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-review",
    title: "Mark clips for review",
    body: "Review a rendered clip in the library and keep its review state visible while you work through a batch.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-timeline",
    title: "Trim the selected clip",
    body: "Move the timeline handles or use the playhead to set the source start and end. Source timestamps stay separate from the rendered preview.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-transcript",
    title: "Correct the transcript",
    body: "Use Transcript to search speech and correct recognition text. To import an SRT or VTT file, open Captions. Corrections keep their original timing.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-captions",
    title: "Style the captions",
    body: "Open Captions to choose the overlay style, font, position, and whether captions are burned into the render.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-clip-name",
    title: "Name the selected clip",
    body: "Give the selected clip a useful name so it is easy to identify in review, export, and publishing.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Edit",
    target: "editor-save",
    title: "Save draft settings",
    body: "Media edits are drafts. Save settings before you render or leave the editor; the status beside the action tells you whether the server has the latest values.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Review",
    target: "editor-render",
    title: "Render the proof",
    body: "Render preview to see the actual crop, caption burn-in, speed, and audio effects. Source playback does not simulate camera tracking.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Review",
    target: "editor-preview",
    title: "Inspect the result",
    body: "Play the rendered proof and seek it. If the framing or captions need work, edit the draft, save again, and render a new proof.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "editor",
    chapter: "Review",
    target: "editor-export",
    title: "Export the current clip",
    body: "Export current renders just the clip open in the editor. For a batch, use the checkboxes and Export button in the clip library. The clip being edited and the clips checked for export are separate choices. Select one or several clips, then export an MP4 or ZIP.",
    needsProject: true,
    needsClips: true,
  },
  {
    page: "exports",
    chapter: "Deliver",
    target: "exports-nav",
    title: "Download finished files",
    body: "Exports shows progress, errors, retries, and immutable download files. A later render does not replace an earlier export artifact.",
  },
  {
    page: "publish",
    chapter: "Deliver",
    target: "publish-nav",
    title: "Review publishing",
    body: "Publishing is a separate, explicit step. Approve rendered clips, choose destination accounts, review the plan, and confirm only when you intend to contact a provider.",
  },
  {
    page: "settings",
    chapter: "Connect",
    target: "settings-nav",
    title: "Configure providers and accounts",
    body: "Settings holds optional transcription, highlight, vision, B-roll, and publishing credentials. Keys stay server-side; local editing and export remain available without them.",
  },
];

function readState() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeState(value: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* storage is optional */
  }
}
function visible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  );
}
function findTarget(name?: string) {
  if (!name) return null;
  return (
    Array.from(document.querySelectorAll<HTMLElement>("[data-tour]")).find(
      (element) => element.dataset.tour === name && visible(element),
    ) ?? null
  );
}
function focusable(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(visible);
}

export default function GuidedTour({
  page,
  onNavigate,
  onReveal,
  hasProject,
  hasClips = false,
  onClose,
  replayToken,
}: GuidedTourProps) {
  const [mode, setMode] = useState<"welcome" | "tour" | "closed">(() =>
    readState() ? "closed" : "welcome",
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const popoverRef = useRef<HTMLElement>(null);
  const welcomeRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const lastReplay = useRef(replayToken);
  const activeStep = tourSteps[stepIndex];
  const revealedTarget = useRef<HTMLElement | null>(null);
  useEffect(() => {
    revealedTarget.current = null;
  }, [stepIndex]);
  const rememberFocus = useCallback(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, []);
  const restoreFocus = useCallback(() => {
    const element = returnFocusRef.current;
    returnFocusRef.current = null;
    if (element && document.contains(element))
      window.setTimeout(() => element.focus(), 0);
  }, []);
  const closeTour = useCallback(
    (state: "dismissed" | "completed") => {
      writeState(state);
      setMode("closed");
      setGeometry(null);
      restoreFocus();
      onClose?.();
    },
    [onClose, restoreFocus],
  );
  const startTour = useCallback(
    (index = 0) => {
      rememberFocus();
      writeState("started");
      setStepIndex(index);
      setGeometry(null);
      setMode("tour");
    },
    [rememberFocus],
  );

  useEffect(() => {
    if (lastReplay.current === replayToken) return;
    lastReplay.current = replayToken;
    startTour(0);
  }, [replayToken, startTour]);
  useEffect(() => {
    if (mode !== "tour" || !activeStep) return;
    if (
      (activeStep.needsProject && !hasProject) ||
      (activeStep.needsClips && !hasClips)
    ) {
      setGeometry(null);
      return;
    }
    if (activeStep.page !== page) {
      setGeometry(null);
      onNavigate(activeStep.page);
      return;
    }
    onReveal?.(activeStep.target || "");
  }, [activeStep, hasClips, hasProject, mode, onNavigate, onReveal, page]);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  const updateGeometry = useCallback(() => {
    if (
      mode !== "tour" ||
      !activeStep ||
      activeStep.page !== page ||
      (activeStep.needsProject && !hasProject) ||
      (activeStep.needsClips && !hasClips)
    ) {
      setGeometry(null);
      return;
    }
    const target = findTarget(activeStep.target);
    if (!target) {
      setGeometry(null);
      return;
    }
    if (revealedTarget.current !== target) {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      revealedTarget.current = target;
    }
    const source = target.getBoundingClientRect();
    const width = Math.min(
      POPOVER_WIDTH,
      Math.max(270, window.innerWidth - 32),
    );
    const left = Math.min(
      Math.max(16, source.left + source.width / 2 - width / 2),
      Math.max(16, window.innerWidth - width - 16),
    );
    const rect = {
      top: Math.max(8, source.top - 7),
      left: Math.max(8, source.left - 7),
      width: Math.max(
        0,
        Math.min(window.innerWidth - 8, source.right + 7) -
          Math.max(8, source.left - 7),
      ),
      height: Math.max(
        0,
        Math.min(window.innerHeight - 8, source.bottom + 7) -
          Math.max(8, source.top - 7),
      ),
    };
    const below = source.bottom + 17;
    const above = source.top - ESTIMATED_HEIGHT - 17;
    const placement =
      below + ESTIMATED_HEIGHT < window.innerHeight - 12
        ? "below"
        : above > 12
          ? "above"
          : "center";
    setGeometry({
      rect,
      popover: {
        top:
          placement === "below"
            ? below
            : placement === "above"
              ? above
              : Math.max(14, (window.innerHeight - ESTIMATED_HEIGHT) / 2),
        left,
      },
      placement,
    });
  }, [activeStep, hasClips, hasProject, mode, page]);
  useEffect(() => {
    if (mode !== "tour") return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateGeometry);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer.disconnect();
    };
  }, [mode, updateGeometry]);
  useEffect(() => {
    if (mode === "welcome")
      window.setTimeout(() => welcomeRef.current?.focus(), 0);
    if (mode === "tour")
      window.setTimeout(() => popoverRef.current?.focus(), 0);
  }, [mode, stepIndex]);
  useEffect(() => {
    if (mode === "closed") return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTour("dismissed");
        return;
      }
      if (event.key !== "Tab") return;
      const container =
        mode === "welcome" ? welcomeRef.current : popoverRef.current;
      const items = focusable(container);
      if (!container || !items.length) {
        event.preventDefault();
        container?.focus();
        return;
      }
      const first = items[0],
        last = items[items.length - 1];
      if (!container.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const container =
        mode === "welcome" ? welcomeRef.current : popoverRef.current;
      if (container && !container.contains(event.target as Node))
        (focusable(container)[0] ?? container).focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [closeTour, mode]);

  if (mode === "closed" || !activeStep) return null;
  const next = () =>
    stepIndex >= tourSteps.length - 1
      ? closeTour("completed")
      : setStepIndex((value) => value + 1);
  const back = () => setStepIndex((value) => Math.max(0, value - 1));
  const unavailable =
    (!!activeStep.needsProject && !hasProject) ||
    (!!activeStep.needsClips && !hasClips);
  const targetMissing =
    !!activeStep.target &&
    !geometry &&
    !unavailable &&
    activeStep.page === page;
  const layerClass = `guided-tour-layer${reducedMotion ? " guided-tour-reduced-motion" : ""}`;
  if (mode === "welcome")
    return (
      <div className={layerClass}>
        <div className="guided-tour-scrim" aria-hidden="true" />
        <section
          ref={welcomeRef}
          className="guided-tour-welcome"
          role="dialog"
          aria-modal="true"
          aria-labelledby="guided-tour-welcome-title"
          tabIndex={-1}
        >
          <span className="guided-tour-mark" aria-hidden="true">
            ◌
          </span>
          <p className="guided-tour-kicker">A practical walkthrough</p>
          <h2 id="guided-tour-welcome-title">From source to publish</h2>
          <p>
            Follow the complete path through import, setup, editing, proof,
            export, and explicit publishing.
          </p>
          <p className="guided-tour-meta">
            {tourSteps.length} steps · You can pause or skip at any time
          </p>
          <div className="guided-tour-actions guided-tour-actions-welcome">
            <button className="guided-tour-primary" onClick={() => startTour()}>
              Start tour
            </button>
            <button
              className="guided-tour-secondary"
              onClick={() => closeTour("dismissed")}
            >
              Not now
            </button>
          </div>
        </section>
      </div>
    );
  const popoverStyle: CSSProperties = geometry
    ? { top: geometry.popover.top, left: geometry.popover.left }
    : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  return (
    <div className={layerClass}>
      {geometry ? (
        <div
          className="guided-tour-spotlight"
          aria-hidden="true"
          style={{
            top: geometry.rect.top,
            left: geometry.rect.left,
            width: geometry.rect.width,
            height: geometry.rect.height,
          }}
        />
      ) : (
        <div className="guided-tour-scrim" aria-hidden="true" />
      )}
      <section
        ref={popoverRef}
        className={`guided-tour-popover${geometry ? ` guided-tour-placement-${geometry.placement}` : " guided-tour-popover-fallback"}`}
        style={popoverStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-tour-step-title"
        aria-describedby="guided-tour-step-body"
        tabIndex={-1}
        onKeyDown={(event: ReactKeyboardEvent<HTMLElement>) => {
          if (event.key === "Enter" && event.target === event.currentTarget)
            next();
        }}
      >
        <div className="guided-tour-popover-head">
          <span className="guided-tour-chapter">{activeStep.chapter}</span>
          <span className="guided-tour-step-count">
            {stepIndex + 1} of {tourSteps.length}
          </span>
          <button
            className="guided-tour-skip"
            type="button"
            onClick={() => closeTour("dismissed")}
          >
            Skip tour
          </button>
        </div>
        <h2 id="guided-tour-step-title">{activeStep.title}</h2>
        <p id="guided-tour-step-body">{activeStep.body}</p>
        {unavailable && (
          <p className="guided-tour-meta">
            {!hasProject
              ? "Import or open a project to try this step. You can continue reading the walkthrough now."
              : "Generate at least one clip to try this step in the editor."}
          </p>
        )}
        {targetMissing && (
          <p className="guided-tour-meta">
            This option appears when it applies to your current project.
          </p>
        )}
        <div className="guided-tour-actions">
          <button
            className="guided-tour-secondary"
            type="button"
            onClick={back}
            disabled={stepIndex === 0}
          >
            Back
          </button>
          <button className="guided-tour-primary" type="button" onClick={next}>
            {stepIndex === tourSteps.length - 1 ? "Done" : "Next"}
          </button>
        </div>
      </section>
    </div>
  );
}
