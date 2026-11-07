import { add, axes, cross, dot, localPoint, mul, near, requireBrep, sub, worldPoint } from './brep-mesh.mjs';
import { sampleParametric, splineAxis, splineEdge } from './spline-basis.mjs';
import { xtSplineSurface } from './xt-surfaces.mjs';
import { parametricSurface } from './parametric-face.mjs';
import { xtBlendContact, xtRollingBlend } from './xt-blend.mjs';

export function xtVector(value) {
  requireBrep(Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n)));
  return value;
}

export function xtFrame(geometry) {
  return axes(xtVector(geometry.position), xtVector(geometry.axis), xtVector(geometry.x));
}

export function xtAnalyticSurface(surface) {
  requireBrep([50, 51, 52, 53, 54].includes(surface.type), 'Parasolid 暂未适配曲面类型 ' + surface.type + '。');
  const frame = xtFrame(surface);
  const slope = surface.type === 52 ? surface.sine / surface.cosine : 0;
  const radius = surface.radius;
  requireBrep(Number.isFinite(slope) && (surface.type === 50 || Number.isFinite(radius) && radius > 0));
  return { kind: surface.type, frame, radius, slope, major: surface.major };
}

function revolvedCircle(surface, circle) {
  const frame = xtFrame(surface);
  const generator = xtFrame(circle);
  const [x, y, z] = localPoint(frame, generator.origin);
  const major = Math.hypot(x, y), radius = circle.major;
  requireBrep(major > radius && radius > 0 && Math.abs(dot(frame.z, generator.z)) < 1e-8 &&
    Math.abs(dot(sub(generator.origin, frame.origin), generator.z)) < major * 1e-8, 'Parasolid 回转圆与环面参数不一致。');
  function raw(u, v) {
    const point = worldPoint(generator, radius * Math.cos(u), radius * Math.sin(u), 0);
    const [x, y, z] = localPoint(frame, point);
    const c = Math.cos(v), s = Math.sin(v);
    return worldPoint(frame, x * c - y * s, x * s + y * c, z);
  }
  return { kind: 54, frame: { ...frame, origin: worldPoint(frame, 0, 0, z) }, major, radius, raw };
}

function ellipticProfile(geometry, axis) {
  const frame = xtFrame(geometry);
  const major = geometry.major, minor = geometry.minor ?? major;
  requireBrep(major > 0 && minor > 0 && Math.abs(Math.abs(dot(axis, frame.z)) - 1) < 1e-8,
    'Parasolid 椭圆拉伸方向与截面不垂直。');
  const high = 2 * Math.PI;
  return {
    dimensions: 3,
    axis: { low: 0, high },
    periodic: true,
    evaluate: u => worldPoint(frame, major * Math.cos(u), minor * Math.sin(u), 0),
    parameter(point) {
      const [x, y] = localPoint(frame, point);
      return (Math.atan2(y / minor, x / major) + high) % high;
    },
  };
}

