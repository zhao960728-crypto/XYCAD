import { dot, near, requireBrep, sub } from './brep-mesh.mjs';

export function deBoor(values, knots, degree, span, parameter) {
  return evaluateSpan(values.slice(span - degree, span + 1), knots, degree, span, parameter);
}

function evaluateSpan(work, knots, degree, span, parameter) {
  for (let level = 1; level <= degree; level++) {
    for (let i = degree; i >= level; i--) {
      const left = knots[span - degree + i], right = knots[span + i + 1 - level];
      const fraction = right === left ? 0 : (parameter - left) / (right - left);
      work[i] = work[i - 1].map((value, axis) => value * (1 - fraction) + work[i][axis] * fraction);
    }
  }
  return work[degree];
}

export function splineAxis(degree, count, breaks, multiplicities) {
  requireBrep(Number.isInteger(degree) && degree >= 1 && degree <= 15 && count > degree && count <= 8192 &&
    Array.isArray(breaks) && breaks.length >= 2 && breaks.length === multiplicities?.length, '样条控制数据无效。');
  const knots = [];
  for (let i = 0; i < breaks.length; i++) {
    const t = breaks[i], n = multiplicities[i];
    requireBrep(Number.isFinite(t) && (i === 0 || t > breaks[i - 1]) && Number.isInteger(n) &&
      n > 0 && n <= degree + 1 && knots.length + n <= count + degree + 1, '样条节点向量无效。');
    for (let j = 0; j < n; j++) knots.push(t);
  }
  requireBrep(knots.length === count + degree + 1 && knots[degree] < knots[count], '样条参数范围无效。');
  const low = knots[degree], high = knots[count];
  const spans = breaks.filter(t => t >= low && t <= high);
  function spanAt(t) {
    let a = degree, b = count - 1;
    while (a < b) {
      const mid = (a + b) >>> 1;
      if (t < knots[mid + 1]) b = mid;
      else a = mid + 1;
    }
    return a;
  }
  return { low, high, spans,
    evaluate: (points, t) => deBoor(points, knots, degree, spanAt(t), t),
    evaluateWith(pointAt, t) {
      const span = spanAt(t);
      const work = Array.from({ length: degree + 1 }, (_, i) => pointAt(span - degree + i));
      return evaluateSpan(work, knots, degree, span, t);
    } };
}

export function sampleParametric(evaluate, cuts, tolerance) {
  const points = [evaluate(cuts[0])];
  function split(lo, hi, a, b, depth) {
    const delta = sub(b, a), length2 = dot(delta, delta);
    const mid = (lo + hi) / 2;
    const middle = evaluate(mid);
    function deviation(p) {
      const relative = sub(p, a);
      const fraction = length2 ? Math.max(0, Math.min(1, dot(relative, delta) / length2)) : 0;
      return Math.hypot(...relative.map((value, i) => value - fraction * delta[i]));
    }
    const flat = [evaluate((lo + mid) / 2), middle, evaluate((mid + hi) / 2)]
      .every(p => deviation(p) <= tolerance);
    if (!flat) {
      requireBrep(depth < 16 && mid !== lo && mid !== hi, '曲线离散无法达到预览容差。');
      split(lo, mid, a, middle, depth + 1);
      split(mid, hi, middle, b, depth + 1);
    } else {
      requireBrep(points.length < 16_384, '曲线离散超过预览容量。');
      points.push(b);
    }
  }
  for (let i = 1; i < cuts.length; i++) split(cuts[i - 1], cuts[i], points.at(-1), evaluate(cuts[i]), 0);
  return points;
}

function parameterAt(evaluate, spans, point, preferEnd, tolerance) {
  const end = preferEnd ? spans.at(-1) : spans[0];
  if (near(evaluate(end), point, tolerance)) return end;
  const distance = t => Math.hypot(...sub(evaluate(t), point));
  let best = Infinity, start, stop;
  for (let i = 1; i < spans.length; i++) {
    const lo = spans[i - 1], hi = spans[i], step = (hi - lo) / 8;
    for (let j = 0; j <= 8; j++) {
      const t = j === 8 ? hi : lo + j * step, d = distance(t);
      if (d >= best) continue;
      best = d;
      start = Math.max(lo, t - step);
      stop = Math.min(hi, t + step);
    }
  }
  for (let i = 0; i < 42; i++) {
    const a = start + (stop - start) / 3, b = stop - (stop - start) / 3;
    if (distance(a) <= distance(b)) stop = b;
    else start = a;
  }
  const found = (start + stop) / 2;
  requireBrep(distance(found) <= tolerance, '样条曲线与拓扑顶点超出几何容差。');
  return found;
}

export function splineEdge(axis, evaluate, start, end, forward, tolerance, chord, range) {
  const [first, last] = forward ? [start, end] : [end, start];
  const from = range?.[0] ?? parameterAt(evaluate, axis.spans, first, false, tolerance);
  const to = range?.[1] ?? parameterAt(evaluate, axis.spans, last, true, tolerance);
  requireBrep(from >= axis.low && to <= axis.high && from < to &&
    near(evaluate(from), first, tolerance) && near(evaluate(to), last, tolerance), '样条修剪范围与拓扑不符。');
  const cuts = [from, ...axis.spans.filter(t => t > from && t < to), to];
  const result = sampleParametric(evaluate, cuts, chord);
  if (!forward) result.reverse();
  result[0] = start;
  result[result.length - 1] = end;
  return result;
}
