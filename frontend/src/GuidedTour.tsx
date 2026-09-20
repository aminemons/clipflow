import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "./GuidedTour.css";

export type TourPage =
  | "projects"
  | "editor"
  | "exports"
  | "publish"
  | "settings";

export type GuidedTourProps = {
  page: TourPage;
  onNavigate: (page: TourPage) => void;
  onReveal?: (target: string) => void;
  hasProject: boolean;
  replayToken: number;
};

type TourStep = {
  page: TourPage;
  target: string;
  title: string;
  body: string;
};

type Rect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type Geometry = {
  rect: Rect | null;
  popover: { top: number; left: number };
  placement: "above" | "below" | "center";
};

const STORAGE_KEY = "clipflow:tour:v2";
const POPOVER_WIDTH = 340;
const ESTIMATED_POPOVER_HEIGHT = 220;

const projectSteps: TourStep[] = [
  {
    page: "projects",
    target: "projects-nav",
    title: "Your project space",
    body: "Open a project from the library, or make a new one.",
  },
  {
    page: "projects",
    target: "project-library",
    title: "Project library",
    body: "Your sources and recent work live here. Open one to continue.",
  },
  {
    page: "projects",
    target: "new-project",
    title: "Create a project",
    body: "Upload a file, or check a YouTube link and choose its download quality. Importing saves the source without creating clips.",
  },
];

const editorSteps: TourStep[] = [
  {
    page: "editor",
    target: "editor-generation",
    title: "Configure before generating",
    body: "Choose moments, camera framing and captions in Clip setup. Review the settings, then choose Generate clips. Each result can be edited independently.",
  },
  {
    page: "editor",
    target: "editor-clip-name",
    title: "Name the selected clip",
    body: "Give the clip a useful name while it is fresh. The name follows it through review, export, and publishing.",
  },
  {
    page: "editor",
    target: "editor-save",
    title: "Save your settings",
    body: "Save the camera and caption changes before rendering so the proof uses the settings you can review.",
  },
  {
    page: "editor",
    target: "editor-render",
    title: "Render a preview",
    body: "Render a proof when you want to check the exact framing and captions before export.",
  },
  {
    page: "editor",
    target: "editor-preview",
    title: "Preview",
    body: "Play the selected clip here and render a proof to check framing and captions.",
  },
  {
    page: "editor",
    target: "editor-timeline",
    title: "Timeline",
    body: "Set the in and out points precisely for this clip.",
  },
  {
    page: "editor",
    target: "editor-captions",
    title: "Captions",
    body: "Transcribe speech, import subtitles, choose a style, and position the text.",
  },
  {
    page: "editor",
    target: "editor-export",
    title: "Export",
    body: "Export this clip here, or export several clips together from the library.",
  },
];

const trailingSteps: TourStep[] = [
  {
    page: "exports",
    target: "exports-nav",
    title: "Exports",
    body: "Download finished clips here and check processing progress or failed jobs.",
  },
  {
    page: "publish",
    target: "publish-nav",
    title: "Review before posting",
    body: "Approve the rendered files, select the approved clips to post, and review destinations and text. Publishing requires a separate confirmation.",
  },
  {
    page: "settings",
    target: "settings-nav",
    title: "Settings",
    body: "Choose transcription and highlight providers, save API keys, and manage storage.",
  },
];

function readTourState(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeTourState(value: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Private browsing and embedded previews may disable local storage.
  }
}

function isVisible(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function findTarget(name: string) {
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>("[data-tour]"),
  );
  return targets.find(
    (element) => element.dataset.tour === name && isVisible(element),
  );
}

function getPageStart(steps: TourStep[], page: TourPage) {
  const index = steps.findIndex((step) => step.page === page);
  return index < 0 ? 0 : index;
}

function focusable(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => isVisible(element));
}

