// The shuttlecock arc: a little flight across the screen whenever something
// is served (it flies away from you) or returned (it flies toward you).
//
// How it works: we sample points along a parabola and hand them to the Web
// Animations API as keyframes. At each point we also rotate the shuttle to
// match the direction of travel (the slope of the curve), so the cork
// always leads, like a real shuttle.

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const SVG_NS = 'http://www.w3.org/2000/svg';
const STEPS = 24;

/** @param kind 'serve' (from you, bottom-left -> top-right) or 'return' */
export function flyShuttle(kind = 'serve') {
  if (reducedMotion.matches) return;
  const layer = document.getElementById('flight-layer');
  if (!layer) return;

  // <svg><use href="#shuttle"/></svg>, reusing the symbol in index.html.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'flight');
  svg.setAttribute('viewBox', '0 0 64 64');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#shuttle');
  svg.append(use);
  layer.append(svg);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const size = 44;
  const low = { x: w * 0.12, y: h * 0.78 };
  const high = { x: w * 0.82, y: h * 0.18 };
  const [from, to] = kind === 'serve' ? [low, high] : [high, low];
  const peak = Math.min(h * 0.35, 260); // how far above the straight line it arcs

  const frames = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    // Straight line from -> to, lifted by a parabola that is 0 at both ends
    // and `peak` in the middle: 4t(1-t) peaks at 1 when t = 0.5.
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t - peak * 4 * t * (1 - t);
    // Derivative of the same curve = direction of travel.
    const dx = to.x - from.x;
    const dy = to.y - from.y - peak * 4 * (1 - 2 * t);
    // The symbol's cork points "up" (-y); rotate so it points along travel.
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    frames.push({
      transform: `translate(${x - size / 2}px, ${y - size / 2}px) rotate(${angle}deg)`,
      opacity: i === STEPS ? 0 : 1,
    });
  }

  svg.animate(frames, { duration: 950, easing: 'cubic-bezier(.3,.1,.4,1)' }).finished
    .catch(() => {})
    .finally(() => svg.remove());
}
