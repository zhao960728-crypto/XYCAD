import { joinWindingLoops, localPoint, requireBrep, worldPoint } from './brep-mesh.mjs';
import { parametricTriangles } from './parametric-face.mjs';

const turn = 2 * Math.PI;
const unwrap = (angle, previous) => angle + turn * Math.round((previous - angle) / turn);

export function* torusFace(frame, major, minor, rings, tolerance, chord, reverse) {
  requireBrep(Number.isFinite(major) && Number.isFinite(minor) && major > 0 && minor > 0, '环面半径无效或超出预览范围。');
  // Scan along the major angle so the sampled rim already divides the long arcs.
  const evaluate = (v, u) => {
    const radius = major + minor * Math.cos(v);
    return worldPoint(frame, radius * Math.cos(u), radius * Math.sin(u), minor * Math.sin(v));
  };
  let reference;
  const winding = [];
  const loops = rings.map(ring => {
    let previous = reference;
    const loop = ring.map(point => {
      const [x, y, z] = localPoint(frame, point);
      const radius = Math.hypot(x, y) - major;
      requireBrep(Math.abs(Math.hypot(radius, z) - minor) <= tolerance, '环面边界超出几何容差。');
      const angles = [Math.atan2(y, x), Math.atan2(z, radius)];
      previous = previous ? angles.map((angle, i) => unwrap(angle, previous[i])) : angles;
      return previous;
    });
    requireBrep(loop.length);
    winding.push(loop[0].map((angle, i) => Math.round((previous[i] - angle) / turn)));
    reference ??= [0, 1].map(i => {
      const angles = loop.map(uv => uv[i]);
      return (Math.min(...angles) + Math.max(...angles)) / 2;
    });
    return loop;
  });
  const majorWrap = winding.some(wrap => wrap[0]);
  const minorWrap = winding.some(wrap => wrap[1]);
  requireBrep(!(majorWrap && minorWrap), '环面同时沿两条参数轴整圈缠绕。');
  const swap = points => points.map(ring => ring.map(([u, v]) => [v, u]));
  const domain = majorWrap ? joinWindingLoops(swap(loops), winding.map(wrap => wrap[0])) :
    minorWrap ? swap(joinWindingLoops(loops, winding.map(wrap => wrap[1]))) : swap(loops);
  if (major <= minor) {
    // The outer branch has a nonnegative radius. A trim crossing the axis
    // needs another parameter chart for the reflected branch.
    let low = Infinity, high = -Infinity;
    for (const ring of domain) for (const [v] of ring) {
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
    const center = turn * Math.round((low + high) / (2 * turn));
    const limit = Math.acos(-major / minor);
    requireBrep(low > center - limit + 1e-8 && high < center + limit - 1e-8,
      '环面修剪跨越回转轴，需要独立参数区。');
  }
  yield* parametricTriangles(evaluate, domain, chord, !reverse);
}