export default function GuidedTour({
  page,
  onNavigate,
  onReveal,
  hasProject,
  replayToken,
}: GuidedTourProps) {
  const allSteps = useMemo(
    () => [
      ...projectSteps,
      ...(hasProject ? editorSteps : []),
      ...trailingSteps,
    ],
    [hasProject],
  );
  // Keep the tour anchored to the screen the person is already using. A step
  // that silently navigates away leaves the spotlight with no real target.
  const steps = useMemo(
    () => allSteps.filter((step) => step.page === page),
    [allSteps, page],
  );
  const [mode, setMode] = useState<"welcome" | "tour" | "closed">(() =>
    readTourState() ? "closed" : "welcome",
  );
  const [stepIndex, setStepIndex] = useState(0);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const popoverRef = useRef<HTMLElement>(null);
  const welcomeRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const lastReplayToken = useRef(replayToken);
  const activeStep = steps[stepIndex];

  const rememberFocus = useCallback(() => {
    const current = document.activeElement;
    returnFocusRef.current = current instanceof HTMLElement ? current : null;
  }, []);

  const restoreFocus = useCallback(() => {
    const element = returnFocusRef.current;
    returnFocusRef.current = null;
    if (element && document.contains(element)) {
      window.setTimeout(() => element.focus(), 0);
    }
  }, []);

  const closeTour = useCallback(
    (state: "dismissed" | "completed") => {
      writeTourState(state);
      setMode("closed");
      setGeometry(null);
      restoreFocus();
    },
    [restoreFocus],
  );

  const startTour = useCallback(
    (index = 0) => {
      rememberFocus();
      writeTourState("started");
      setStepIndex(index);
      setGeometry(null);
      setMode("tour");
    },
    [rememberFocus],
  );

  useEffect(() => {
    if (lastReplayToken.current === replayToken) return;
    lastReplayToken.current = replayToken;
    startTour(0);
  }, [replayToken, startTour]);

  useEffect(() => {
    if (mode !== "tour") return;
    setStepIndex(0);
    setGeometry(null);
  }, [mode, page]);

  useEffect(() => {
    if (mode === "tour" && activeStep) onReveal?.(activeStep.target);
  }, [activeStep, mode, onReveal]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  const updateGeometry = useCallback(() => {
    if (mode !== "tour" || !activeStep || activeStep.page !== page) return;
    const target = findTarget(activeStep.target);
    const width = Math.min(
      POPOVER_WIDTH,
      Math.max(260, window.innerWidth - 32),
    );
    if (!target) {
      setGeometry(null);
      return;
    }
    const source = target.getBoundingClientRect();
    const padding = 7;
    const viewportLeft = 8;
    const viewportTop = 8;
    const viewportRight = Math.max(viewportLeft, window.innerWidth - 8);
    const viewportBottom = Math.max(viewportTop, window.innerHeight - 8);
    const clippedLeft = Math.max(
      viewportLeft,
      Math.min(source.left, viewportRight),
    );
    const clippedTop = Math.max(
      viewportTop,
      Math.min(source.top, viewportBottom),
    );
    const clippedRight = Math.max(
      clippedLeft,
      Math.min(source.right, viewportRight),
    );
    const clippedBottom = Math.max(
      clippedTop,
      Math.min(source.bottom, viewportBottom),
    );
    const rect = {
      top: Math.max(viewportTop, clippedTop - padding),
      left: Math.max(viewportLeft, clippedLeft - padding),
      width: Math.min(
        viewportRight - viewportLeft,
        clippedRight - clippedLeft + padding * 2,
      ),
      height: Math.min(
        viewportBottom - viewportTop,
        clippedBottom - clippedTop + padding * 2,
      ),
    };
    const left = Math.min(
      Math.max(16, clippedLeft + (clippedRight - clippedLeft) / 2 - width / 2),
      Math.max(16, window.innerWidth - width - 16),
    );
    const targetFillsViewport =
      source.width >= window.innerWidth - 24 ||
      source.height >= window.innerHeight - 24;
    const belowTop = clippedBottom + 17;
    const aboveTop = clippedTop - ESTIMATED_POPOVER_HEIGHT - 17;
    const canFitBelow =
      belowTop + ESTIMATED_POPOVER_HEIGHT <= window.innerHeight - 14;
    const placement = targetFillsViewport
      ? "center"
      : canFitBelow || clippedTop < ESTIMATED_POPOVER_HEIGHT
        ? "below"
        : "above";
    const preferredTop =
      placement === "center"
        ? (window.innerHeight - ESTIMATED_POPOVER_HEIGHT) / 2
        : placement === "below"
          ? belowTop
          : aboveTop;
    setGeometry({
      rect,
      popover: {
        top: Math.min(
          Math.max(14, preferredTop),
          Math.max(14, window.innerHeight - ESTIMATED_POPOVER_HEIGHT - 14),
        ),
        left,
      },
      placement,
    });
  }, [activeStep, mode, page]);

  useEffect(() => {
    if (mode === "tour") setGeometry(null);
  }, [mode, stepIndex]);

  useEffect(() => {
    if (mode !== "tour" || !activeStep) return;
    let frame = 0;
    let missingTimer: number | null = null;
    let skipTimer: number | null = null;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          if (findTarget(activeStep.target)) {
            if (missingTimer !== null) window.clearTimeout(missingTimer);
            missingTimer = null;
            updateGeometry();
            return;
          }
          if (missingTimer === null) {
            missingTimer = window.setTimeout(() => {
              missingTimer = null;
              updateGeometry();
            }, 180);
          }
        });
      });
    };
    update();
    skipTimer = window.setTimeout(() => {
      if (findTarget(activeStep.target)) return;
      const nextIndex = steps.findIndex(
        (candidate, index) => index > stepIndex && findTarget(candidate.target),
      );
      if (nextIndex >= 0) setStepIndex(nextIndex);
      else closeTour("completed");
    }, 900);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    const retry = window.setTimeout(update, 160);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(retry);
      if (skipTimer !== null) window.clearTimeout(skipTimer);
      if (missingTimer !== null) window.clearTimeout(missingTimer);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer.disconnect();
    };
  }, [activeStep, closeTour, mode, page, stepIndex, steps, updateGeometry]);

  useEffect(() => {
    if (mode === "welcome") {
      window.setTimeout(() => welcomeRef.current?.focus(), 0);
    } else if (mode === "tour") {
      window.setTimeout(() => popoverRef.current?.focus(), 0);
    }
  }, [mode, stepIndex]);

  useEffect(() => {
    if (mode === "closed") return;
    const getContainer = () =>
      mode === "welcome" ? welcomeRef.current : popoverRef.current;
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
      if (!container) return;
      if (!items.length) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
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
      const container = getContainer();
      if (!container || container.contains(event.target as Node)) return;
      const items = focusable(container);
      (items[0] ?? container).focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [closeTour, mode]);

  if (mode === "closed") return null;

  const layerClass = `guided-tour-layer${reducedMotion ? " guided-tour-reduced-motion" : ""}`;

  if (mode === "welcome") {
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
          <p className="guided-tour-kicker">A quick orientation</p>
          <h2 id="guided-tour-welcome-title">Welcome to Clipflow</h2>
          <p>
            Turn long videos into a focused set of clips. This short tour shows
            where to start, review, and export.
          </p>
          <p className="guided-tour-meta">
            About 60 seconds · Replay it from Settings
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
  }

  if (!activeStep) return null;
  const popoverStyle: CSSProperties = geometry
    ? { top: geometry.popover.top, left: geometry.popover.left }
    : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  const next = () => {
    if (stepIndex >= steps.length - 1) {
      closeTour("completed");
      return;
    }
    setStepIndex((index) => index + 1);
  };

  const back = () => setStepIndex((index) => Math.max(0, index - 1));

  const onPopoverKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && event.target === event.currentTarget) next();
  };

  return (
    <div className={layerClass}>
      {geometry ? (
        <div
          className="guided-tour-spotlight"
          aria-hidden="true"
          style={{
            top: geometry.rect!.top,
            left: geometry.rect!.left,
            width: geometry.rect!.width,
            height: geometry.rect!.height,
          }}
        />
      ) : (
        <div className="guided-tour-scrim" aria-hidden="true" />
      )}
      <section
        ref={popoverRef}
        className={`guided-tour-popover${geometry ? ` guided-tour-placement-${geometry.placement}` : ""}`}
        style={popoverStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guided-tour-step-title"
        aria-describedby="guided-tour-step-body"
        tabIndex={-1}
        onKeyDown={onPopoverKeyDown}
      >
        <div className="guided-tour-popover-head">
          <span className="guided-tour-step-count">
            {stepIndex + 1} of {steps.length}
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
            {stepIndex === steps.length - 1 ? "Done" : "Next"}
          </button>
        </div>
      </section>
    </div>
  );
}
