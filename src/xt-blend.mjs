import { add, dot, mul, near, requireBrep, sub } from './brep-mesh.mjs';
import { parametricSurface } from './parametric-face.mjs';
import { sampleParametric } from './spline-basis.mjs';

const length = value => Math.hypot(...value);
const interpolate = (a, b, t) => add(a, mul(sub(b, a), t));

function unit(vector) {
  const magnitude = length(vector);
  requireBrep(magnitude > 1e-10, 'Parasolid 圆角截面方向不确定。');
  return mul(vector, 1 / magnitude);
}

function blendSupports(geometry, node, surface) {
  const radius = Math.abs(geometry.offsets?.[0]);
  requireBrep(geometry.blendKind === 'R' && Number.isFinite(radius) && radius > 0 &&
    Math.abs(Math.abs(geometry.offsets[1]) - radius) <= radius * 1e-8 &&
    geometry.rates?.every(value => value === 1), 'Parasolid 圆角半径或变化规律暂未适配。');
  const bases = geometry.supports.map(id => node(id));
  requireBrep(bases.every(base => [50, 67, 124].includes(base.type) && ['+', '-'].includes(base.sense)),
    'Parasolid 圆角的支撑面暂未适配。');
  const supports = geometry.supports.map(surface);
  const offsets = geometry.offsets.map((value, i) => value * (bases[i].sense === '-' ? -1 : 1));
  return { radius, supports, offsets };
}

export function xtBlendContact(geometry, node, surface) {
  const blend = node(geometry.blend, 56), side = 1 - geometry.side;
  requireBrep(side === 0 || side === 1, 'Parasolid 圆角接触边侧别无效。');
  const { radius, supports, offsets } = blendSupports(blend, node, surface);
  return {
    contactSupport: blend.supports[side],
    constraint(point, reach) {
      const [gap, normal] = supports[side].constraint(point, reach + radius);
      const center = add(point, mul(normal, offsets[side] - gap));
      const [distance, opposite] = supports[1 - side].constraint(center, reach + radius);
      return [distance - offsets[1 - side], sub(opposite, mul(normal, dot(normal, opposite)))];
    },
  };
}

export function xtRollingBlend(geometry, node, surface, refineIntersection) {
  const { radius, supports, offsets } = blendSupports(geometry, node, surface);
  const spine = node(geometry.spine, 38), chart = node(spine.chart, 40);
  requireBrep(chart.count === chart.samples.length && chart.count >= 2 && chart.count <= 4096 &&
    chart.samples.every(point => point?.length === 3 && point.every(Number.isFinite)), 'Parasolid 圆角中心轨迹缺少有效采样。');
  let samples = chart.samples.slice();
  const [start, end] = [spine.limitStart, spine.limitEnd].map(id => id ? node(id, 41).samples[0] : null);
  if (start && !near(start, samples[0], 1e-10)) samples.unshift(start);
  if (end && !near(end, samples.at(-1), 1e-10)) samples.push(end);
  if (chart.firstParameter < 0) {
    // The saved zero section can follow samples with negative spine parameters.
    let offset = chart.firstParameter, best = Math.abs(offset), anchor = 0;
    for (let i = 1; i < samples.length; i++) {
      offset += length(sub(samples[i], samples[i - 1]));
      if (Math.abs(offset) < best) { best = Math.abs(offset); anchor = i; }
    }
    requireBrep(best <= Math.min(chart.error, radius), 'Parasolid 圆角轨迹无法定位参数原点。');
    samples = samples.slice(anchor);
  }

  const centerSurfaces = supports.map((support, i) => ({
    constraint(point, reach) {
      const [distance, normal] = support.constraint(point, reach + radius);
      return [distance - offsets[i], normal];
    },
  }));
  const centers = [samples[0]];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const span = length(sub(b, a));
    if (span <= 1e-12) continue;
    const reach = Math.max(radius * 2, span * 0.75);
    const evaluate = t => t === 0 ? a : t === 1 ? b : refineIntersection(centerSurfaces, interpolate(a, b, t), reach);
    for (const point of sampleParametric(evaluate, [0, 1], Math.min(2e-7, radius * 0.002)).slice(1)) centers.push(point);
    requireBrep(centers.length <= 4096, 'Parasolid 圆角中心轨迹超过离散预算。');
  }
  let extent = 0;
  const positions = centers.map((point, i) => i ? extent += length(sub(point, centers[i - 1])) : 0);
  requireBrep(extent > 0, 'Parasolid 圆角中心轨迹长度无效。');
  const normals = centers.map(point => supports.map((support, i) =>
    mul(unit(support.constraint(point, radius * 6)[1]), -Math.sign(offsets[i]))));

  function raw(u, v) {
    const distance = Math.max(0, Math.min(extent, u));
    let lo = 0, hi = positions.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (positions[mid] <= distance) lo = mid;
      else hi = mid;
    }
    const t = (distance - positions[lo]) / (positions[hi] - positions[lo]);
    const center = interpolate(centers[lo], centers[hi], t);
    const [a, b] = normals[lo].map((normal, i) => unit(interpolate(normal, normals[hi][i], t)));
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
    requireBrep(angle < Math.PI - 1e-8, 'Parasolid 圆角截面弧的方向不确定。');
    const direction = angle < 1e-6 ? unit(interpolate(a, b, v)) :
      add(mul(a, Math.sin((1 - v) * angle) / Math.sin(angle)), mul(b, Math.sin(v * angle) / Math.sin(angle)));
    return add(center, mul(direction, radius));
  }
  return { ...parametricSurface((u, v) => raw(u * extent, v), [18, 4]), raw, blend: { extent, radius } };
}