function extrudedSpline(surface, profile, offset = 0) {
  const axis = xtVector(surface.axis);
  requireBrep(Math.abs(dot(axis, axis) - 1) < 1e-8 && profile.dimensions === 3, 'Parasolid 拉伸曲面的方向或样条维度无效。');
  const { low, high } = profile.axis;
  const span = high - low;
  const origin = profile.evaluate(low);
  const height = p => dot(sub(p, origin), axis);
  const projected = p => sub(p, mul(axis, height(p)));
  const clamp = u => profile.periodic ? u : Math.max(low, Math.min(high, u));
  function section(u) {
    const p = profile.evaluate(clamp(u));
    if (!offset) return p;
    const step = span * 1e-5;
    const tangent = sub(profile.evaluate(clamp(u + step)), profile.evaluate(clamp(u - step)));
    const normal = cross(tangent, axis);
    const length = Math.hypot(...normal);
    requireBrep(length > Math.hypot(...tangent) * 1e-8, 'Parasolid 拉伸偏移面的法向不确定。');
    return add(p, mul(normal, offset / length));
  }
  function raw(u, v) {
    requireBrep(Number.isFinite(u) && Number.isFinite(v) &&
      (profile.periodic || u >= low - span * 1e-8 && u <= high + span * 1e-8), 'Parasolid 拉伸曲面参数超出范围。');
    return add(section(u), mul(axis, v));
  }
  const evaluate = (u, v) => raw(low + span * u, v);
  const strip = parametricSurface((u, v) => add(projected(section(low + span * u)), mul(axis, v - 0.5)));
  return { raw, evaluate, ...(profile.periodic && { periodic: [true, false], unwrapTrim: true }),
    inverse(point, tolerance, seed) {
      if (profile.parameter && !offset) {
        const u = profile.parameter(point), v = height(point);
        const error = Math.hypot(...sub(point, raw(u, v)));
        if (error <= tolerance) return { uv: [u / span, v], error };
      }
      const { uv, error } = strip.inverse(projected(point), tolerance, seed && [seed[0], 0.5]);
      return { uv: [uv[0], height(point) - height(section(low + span * uv[0]))], error };
    },
    constraint: (point, reach) => strip.constraint(projected(point), reach),
  };
}

export function xtSurfacePoint({ kind, frame, radius, slope, major }, u, v) {
  if (kind === 50) return worldPoint(frame, u, v, 0);
  const z = kind === 53 || kind === 54 ? radius * Math.sin(v) : v;
  const r = kind === 53 || kind === 54 ? (major ?? 0) + radius * Math.cos(v) : radius + slope * z;
  return worldPoint(frame, r * Math.cos(u), r * Math.sin(u), z);
}

function distanceToSurface({ kind, frame, radius, slope, major }, p) {
  const [x, y, z] = localPoint(frame, p);
  if (kind === 50) return [z, frame.z];
  const radial = Math.hypot(x, y);
  if (kind === 53) {
    const r = Math.hypot(x, y, z);
    requireBrep(r > 0);
    return [r - radius, mul(sub(p, frame.origin), 1 / r)];
  }
  requireBrep(radial > 0, '曲面交线经过无法求法向的轴线。');
  const normal = add(mul(frame.x, x / radial), mul(frame.y, y / radial));
  if (kind === 54) {
    const offset = radial - major, r = Math.hypot(offset, z);
    requireBrep(r > 0);
    return [r - radius, add(mul(normal, offset / r), mul(frame.z, z / r))];
  }
  return [radial - radius - slope * z, sub(normal, mul(frame.z, slope))];
}

function refineIntersection(surfaces, guess, reach) {
  let p = guess;
  for (let i = 0; i < 18; i++) {
    const [u, a] = surfaces[0].constraint(p, reach), [v, b] = surfaces[1].constraint(p, reach);
    if (Math.max(Math.abs(u), Math.abs(v)) <= 1e-10) return p;
    const aa = dot(a, a), ab = dot(a, b), bb = dot(b, b), det = aa * bb - ab * ab;
    requireBrep(det > aa * bb * 1e-13, 'Parasolid 曲面交线附近的曲面相切，无法判定分支。');
    p = add(p, add(mul(a, (ab * v - bb * u) / det), mul(b, (ab * u - aa * v) / det)));
    requireBrep(near(p, guess, reach), 'Parasolid 曲面交线离开原文件记录的分支。');
  }
  throw new Error('Parasolid 曲面交线未收敛。');
}

function chartPosition(points, target, tolerance) {
  let best = Infinity, position, span;
  for (let i = 1; i < points.length; i++) {
    const delta = sub(points[i], points[i - 1]), relative = sub(target, points[i - 1]);
    const length2 = dot(delta, delta);
    if (!length2) continue;
    const t = Math.max(0, Math.min(1, dot(relative, delta) / length2));
    const distance = Math.hypot(...sub(relative, mul(delta, t)));
    if (distance >= best) continue;
    best = distance;
    position = i - 1 + t;
    span = Math.sqrt(length2);
  }
  requireBrep(best <= Math.max(tolerance, span * 0.3), 'Parasolid 曲面交线图表与拓扑顶点不符。');
  return position;
}

