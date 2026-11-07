import { cross, dot, joinWindingLoops, mul, requireBrep, sub, uvTriangles } from './brep-mesh.mjs';

const bounded = n => Math.max(0, Math.min(1, n));
const midpoint = (a, b) => a.map((value, i) => (value + b[i]) / 2);
const length = vector => Math.hypot(...vector);

function segmentError(point, a, b) {
  const edge = sub(b, a), offset = sub(point, a);
  const squared = dot(edge, edge);
  return length(sub(offset, mul(edge, squared ? bounded(dot(offset, edge) / squared) : 0)));
}

function triangleError(point, [a, b, c]) {
  const ab = sub(b, a), bc = sub(c, b), ca = sub(a, c);
  const normal = cross(ab, bc), area = length(normal);
  if (area && dot(normal, cross(ab, sub(point, a))) >= 0 && dot(normal, cross(bc, sub(point, b))) >= 0 &&
    dot(normal, cross(ca, sub(point, c))) >= 0) return Math.abs(dot(normal, sub(point, a))) / area;
  return Math.min(segmentError(point, a, b), segmentError(point, b, c), segmentError(point, c, a));
}

export function parametricSurface(evaluate, [uSteps, vSteps] = [8, 8]) {
  let grid;
  let lastProjection;
  function tangent(uv, axis) {
    const a = uv.slice(), b = uv.slice();
    a[axis] = bounded(a[axis] - 1e-5);
    b[axis] = bounded(b[axis] + 1e-5);
    return mul(sub(evaluate(...b), evaluate(...a)), 1 / (b[axis] - a[axis]));
  }
  function inverse(point, tolerance, seed, approximate = 0) {
    const distance = p => length(sub(p, point));
    function solve(initial) {
      let uv = initial, p = evaluate(...uv), error = distance(p);
      for (let i = 0; i < 32 && error > tolerance; i++) {
        const a = tangent(uv, 0), b = tangent(uv, 1), d = sub(point, p);
        const aa = dot(a, a), ab = dot(a, b), bb = dot(b, b), det = aa * bb - ab * ab;
        if (det <= aa * bb * 1e-13) break;
        const da = dot(d, a), db = dot(d, b);
        const du = (bb * da - ab * db) / det, dv = (aa * db - ab * da) / det;
        let changed = false;
        for (let scale = 1; scale >= 1 / 64; scale /= 2) {
          const next = [bounded(uv[0] + du * scale), bounded(uv[1] + dv * scale)];
          const mapped = evaluate(...next), nextError = distance(mapped);
          if (nextError >= error) continue;
          uv = next;
          p = mapped;
          error = nextError;
          changed = true;
          break;
        }
        if (!changed) break;
      }
      return { uv, point: p, error };
    }
    let best = seed && solve(seed);
    if (best?.error <= Math.max(tolerance, approximate)) return best;
    grid ??= Array.from({ length: (uSteps + 1) * (vSteps + 1) }, (_, i) => {
      const uv = [Math.floor(i / (vSteps + 1)) / uSteps, (i % (vSteps + 1)) / vSteps];
      return { uv, point: evaluate(...uv) };
    });
    const candidates = grid.map(entry => ({ uv: entry.uv, distance: distance(entry.point) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 4);
    for (const candidate of candidates) {
      const next = solve(candidate.uv);
      if (!best || next.error < best.error) best = next;
      if (best.error <= tolerance) break;
    }
    return best;
  }
  return { evaluate, inverse,
    constraint(point, reach) {
      const projected = inverse(point, 1e-10, lastProjection, reach);
      requireBrep(projected.error <= reach, '交线采样超出样条面的局部范围。');
      lastProjection = projected.uv;
      const vector = cross(tangent(projected.uv, 0), tangent(projected.uv, 1));
      const size = length(vector);
      requireBrep(size > 1e-20, '曲面交线所在样条面法向不确定。');
      const normal = mul(vector, 1 / size);
      return [dot(sub(point, projected.point), normal), normal];
    } };
}

function periodicBand(loops, periodic) {
  if (loops.length !== 2 || loops.some(ring => ring.length < 3)) return null;
  const axis = periodic?.findIndex((wrap, i) => wrap && loops.every(ring =>
    ring.every(point => Math.abs(point[1 - i] - ring[0][1 - i]) <= 1e-8)));
  if (!(axis >= 0)) return null;

  const turn = 2 * Math.PI;
  const winding = [];
  const angular = loops.map(ring => {
    let previous = ring[0][axis];
    const points = ring.map(point => {
      const value = point[axis];
      previous = value + Math.round(previous - value);
      return [point[1 - axis], turn * previous];
    });
    winding.push(Math.round(previous - ring[0][axis]));
    return points;
  });
  if (Math.abs(winding[0]) !== 1 || winding[1] !== -winding[0]) return null;
  return joinWindingLoops(angular, winding).map(ring =>
    ring.map(([linear, angle]) => axis === 0 ? [angle / turn, linear] : [linear, angle / turn]));
}

function unwrapExtrusionTrim(loops, periodic) {
  const domain = [];
  let reference = loops[0][0][0];
  for (const loop of loops) {
    let previous = reference;
    const ring = loop.map(([u, v]) => {
      previous = u + Math.round(previous - u);
      return [previous, v];
    });
    if (Math.abs(previous - ring[0][0]) > 0.5) {
      const band = periodicBand(loops, periodic);
      requireBrep(band, 'Parasolid 椭圆拉伸面的整圈修剪超出预览范围。');
      return band;
    }
    domain.push(ring);
    const angles = ring.map(([u]) => u);
    reference = (Math.min(...angles) + Math.max(...angles)) / 2;
  }
  return domain;
}

export function* parametricFace(surface, rings, tolerance, chord, reverse, boundaryTolerances) {
  const loops = rings.map((ring, index) => {
    let seed;
    return ring.map((point, vertex) => {
      const limit = boundaryTolerances?.[index][vertex] ?? tolerance;
      const result = surface.inverse(point, Math.min(limit, chord * 0.1), seed);
      requireBrep(result.error <= limit, '样条面边界无法落在原曲面上。');
      seed = result.uv;
      return seed;
    });
  });
  if (surface.unwrapTrim) {
    yield* parametricTriangles(surface.evaluate, unwrapExtrusionTrim(loops, surface.periodic), chord, reverse);
    return;
  }
  try {
    yield* parametricTriangles(surface.evaluate, loops, chord, reverse);
  } catch (error) {
    if (error.message !== '实体面的边界没有可预览的面积。') throw error;
    const band = periodicBand(loops, surface.periodic);
    if (!band) throw error;
    yield* parametricTriangles(surface.evaluate, band, chord, reverse);
  }
}

export function* parametricTriangles(evaluate, loops, chord, reverse) {
  function* triangle(uv, points, depth) {
    const middle = [midpoint(uv[0], uv[1]), midpoint(uv[1], uv[2]), midpoint(uv[2], uv[0])];
    const positions = middle.map(t => evaluate(...t));
    const centerUv = uv[0].map((value, i) => (value + uv[1][i] + uv[2][i]) / 3);
    const center = evaluate(...centerUv);
    const errors = positions.map((p, i) => segmentError(p, points[i], points[(i + 1) % 3]));
    const worst = Math.max(...errors);
    if (worst <= chord && triangleError(center, points) <= chord) {
      const [a, b, c] = points;
      yield reverse ? [...a, ...c, ...b] : [...a, ...b, ...c];
      return;
    }
    requireBrep(depth < 25, '样条面离散未达到预览容差。');
    if (errors.filter(error => error > chord).length > 1) {
      for (let i = 0; i < 3; i++) {
        const k = (i + 2) % 3;
        yield* triangle([uv[i], middle[i], middle[k]], [points[i], positions[i], positions[k]], depth + 1);
      }
      yield* triangle(middle, positions, depth + 1);
    } else if (worst > chord) {
      const i = errors.indexOf(worst), j = (i + 1) % 3, k = (i + 2) % 3;
      yield* triangle([uv[i], middle[i], uv[k]], [points[i], positions[i], points[k]], depth + 1);
      yield* triangle([middle[i], uv[j], uv[k]], [positions[i], points[j], points[k]], depth + 1);
    } else {
      for (let i = 0; i < 3; i++) {
        const j = (i + 1) % 3;
        yield* triangle([uv[i], uv[j], centerUv], [points[i], points[j], center], depth + 1);
      }
    }
  }
  for (const uv of uvTriangles(loops, 1e-8)) yield* triangle(uv, uv.map(t => evaluate(...t)), 0);
}
