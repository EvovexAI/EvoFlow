"use client";

import {
  guidedTourContentByLocale,
  type GuidedTourStep,
} from "@ai-site/content";
import { GlassPanel, StatusChip, buttonClassName } from "@ai-site/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocalizedValue } from "../locale-provider";

type TourSurface = "floating" | "revisit" | "tour" | "welcome";

interface TourSnapshot {
  completed: boolean;
  hasSeenWelcome: boolean;
  lastStepId: GuidedTourStep["id"] | null;
  mode: "explore" | "tour";
  version: number;
}

const TOUR_STORAGE_KEY = "ai-site-home-tour";
const TOUR_STORAGE_VERSION = 1;

/** Set false on EvoFlow marketing site — hides welcome / revisit modals and the floating guide. */
export const ENABLE_HOME_GUIDED_TOUR = false;

const defaultSnapshot: TourSnapshot = {
  completed: false,
  hasSeenWelcome: false,
  lastStepId: null,
  mode: "explore",
  version: TOUR_STORAGE_VERSION,
};

const emptySubscribe = () => () => undefined;

function useHydrated() {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

function readSnapshot(): TourSnapshot {
  if (typeof window === "undefined") {
    return defaultSnapshot;
  }

  try {
    const raw = window.localStorage.getItem(TOUR_STORAGE_KEY);

    if (!raw) {
      return defaultSnapshot;
    }

    const parsed = JSON.parse(raw) as Partial<TourSnapshot>;

    if (parsed.version !== TOUR_STORAGE_VERSION) {
      return defaultSnapshot;
    }

    return {
      completed: parsed.completed ?? false,
      hasSeenWelcome: parsed.hasSeenWelcome ?? false,
      lastStepId: parsed.lastStepId ?? null,
      mode: parsed.mode === "tour" ? "tour" : "explore",
      version: TOUR_STORAGE_VERSION,
    };
  } catch {
    return defaultSnapshot;
  }
}

function getInitialSurface(snapshot: TourSnapshot): TourSurface {
  if (!snapshot.hasSeenWelcome) {
    return "welcome";
  }

  if (snapshot.mode === "tour" && !snapshot.completed && snapshot.lastStepId) {
    return "revisit";
  }

  return "floating";
}

function getInitialStepIndex(
  snapshot: TourSnapshot,
  steps: GuidedTourStep[],
): number {
  const stepIndex = steps.findIndex((step) => step.id === snapshot.lastStepId);
  return stepIndex >= 0 ? stepIndex : 0;
}

function formatRevisitDescription(template: string, stepTitle: string) {
  return template.replace("{step}", stepTitle);
}

export function useHomeTour() {
  const content = useLocalizedValue(guidedTourContentByLocale);
  const hydrated = useHydrated();
  const [snapshot, setSnapshot] = useState<TourSnapshot>(() => readSnapshot());
  const [surface, setSurface] = useState<TourSurface>(() =>
    getInitialSurface(readSnapshot()),
  );
  const [stepIndex, setStepIndex] = useState(() =>
    getInitialStepIndex(readSnapshot(), content.steps),
  );

  const activeStep = content.steps[stepIndex] ?? content.steps[0];
  const activeTargetId =
    ENABLE_HOME_GUIDED_TOUR && surface === "tour" ? activeStep.targetId : null;
  const lastStep =
    content.steps.find((step) => step.id === snapshot.lastStepId) ?? activeStep;

  useEffect(() => {
    if (!ENABLE_HOME_GUIDED_TOUR || !hydrated) {
      return;
    }

    window.localStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(snapshot));
  }, [hydrated, snapshot]);

  useEffect(() => {
    if (surface !== "tour" || !activeStep) {
      return;
    }

    const target = document.getElementById(activeStep.targetId);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeStep, surface]);

  const persistTourState = useCallback((stepId: GuidedTourStep["id"]) => {
    setSnapshot((current) => ({
      ...current,
      hasSeenWelcome: true,
      lastStepId: stepId,
      mode: "tour",
    }));
  }, []);

  const startTour = useCallback(
    (requestedStepId?: GuidedTourStep["id"]) => {
      const nextIndex = requestedStepId
        ? content.steps.findIndex((step) => step.id === requestedStepId)
        : 0;
      const resolvedIndex = nextIndex >= 0 ? nextIndex : 0;
      const resolvedStep = content.steps[resolvedIndex] ?? content.steps[0];

      setStepIndex(resolvedIndex);
      setSurface("tour");
      persistTourState(resolvedStep.id);
    },
    [content.steps, persistTourState],
  );

  const exploreOnOwn = useCallback(() => {
    setSurface("floating");
    setSnapshot((current) => ({
      ...current,
      hasSeenWelcome: true,
      mode: current.lastStepId && !current.completed ? "tour" : "explore",
    }));
  }, []);

  const nextStep = useCallback(() => {
    if (stepIndex >= content.steps.length - 1) {
      setSurface("floating");
      setSnapshot((current) => ({
        ...current,
        completed: true,
        hasSeenWelcome: true,
        lastStepId: activeStep.id,
        mode: "tour",
      }));
      return;
    }

    const nextIndex = stepIndex + 1;
    const nextStepItem = content.steps[nextIndex];

    setStepIndex(nextIndex);
    persistTourState(nextStepItem.id);
  }, [activeStep.id, content.steps, persistTourState, stepIndex]);

  const previousStep = useCallback(() => {
    if (stepIndex <= 0) {
      return;
    }

    const previousIndex = stepIndex - 1;
    const previousStepItem = content.steps[previousIndex];

    setStepIndex(previousIndex);
    persistTourState(previousStepItem.id);
  }, [content.steps, persistTourState, stepIndex]);

  const pauseTour = useCallback(() => {
    setSurface("floating");
    setSnapshot((current) => ({
      ...current,
      hasSeenWelcome: true,
      lastStepId: activeStep.id,
      mode: "tour",
    }));
  }, [activeStep.id]);

  const openGuide = useCallback(() => {
    if (snapshot.mode === "tour" && !snapshot.completed && snapshot.lastStepId) {
      setSurface("revisit");
      return;
    }

    if (snapshot.completed || snapshot.lastStepId) {
      setSurface("revisit");
      return;
    }

    setSurface("welcome");
  }, [snapshot.completed, snapshot.lastStepId, snapshot.mode]);

  const tourUi = useMemo(() => {
    if (!ENABLE_HOME_GUIDED_TOUR || !hydrated) {
      return null;
    }

    return (
      <HomeTourOverlay
        activeStep={activeStep}
        lastStep={lastStep}
        onContinue={() => startTour(snapshot.lastStepId ?? activeStep.id)}
        onExplore={exploreOnOwn}
        onNext={nextStep}
        onOpenGuide={openGuide}
        onPrevious={previousStep}
        onRestart={() => startTour()}
        onSkip={pauseTour}
        onStart={() => startTour()}
        stepIndex={stepIndex}
        surface={surface}
        totalSteps={content.steps.length}
      />
    );
  }, [
    activeStep,
    content.steps.length,
    exploreOnOwn,
    hydrated,
    lastStep,
    nextStep,
    openGuide,
    pauseTour,
    previousStep,
    snapshot.lastStepId,
    startTour,
    stepIndex,
    surface,
  ]);

  return {
    activeTargetId,
    tourUi,
  };
}

