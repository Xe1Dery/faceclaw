import { type LayerActions } from "../layers";

/**
 * The slide-up entry of a notification frame over the retained interface
 * (spec 4): the frame starts at the screen's bottom edge and settles at its
 * resting place in SLIDE_MS. Standalone frames (locked glasses) do not slide
 * — they arrive with the screen's brightness transition instead.
 */
const SLIDE_MS = 180;
const SLIDE_STEP_MS = 30;

/**
 * Drives one slide-in by timer steps (no wall clock, so tests with a fake
 * clock stay deterministic). `onOffset` receives the remaining fraction of
 * the slide (1 at the screen's bottom edge, 0 at rest). Returns a cancel for
 * the layer's onRemoved.
 */
export function startSlideIn(actions: LayerActions, onOffset: (remaining: number) => void): () => void {
  const steps = Math.max(1, Math.round(SLIDE_MS / SLIDE_STEP_MS));
  let done = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const step = () => {
    if (cancelled) return;
    done += 1;
    onOffset(Math.max(0, 1 - done / steps));
    if (done >= steps) {
      timer = null;
      return;
    }
    timer = setTimeout(step, SLIDE_STEP_MS);
    actions.requestRender();
  };
  onOffset(1);
  timer = setTimeout(step, SLIDE_STEP_MS);
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}
