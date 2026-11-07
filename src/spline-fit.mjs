import { number } from './dxf-parser.mjs';

function fitPoints(entity) {
  const points = [];
  let point;
  for (const [code, value] of entity.groups) {
    if (code === 11) {
      point = [Number(value), NaN, 0];
      points.push(point);
    } else if (point && (code === 21 || code === 31)) {
      point[code === 21 ? 1 : 2] = Number(value);
    }
  }
  return points;
}

// The fit parameter is cumulative chord length. Natural boundary conditions
// are used at ends where the drawing supplies no tangent.
export function fitSplinePath(entity, availableSegments) {
  if (number(entity, 71) !== 3 || (number(entity, 70, 0) & 3)) return null;
  const points = fitPoints(entity);
  const n = points.length;
  if (n < 2 || points.some(point => point.some(value => !Number.isFinite(value) || Math.abs(value) > 1e12))) return null;
  const steps = points.slice(1).map((point, index) =>
    Math.hypot(...point.map((value, axis) => value - points[index][axis])));
  if (steps.some(step => !step)) return null;
  if (n - 1 > availableSegments) throw new Error('样条曲线段数超过本版预览容量。');

  const tangent = code => [number(entity, code, 0), number(entity, code + 10, 0), number(entity, code + 20, 0)];
  const firstTangent = tangent(12);
  const lastTangent = tangent(13);
  const slope = (span, axis) => (points[span + 1][axis] - points[span][axis]) / steps[span];
  const upper = new Float64Array(n);
  const second = Array.from({ length: n }, () => [0, 0]);
  for (let i = 0; i < n; i++) {
    const prev = steps[i - 1] ?? 0;
    const next = steps[i] ?? 0;
    const specified = i === 0 ? firstTangent : i === n - 1 ? lastTangent : null;
    if (specified && !specified.some(Boolean)) continue;
    const divisor = 2 * (prev + next) - (i ? prev * upper[i - 1] : 0);
    upper[i] = next / divisor;
    for (let axis = 0; axis < 2; axis++) {
      const left = prev ? slope(i - 1, axis) : specified[axis];
      const right = next ? slope(i, axis) : specified[axis];
      second[i][axis] = (6 * (right - left) - (i ? prev * second[i - 1][axis] : 0)) / divisor;
    }
  }
  for (let i = n - 2; i >= 0; i--) {
    for (let axis = 0; axis < 2; axis++) second[i][axis] -= upper[i] * second[i + 1][axis];
  }
  const start = points[0].slice(0, 2), end = points.at(-1).slice(0, 2);
  const segments = steps.map((step, i) => {
    const first = [], last = [];
    for (let axis = 0; axis < 2; axis++) {
      const delta = points[i + 1][axis] - points[i][axis];
      const factor = step * step / 18;
      first.push(points[i][axis] + delta / 3 - factor * (2 * second[i][axis] + second[i + 1][axis]));
      last.push(points[i + 1][axis] - delta / 3 - factor * (second[i][axis] + 2 * second[i + 1][axis]));
    }
    return ['C', ...first, ...last, ...points[i + 1].slice(0, 2)];
  });
  if (segments.some(segment => segment.slice(1).some(value => !Number.isFinite(value) || Math.abs(value) > 1e12))) return null;
  const commands = segments.map(segment => segment.join(' '));
  return { path: ['M ' + start.join(' '), ...commands].join(' '), size: n - 1, start, end, continuous: true, segments: commands };
}