function HomeTourOverlay({
  activeStep,
  lastStep,
  onContinue,
  onExplore,
  onNext,
  onOpenGuide,
  onPrevious,
  onRestart,
  onSkip,
  onStart,
  stepIndex,
  surface,
  totalSteps,
}: {
  activeStep: GuidedTourStep;
  lastStep: GuidedTourStep;
  onContinue: () => void;
  onExplore: () => void;
  onNext: () => void;
  onOpenGuide: () => void;
  onPrevious: () => void;
  onRestart: () => void;
  onSkip: () => void;
  onStart: () => void;
  stepIndex: number;
  surface: TourSurface;
  totalSteps: number;
}) {
  const content = useLocalizedValue(guidedTourContentByLocale);

  if (surface === "floating") {
    return (
      <button
        aria-label={content.floating.title}
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-3 rounded-full border border-white/12 bg-black/55 px-4 py-3 text-sm text-foreground shadow-[0_20px_50px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/35"
        onClick={onOpenGuide}
        type="button"
      >
        <span className="pulse-dot h-2.5 w-2.5 rounded-full bg-secondary" />
        <span className="font-display-ui">{content.floating.label}</span>
      </button>
    );
  }

  if (surface === "welcome") {
    return (
      <GlassPanel className="fixed bottom-6 left-1/2 z-40 flex w-[min(680px,calc(100vw-1.5rem))] -translate-x-1/2 items-start gap-5 rounded-[28px] p-6 md:p-7">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/25 bg-primary/12 text-primary">
          AI
        </div>
        <div className="min-w-0 flex-1">
          <StatusChip tone="secondary">{content.welcome.eyebrow}</StatusChip>
          <h2 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em] md:text-3xl">
            {content.welcome.title}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-foreground-muted md:text-base">
            {content.welcome.description}
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button className={buttonClassName()} onClick={onStart} type="button">
              {content.welcome.tourLabel}
            </button>
            <button
              className={buttonClassName({ variant: "secondary" })}
              onClick={onExplore}
              type="button"
            >
              {content.welcome.exploreLabel}
            </button>
          </div>
        </div>
      </GlassPanel>
    );
  }

  if (surface === "revisit") {
    return (
      <GlassPanel className="fixed bottom-6 left-1/2 z-40 flex w-[min(680px,calc(100vw-1.5rem))] -translate-x-1/2 items-start gap-5 rounded-[28px] p-6 md:p-7">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-secondary/25 bg-secondary/12 text-secondary">
          AI
        </div>
        <div className="min-w-0 flex-1">
          <StatusChip tone="primary">{content.revisit.eyebrow}</StatusChip>
          <h2 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em] md:text-3xl">
            {content.revisit.title}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-foreground-muted md:text-base">
            {formatRevisitDescription(content.revisit.description, lastStep.title)}
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              className={buttonClassName()}
              onClick={onContinue}
              type="button"
            >
              {content.revisit.continueLabel}
            </button>
            <button
              className={buttonClassName({ variant: "secondary" })}
              onClick={onRestart}
              type="button"
            >
              {content.revisit.restartLabel}
            </button>
            <button
              className={buttonClassName({ variant: "ghost" })}
              onClick={onExplore}
              type="button"
            >
              {content.revisit.exploreLabel}
            </button>
          </div>
        </div>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel className="fixed bottom-6 left-1/2 z-40 flex w-[min(760px,calc(100vw-1.5rem))] -translate-x-1/2 items-start gap-6 rounded-[28px] p-6 md:p-7">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusChip tone="secondary">{content.tour.eyebrow}</StatusChip>
          <p className="font-label-ui text-[11px] uppercase tracking-[0.22em] text-foreground-muted">
            {content.tour.progressLabel} {stepIndex + 1} / {totalSteps}
          </p>
        </div>
        <h2 className="font-display-ui mt-4 text-2xl font-semibold tracking-[-0.04em] md:text-3xl">
          {activeStep.title}
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-foreground-muted md:text-base">
          {activeStep.description}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            className={buttonClassName({ variant: "secondary" })}
            disabled={stepIndex === 0}
            onClick={onPrevious}
            type="button"
          >
            {content.tour.previousLabel}
          </button>
          <button className={buttonClassName()} onClick={onNext} type="button">
            {stepIndex === totalSteps - 1
              ? content.tour.doneLabel
              : content.tour.nextLabel}
          </button>
          <button
            className={buttonClassName({ variant: "ghost" })}
            onClick={onSkip}
            type="button"
          >
            {content.tour.skipLabel}
          </button>
        </div>
      </div>
    </GlassPanel>
  );
}
