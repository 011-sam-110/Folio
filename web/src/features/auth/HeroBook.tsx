// The warm hero's 3D accent: an opening book, mounted lazily and defensively so it can
// only ever ADD to the existing CSS hero. Three.js is dynamic-imported (a separate chunk),
// the canvas mounts a beat after first paint, and every environment that can't take it
// (no WebGL, tiny/low-core devices) simply keeps the CSS hero - the book never blocks or
// breaks the login page. All the three.js lives in ./heroBookScene; this file only decides
// whether and how to mount it. The host div is aria-hidden - it is pure decoration behind
// the copy, which stays the accessible source of truth.
import { useEffect, useRef } from 'react';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function webglSupported(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

export default function HeroBook() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!webglSupported()) return; // no WebGL -> the CSS hero (glow + sparks) carries on alone

    // Desktop / large-tablet enhancement only. Below the 920px grid collapse the hero is a
    // single column with no safe room for the book, so we leave the CSS sparks to carry it
    // (matching the `display: none` in landing.css). This is the sanctioned mobile fallback:
    // no WebGL cost, no overflow, no jank on phones.
    if (window.matchMedia('(max-width: 920px)').matches) return;

    const cores = navigator.hardwareConcurrency ?? 8;
    const lowPower = cores <= 4; // trim antialias / pixel-ratio / leaves on weak machines
    const reducedMotion = prefersReducedMotion();

    let dispose: (() => void) | null = null;
    let cancelled = false;

    // Lazy + non-blocking: three is fetched only now, after the hero has painted.
    import('./heroBookScene')
      .then(({ mountHeroBook }) => {
        if (cancelled || !hostRef.current) return;
        dispose = mountHeroBook(hostRef.current, { reducedMotion, lowPower });
      })
      .catch(() => {
        /* import/mount failed - leave the CSS hero exactly as it was */
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return <div className="landing-hero__book" aria-hidden="true" ref={hostRef} />;
}
