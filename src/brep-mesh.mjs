export const add = (a, b) => a.map((value, i) => value + b[i]);
export const sub = (a, b) => a.map((value, i) => value - b[i]);
export const mul = (v, scale) => v.map(value => value * scale);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const turn = 2 * Math.PI;

export function requireBrep(valid, message = '实体边界的几何或引用不一致。') {
  if (!valid) throw new Error(message);
}

function unit(v) {
  const length = Math.hypot(...v);
  requireBrep(length > 0 && Number.isFinite(length));
  return mul(v, 1 / length);
}

export function axes(origin, axis, reference) {
  const z = unit(axis);
  const guess = reference ?? (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const y = unit(cross(z, guess));
  return { origin, x: cross(y, z), y, z };
}

export function localPoint(frame, point) {
  const delta = sub(point, frame.origin);
  return [dot(delta, frame.x), dot(delta, frame.y), dot(delta, frame.z)];
}

export function worldPoint(frame, x, y, z) {
  return frame.origin.map((value, i) => value + frame.x[i] * x + frame.y[i] * y + frame.z[i] * z);
}

export function near(a, b, tolerance) {
  return Math.hypot(...sub(a, b)) <= tolerance;
}

export function arcPoints(frame, major, minor, from, to, forward, tolerance, closed = false, step = Math.PI / 48) {
  requireBrep(major > 0 && minor > 0);
  const angle = p => {
    const [x, y, z] = localPoint(frame, p);
    requireBrep(Math.abs(z) <= tolerance && Math.abs(Math.hypot(x / major, y / minor) - 1) * Math.max(major, minor) <= tolerance);
    return Math.atan2(y / minor, x / major);
  };
  const start = angle(from), finish = angle(to);
  const direction = forward ? 1 : -1;
  const length = closed || near(from, to, Math.max(major, minor) * 1e-10)
    ? turn : ((finish - start) * direction % turn + turn) % turn;
  requireBrep(length > 0);
  const segments = Math.ceil(length / step);
  const cuts = Array.from({ length: segments - 1 }, (_, i) => length * (i + 1) / segments);
  // Keep world-axis extrema so an arc's reported extents do not depend on the sampling phase.
  for (let i = 0; i < 3; i++) {
    const extremum = Math.atan2(minor * frame.y[i], major * frame.x[i]);
    for (const candidate of [extremum, extremum + Math.PI]) {
      const offset = ((candidate - start) * direction % turn + turn) % turn;
      if (offset > 1e-9 && offset < length - 1e-9) cuts.push(offset);
    }
  }
  cuts.sort((a, b) => a - b);
  const points = [from];
  for (let i = 0; i < cuts.length; i++) {
    if (i && cuts[i] - cuts[i - 1] <= 1e-9) continue;
    const u = start + direction * cuts[i];
    points.push(worldPoint(frame, major * Math.cos(u), minor * Math.sin(u), 0));
  }
  points.push(to);
  return points;
}

function nearestAngle(angle, reference) {
  return angle + Math.round((reference - angle) / turn) * turn;
}

function cutWindingRing(points, winding, seam) {
  const ordered = winding > 0 ? points : points.slice().reverse();
  const first = ordered[0];
  const closed = [...ordered, [first[0], first[1] + turn]];
  let index, cut;
  // A winding trim can turn back locally. Cut where the seam crosses it once.
  for (let i = 1; i < closed.length; i++) {
    const before = closed[i - 1][1], after = closed[i][1];
    const low = Math.floor((Math.min(before, after) - seam) / turn);
    const high = Math.floor((Math.max(before, after) - seam) / turn);
    if (low === high) continue;
    if (index !== undefined || after < before || high - low > 1) return null;
    index = i;
    cut = seam + high * turn;
  }
  if (index === undefined) return null;
  const [afterX, after] = closed[index];
  const [beforeX, before] = closed[Math.max(0, index - 1)];
  const height = beforeX + (afterX - beforeX) * (cut - before) / (after - before);
  const shift = seam - cut;
  return [[height, seam],
    ...ordered.slice(index).map(([x, angle]) => [x, angle + shift]),
    ...ordered.slice(0, index).map(([x, angle]) => [x, angle + shift + turn]),
    [height, seam + turn]];
}

export function joinWindingLoops(loops, winding, tip) {
  const wraps = loops.filter((_, i) => winding[i]);
  const directions = winding.filter(Boolean);
  const hasTip = tip !== undefined;
  requireBrep(wraps.length === (hasTip ? 1 : 2) && directions.every(value => Math.abs(value) === 1),
    '回转面的整圈边界超出预览范围。');
  const holes = loops.filter((_, i) => !winding[i]).map(ring => {
    const angles = ring.map(p => p[1]);
    return { ring, low: Math.min(...angles), high: Math.max(...angles) };
  });
  for (let i = 0; i < 96; i++) {
    const seam = (i + 0.37) * turn / 96;
    if (wraps.some(ring => ring.some(([, angle]) => Math.abs(nearestAngle(angle, seam) - seam) < 1e-8))) continue;
    const shifts = holes.map(({ low }) => Math.ceil((seam - low + 1e-8) / turn) * turn);
    if (holes.some(({ high }, j) => high + shifts[j] > seam + turn - 1e-8)) continue;
    const a = cutWindingRing(wraps[0], directions[0], seam);
    const b = hasTip ? [[tip, seam], [tip, seam + turn]] : cutWindingRing(wraps[1], directions[1], seam);
    if (!a || !b) continue;
    return [[...a, ...b.reverse()], ...holes.map(({ ring }, j) => ring.map(([x, angle]) => [x, angle + shifts[j]]))];
  }
  throw new Error('无法在回转面内环之外建立预览接缝。');
}

function projectedLoops(surface, rings, tolerance) {
  const { frame, radius, slope = 0 } = surface;
  if (radius === undefined) return rings.map(ring => ring.map(point => {
    const [x, y, z] = localPoint(frame, point);
    requireBrep(Math.abs(z) <= tolerance, '平面边界超出几何容差。');
    return [x, y];
  }));
  let reference;
  const winding = [];
  const tips = rings.filter(ring => ring.length === 1);
  requireBrep(tips.length <= 1, '回转面有多个独立尖点。');
  const tip = tips.length ? -radius / slope : undefined;
  if (tips.length) {
    const [x, y, z] = localPoint(frame, tips[0][0]);
    requireBrep(slope && Math.hypot(x, y, z - tip) <= tolerance, '独立顶点不在圆锥尖点。');
  }
  const projected = rings.filter(ring => ring.length > 1).map(ring => {
    let local = ring.map(point => localPoint(frame, point));
    const apex = slope ? local.findIndex(([x, y, h]) => Math.hypot(x, y) <= tolerance * 0.001 &&
      Math.abs(radius + slope * h) <= tolerance * 0.001) : -1;
    if (apex >= 0) local = [...local.slice(apex + 1), ...local.slice(0, apex)];
    let previous = reference;
    const points = local.map(([x, y, h]) => {
      requireBrep(Math.abs(Math.hypot(x, y) - (radius + slope * h)) <= tolerance, '回转面边界超出几何容差。');
      const raw = Math.atan2(y, x);
      const angle = previous === undefined ? raw : nearestAngle(raw, previous);
      previous = angle;
      return [h, angle];
    });
    const first = points[0][1];
    // At the cone tip the incoming and outgoing generators have different angles.
    if (apex >= 0) points.push([-radius / slope, previous], [-radius / slope, first]);
    winding.push(apex >= 0 ? 0 : Math.round((previous - first) / turn));
    reference ??= (Math.min(...points.map(p => p[1])) + Math.max(...points.map(p => p[1]))) / 2;
    return points;
  });
  if (!tips.length && !winding.some(Boolean)) return projected;
  return joinWindingLoops(projected, winding, tip);
}

// Even/odd pairing keeps inner loops open and supports concave outlines.
export function* uvTriangles(loops, epsilon, tolerance = epsilon * 1000, splitCrossings = false) {
  requireBrep(loops.length && loops.every(ring => ring.length >= 3));
  const ys = [];
  for (const loop of loops) for (const [, y] of loop) {
    ys.push(y);
    requireBrep(ys.length <= 16_384, '单个实体面的边界分段超过预览容量。');
  }
  ys.sort((a, b) => a - b);
  const levels = [], snapped = new Map();
  for (const y of ys) {
    if (!levels.length || y - levels.at(-1) > epsilon) levels.push(y);
    snapped.set(y, levels.at(-1));
  }
  const edges = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      let [x0, y0] = loop[i];
      let [x1, y1] = loop[(i + 1) % loop.length];
      y0 = snapped.get(y0);
      y1 = snapped.get(y1);
      if (y0 === y1) continue;
      if (y1 < y0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
      edges.push({ y0, y1, x0, x1 });
    }
  }
  requireBrep(levels.length * edges.length <= 12_000_000, '单个实体面过于复杂。');
  const xAt = (edge, y) => edge.x0 + (edge.x1 - edge.x0) * Math.max(0, Math.min(1, (y - edge.y0) / (edge.y1 - edge.y0)));
  let count = 0;
  let intersectionChecks = 0;
  for (let i = 1; i < levels.length; i++) {
    const low = levels[i - 1], high = levels[i], mid = (low + high) / 2;
    const inside = edges.filter(edge => edge.y0 < mid && mid < edge.y1)
      .map(edge => ({ edge, x: xAt(edge, mid) })).sort((a, b) => a.x - b.x);
    requireBrep(inside.length % 2 === 0, '实体面的边界无法闭合。');
    if (splitCrossings) {
      // The order of two linear segments can switch inside a strip.
      // Split at the first crossing before applying the even/odd fill rule.
      let cut = high;
      const spans = inside.map(({ edge }) => [xAt(edge, low), xAt(edge, high)]);
      intersectionChecks += spans.length * (spans.length - 1) / 2;
      requireBrep(intersectionChecks <= 12_000_000, '实体面的边界交点超过预览预算。');
      for (let a = 0; a < spans.length; a++) for (let b = a + 1; b < spans.length; b++) {
        const before = spans[a][0] - spans[b][0], after = spans[a][1] - spans[b][1];
        if (before * after >= 0) continue;
        const intersection = low + (high - low) * before / (before - after);
        if (intersection > low + epsilon && intersection < cut - epsilon) cut = intersection;
      }
      if (cut < high) {
        requireBrep((levels.length + 1) * edges.length <= 12_000_000, '单个实体面过于复杂。');
        levels.splice(i--, 0, cut);
        continue;
      }
    }
    for (let j = 0; j < inside.length; j += 2) {
      if (inside[j + 1].x - inside[j].x <= tolerance * 0.001) continue;
      const left = inside[j].edge, right = inside[j + 1].edge;
      const x0 = xAt(left, low), x1 = xAt(right, low);
      const x2 = xAt(right, high), x3 = xAt(left, high);
      requireBrep(x0 <= x1 + tolerance && x3 <= x2 + tolerance, '实体面的边界交叉。');
      const a = [x0, low], b = [x1, low], c = [x2, high], d = [x3, high];
      if (x1 - x0 > tolerance * 0.001) { count++; yield [a, b, c]; }
      if (x2 - x3 > tolerance * 0.001) { count++; yield [a, c, d]; }
    }
  }
  requireBrep(count > 0, '实体面的边界没有可预览的面积。');
}

export function* faceTriangles(surface, rings, tolerance, reverse = false, splitCrossings = false) {
  requireBrep(rings.length && rings.every(ring => ring.length >= 3 || surface.slope && ring.length === 1));
  const loops = projectedLoops(surface, rings, tolerance);
  const epsilon = surface.radius === undefined ? tolerance * 0.001 : 1e-9;
  const point = ([x, y]) => {
    if (surface.radius === undefined) return worldPoint(surface.frame, x, y, 0);
    const radius = surface.radius + (surface.slope ?? 0) * x;
    return worldPoint(surface.frame, radius * Math.cos(y), radius * Math.sin(y), x);
  };
  for (const [a, b, c] of uvTriangles(loops, epsilon, tolerance, splitCrossings)) {
    yield (reverse ? [a, c, b] : [a, b, c]).flatMap(point);
  }
}
