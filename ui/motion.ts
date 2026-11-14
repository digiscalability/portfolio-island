/**
 * Motion tokens (D11): one source for how the UI moves. style.css mirrors
 * each as a --ds-dur-* / --ds-ease-* custom property, and
 * test/motionRules.test.ts keeps the two in step and fails the build on an
 * 'infinite' animation or a layout-animating transition outside its
 * allow-list.
 *
 * Everything here animates opacity and transform only (translate and scale
 * are transforms that compose with an element's own transform, so a centred
 * translate(-50%, -50%) panel keeps its place). Reduced motion keeps an
 * opacity-only 120 ms ramp, never a transform.
 */
import { a11y } from '../Accessibility';

export const MOTION = {
  dur: { xs: 90, s: 140, m: 200, l: 240, xl: 450 },
  ease: {
    out: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
    in: 'cubic-bezier(0.4, 0, 1, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  /** A panel's opacity ramp in: between the 140 and 200 steps. */
  panelFadeIn: 180,
  /** The reduced-motion ramp: opacity (and colour) only. */
  reduced: 120,
} as const;

type MotionDur = keyof typeof MOTION.dur;
type MotionEase = keyof typeof MOTION.ease;
/** '--ds-dur-m', '--ds-ease-out': the style.css names. */
export const durVar = (k: MotionDur): string => `--ds-dur-${k}`;
export const easeVar = (k: MotionEase): string => `--ds-ease-${k}`;

const canAnimate = (el: Element | null | undefined): el is HTMLElement =>
  !!el && typeof (el as HTMLElement).animate === 'function';

/** A panel, card or menu arriving: opacity over 180 ms, a small lift and
 *  scale over 240 ms. Reduced motion: opacity over 120 ms. */
export function animateIn(el: HTMLElement | null | undefined): void {
  if (!canAnimate(el)) return;
  const rm = a11y.reducedMotion;
  el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: rm ? MOTION.reduced : MOTION.panelFadeIn,
    easing: MOTION.ease.out,
  });
  if (rm) return;
  el.animate(
    [
      { translate: '0 8px', scale: '0.98' },
      { translate: '0 0', scale: '1' },
    ],
    { duration: MOTION.dur.l, easing: MOTION.ease.out },
  );
}

/** A panel leaving: opacity (and a slight drop) over 140 ms, then done().
 *  Returns the cancel function; with no animation support done() runs now. */
export function animateOut(el: HTMLElement, done: () => void): () => void {
  if (!canAnimate(el)) {
    done();
    return () => {};
  }
  const rm = a11y.reducedMotion;
  const a = el.animate(
    rm
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { opacity: 1, translate: '0 0' },
          { opacity: 0, translate: '0 6px' },
        ],
    { duration: rm ? MOTION.reduced : MOTION.dur.s, easing: MOTION.ease.in, fill: 'forwards' },
  );
  let over = false;
  const finish = (): void => {
    if (over) return;
    over = true;
    a.cancel();
    done();
  };
  a.onfinish = finish;
  return finish;
}

/** A plain opacity fade in (the scrim: 200 ms; reduced motion 120 ms). */
export function fadeIn(el: HTMLElement, ms: number = MOTION.dur.m): void {
  if (!canAnimate(el)) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: a11y.reducedMotion ? MOTION.reduced : ms,
    easing: MOTION.ease.out,
  });
}

/** The HUD settling in after the intro: 220 ms each, 40 ms apart, top to
 *  bottom then left to right. Reduced motion: one 120 ms opacity ramp. */
export function staggerIn(els: HTMLElement[]): void {
  const rm = a11y.reducedMotion;
  const shown = els
    .filter((el) => canAnimate(el) && el.isConnected)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
  shown.forEach(({ el }, i) => {
    el.animate(
      rm
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, translate: '0 -6px' },
            { opacity: 1, translate: '0 0' },
          ],
      {
        duration: rm ? MOTION.reduced : 220,
        delay: rm ? 0 : i * 40,
        easing: MOTION.ease.out,
        fill: 'backwards',
      },
    );
  });
}