export function xtCurveEvaluator(node, chord = 8e-6, evaluationLimit, usePeriodicSections = false) {
  const curves = new Map(), surfaces = new Map();
  function extrusion(geometry, offset = 0) {
    const basis = node(geometry.basis);
    requireBrep([31, 32, 134].includes(basis.type), 'Parasolid 拉伸曲面基线暂未适配。');
    const profile = basis.type === 134 ? spline(basis) : ellipticProfile(basis, xtVector(geometry.axis));
    return extrudedSpline(geometry, profile, offset);
  }
  function surface(id) {
    if (!surfaces.has(id)) {
      const geometry = node(id);
      if (geometry.type === 56) surfaces.set(id, xtRollingBlend(geometry, node, surface, refineIntersection));
      else if (geometry.type === 59) surfaces.set(id, xtBlendContact(geometry, node, surface));
      else if (geometry.type === 124) surfaces.set(id, xtSplineSurface(geometry, node, 0, evaluationLimit));
      else if (geometry.type === 67) surfaces.set(id, extrusion(geometry));
      else if (geometry.type === 60) {
        const basis = node(geometry.basis);
        requireBrep([67, 124].includes(basis.type) && Number.isFinite(geometry.offsetDistance) && ['+', '-'].includes(basis.sense),
          'Parasolid 偏移面参数或基础曲面暂未适配。');
        const offset = geometry.offsetDistance * (basis.sense === '-' ? -1 : 1);
        surfaces.set(id, basis.type === 67 ? extrusion(basis, offset)
          : xtSplineSurface(basis, node, offset, evaluationLimit));
      } else {
        const analytic = geometry.type === 68 ? revolvedCircle(geometry, node(geometry.basis, 31)) : xtAnalyticSurface(geometry);
        surfaces.set(id, { ...analytic, raw: analytic.raw ?? ((u, v) => xtSurfacePoint(analytic, u, v)),
          constraint: p => distanceToSurface(analytic, p) });
      }
    }
    return surfaces.get(id);
  }
  function spline(curve) {
    if (curves.has(curve)) return curves.get(curve);
    const { degree, count, dimensions, knotCount, rational, points, multiples, knots } = node(curve.nurbs, 136);
    const values = node(points, 45).values;
    const storedBreaks = node(knots, 128).values;
    const storedMultiples = node(multiples, 127).values;
    // Some parameter-space curves reserve two unused knot slots.
    const padded = storedBreaks.length === knotCount + 2 && storedMultiples.length === knotCount + 2 &&
      storedBreaks.slice(knotCount).every(value => value === null) && storedMultiples.slice(knotCount).every(value => value === 0);
    requireBrep([2, 3, 4].includes(dimensions) && values.length === count * dimensions &&
      (padded || storedBreaks.length === knotCount && storedMultiples.length === knotCount),
      'Parasolid B 样条控制点数量不符。');
    const axis = splineAxis(degree, count, storedBreaks.slice(0, knotCount), storedMultiples.slice(0, knotCount));
    const controls = Array.from({ length: count }, (_, i) => values.slice(i * dimensions, (i + 1) * dimensions));
    requireBrep(controls.every(p => p.every(Number.isFinite) && (!rational || p.at(-1) > 0)), 'Parasolid B 样条权重无效。');
    const evaluate = t => {
      const p = axis.evaluate(controls, t);
      return rational ? mul(p.slice(0, -1), 1 / p.at(-1)) : p;
    };
    const result = { axis, evaluate, dimensions: dimensions - Number(rational) };
    curves.set(curve, result);
    return result;
  }
  function splinePoints(curve, start, end, forward, tolerance, range) {
    const onSurface = curve.type === 137;
    const model = spline(onSurface ? node(curve.parameterCurve, 134) : curve);
    requireBrep(model.dimensions === (onSurface ? 2 : 3), 'Parasolid 样条维度与拓扑不符。');
    const face = onSurface ? surface(curve.surface) : null;
    let evaluate = face ? t => face.raw(...model.evaluate(t)) : model.evaluate;
    const { low, high, spans } = model.axis;
    const period = high - low;
    const wraps = range && (range[0] < low || range[1] > high) && range[1] - range[0] <= period * (1 + 1e-8);
    const wrap = t => t >= low && t <= high ? t : low + ((t - low) % period + period) % period;
    const matches = (fn, lo, hi) => near(fn(lo), forward ? start : end, tolerance) &&
      near(fn(hi), forward ? end : start, tolerance);
    if (face?.kind === 52 && start) {
      const [lo, hi] = range ?? [low, high];
      const axial = wraps ? matches(evaluate, wrap(lo), wrap(hi)) : lo >= low && hi <= high && matches(evaluate, lo, hi);
      if (!axial) evaluate = t => {
        const [u, v] = model.evaluate(t);
        return face.raw(u, -v);
      };
    }
    if (!start) {
      const a = evaluate(model.axis.low), b = evaluate(model.axis.high);
      requireBrep(near(a, b, tolerance), 'Parasolid 样条闭合边缺少顶点。');
      start = end = a;
    }
    if (wraps && near(evaluate(low), evaluate(high), tolerance)) {
      const wrapped = t => evaluate(wrap(t));
      if (matches(wrapped, ...range)) {
        const firstCycle = Math.floor((range[0] - low) / period);
        const knots = [];
        for (let cycle = firstCycle; cycle <= firstCycle + 2; cycle++) {
          for (const knot of spans.slice(0, -1)) {
            const shifted = knot + cycle * period;
            if (shifted > range[0] && shifted < range[1]) knots.push(shifted);
          }
        }
        return splineEdge({ low: range[0], high: range[1], spans: knots }, wrapped, start, end, forward, tolerance, chord, range);
      }
    }
    // Re-use a stored trim interval when its endpoints verify against this
    // exact curve. Some tolerant fins use a differently scaled parameter range.
    const usable = range && range[0] >= low && range[1] <= high && matches(evaluate, ...range);
    if (!usable && face?.blend && range && range[0] >= low && range[1] <= high) {
      const { extent, radius } = face.blend;
      const source = range.map(t => model.evaluate(t));
      const endpoints = forward ? [start, end] : [end, start];
      const mapped = endpoints.map((point, i) => face.inverse(point, tolerance / 10,
        [Math.max(0, Math.min(1, source[i][0] / extent)), source[i][1]]));
      const corrections = mapped.map(({ uv }, i) => [uv[0] * extent - source[i][0], uv[1] - source[i][1]]);
      if (mapped.every(({ error }) => error <= tolerance) &&
          corrections.every(([u, v]) => Math.abs(u) <= radius * 0.25 && Math.abs(v) <= 0.2)) {
        const fitted = t => {
          const weight = (t - range[0]) / (range[1] - range[0]);
          const uv = model.evaluate(t).map((value, i) => value + (1 - weight) * corrections[0][i] + weight * corrections[1][i]);
          return face.raw(...uv);
        };
        return splineEdge(model.axis, fitted, start, end, forward, tolerance, chord, range);
      }
    }
    return splineEdge(model.axis, evaluate, start, end, forward, tolerance, chord, usable ? range : undefined);
  }
  function periodicSection(surfaces, vertices, tolerance) {
    const plane = surfaces.find(surface => surface.kind === 50);
    const spline = surfaces.find(surface => surface.periodic?.some(Boolean));
    if (!plane || !spline || spline.periodic.every(Boolean)) return null;
    const axis = spline.periodic.findIndex(Boolean), fixedAxis = 1 - axis;
    const projections = vertices.map(point => spline.inverse(point, 1e-10));
    const fixed = Math.round(projections[0].uv[fixedAxis]);
    if (projections.some(({ uv, error }) => error > tolerance || Math.abs(uv[fixedAxis] - fixed) > 1e-6)) return null;

    let previous = projections[0].uv[axis];
    const parameters = projections.map(({ uv }) => {
      previous = uv[axis] + Math.round(previous - uv[axis]);
      return previous;
    });
    const evaluate = t => spline.evaluate(...(axis === 0 ? [t, fixed] : [fixed, t]));
    const result = [vertices[0]];
    for (let i = 1; i < parameters.length; i++) {
      if (parameters[i] === parameters[i - 1]) continue;
      const points = sampleParametric(evaluate, parameters.slice(i - 1, i + 1), chord);
      if (points.some(point => Math.abs(plane.constraint(point)[0]) > tolerance)) return null;
      result.push(...points.slice(1));
      requireBrep(result.length <= 16_384, 'Parasolid 曲面交线离散超过预览容量。');
    }
    if (result.length < 3 || !near(result.at(-1), vertices.at(-1), tolerance)) return null;
    result[result.length - 1] = vertices.at(-1);
    return result;
  }
  function intersectionPoints(curve, start, end, forward, tolerance) {
    const chart = node(curve.chart, 40);
    requireBrep(chart.samples.length === chart.count && chart.count >= 2 && chart.count <= 16_384,
      'Parasolid 曲面交线缺少有效图表。');
    const samples = chart.samples.map(xtVector);
    const limits = [curve.limitStart, curve.limitEnd].map(id => id ? node(id, 41) : null);
    const periodic = limits.some(limit => limit?.kind === 'H');
    if (!periodic && !near(samples[0], samples.at(-1), tolerance)) {
      if (limits[0]?.samples.length && !near(limits[0].samples[0], samples[0], tolerance)) samples.unshift(xtVector(limits[0].samples[0]));
      if (limits[1]?.samples.length && !near(limits[1].samples[0], samples.at(-1), tolerance)) samples.push(xtVector(limits[1].samples[0]));
    }
    // An intersection chart can store the common closing point in its two limit records.
    const joined = near(samples[0], samples.at(-1), tolerance);
    const closed = periodic || joined;
    if (periodic && !joined) samples.push(samples[0]);
    const constraints = curve.surfaces.map(surface);
    requireBrep(constraints.every(item => !item.contactSupport || curve.surfaces.includes(item.contactSupport)),
      'Parasolid 圆角接触边与原支撑面不符。');
    if (!start) {
      requireBrep(closed, 'Parasolid 开放曲面交线缺少顶点。');
      start = end = samples[0];
    }
    const [first, last] = forward ? [start, end] : [end, start];
    const error = Math.max(tolerance, (chart.error ?? 0) * 2);
    const from = chartPosition(samples, first, error);
    let to = chartPosition(samples, last, error);
    const cycle = samples.length - 1;
    if (closed && to <= from + 1e-9) to += cycle;
    requireBrep(to > from, 'Parasolid 曲面交线的图表方向与拓扑不符。');
    const vertices = [first];
    for (let i = Math.floor(from) + 1; i < to - 1e-9; i++) {
      const p = samples[i % cycle];
      if (!near(p, vertices.at(-1), 1e-10)) vertices.push(p);
    }
    if (near(last, vertices.at(-1), 1e-10)) vertices[vertices.length - 1] = last;
    else vertices.push(last);
    if (usePeriodicSections) {
      const section = periodicSection(constraints, vertices, Math.max(tolerance, 1e-7));
      if (section) return forward ? section : section.reverse();
    }
    const result = [first];
    for (let i = 1; i < vertices.length; i++) {
      const a = vertices[i - 1], b = vertices[i], delta = sub(b, a);
      const reach = Math.max(tolerance * 4, Math.hypot(...delta) * 0.75);
      const evaluate = t => t === 0 ? a : t === 1 ? b : refineIntersection(constraints, add(a, mul(delta, t)), reach);
      result.push(...sampleParametric(evaluate, [0, 1], chord).slice(1));
      requireBrep(result.length <= 16_384, 'Parasolid 曲面交线离散超过预览容量。');
    }
    if (!forward) result.reverse();
    return result;
  }
  return { splinePoints, intersectionPoints, surface };
}
