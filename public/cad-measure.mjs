export const drawingUnits = [null, 'in', 'ft', 'mi', 'mm', 'cm', 'm', 'km', 'µin', 'mil', 'yd', 'Å', 'nm',
  'µm', 'dm', 'dam', 'hm', 'Gm', 'AU', 'ly', 'pc', '美制测量英尺', '美制测量英寸', '美制测量码', '美制测量英里'];

const tau = Math.PI * 2;
const sub = (a, b) => a.map((value, i) => value - b[i]);
const norm = point => Math.hypot(...point);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const clamp = value => Math.max(0, Math.min(1, value));
const turn = angle => ((angle % tau) + tau) % tau;
const cross = ([x, y], [u, v]) => x * v - y * u;
const cross3 = ([x, y, z], [u, v, w]) => [y * w - z * v, z * u - x * w, x * v - y * u];

export function distanceBetween(a, b, scale = 1) {
  const delta = sub(b, a).map(value => value * scale);
  return { distance: norm(delta), delta };
}

export function angleBetween(a, vertex, b) {
  const u = sub(a, vertex), v = sub(b, vertex);
  const x = norm(u), y = norm(v);
  if (!x || !y) return null;
  const p = u.map(value => value / x), q = v.map(value => value / y);
  return 2 * Math.atan2(norm(sub(p, q)), norm(p.map((value, i) => value + q[i]))) * 180 / Math.PI;
}

export function nearestOnSegment(point, start, end) {
  const delta = sub(end, start);
  const square = dot(delta, delta);
  if (!square) return start;
  const t = clamp(dot(sub(point, start), delta) / square);
  return start.map((value, i) => value + t * delta[i]);
}

export function triangleArea(a, b, c, scale = 1) {
  const [x, y, z] = sub(b, a).map(value => value * scale);
  const [u, v, w] = sub(c, a).map(value => value * scale);
  return Math.hypot(y * w - z * v, z * u - x * w, x * v - y * u) / 2;
}

export function rimDiameter([a, ...rim]) {
  const offsets = rim.map(point => sub(point, a));
  const span = Math.max(...offsets.map(norm));
  if (!span) return null;
  let best = 0, basis;
  for (let i = 0; i < offsets.length; i++) for (let j = i + 1; j < offsets.length; j++) {
    const u = offsets[i], v = offsets[j], axis = cross3(u, v);
    const square = dot(axis, axis);
    if (square > best) { best = square; basis = { u, v, axis }; }
  }
  if (best < (0.08 * span ** 2) ** 2) return null;
  const { u, v, axis } = basis;
  const first = cross3(v, axis), second = cross3(axis, u);
  const center = first.map((value, i) => (value * dot(u, u) + second[i] * dot(v, v)) / (2 * best));
  const radius = norm(center);
  const normal = axis.map(value => value / Math.sqrt(best));
  const tolerance = radius * 0.025;
  const rays = [center.map(value => -value), ...offsets.map(p => sub(p, center))];
  if (rays.some(ray => Math.abs(dot(ray, normal)) > tolerance || Math.abs(norm(ray) - radius) > tolerance)) return null;
  const x = rays[0].map(value => value / radius), y = cross3(normal, x);
  const angles = rays.map(ray => turn(Math.atan2(dot(ray, y), dot(ray, x)))).sort((a, b) => a - b);
  if (angles.some((angle, i) => {
    const gap = turn(angles[(i + 1) % angles.length] - angle);
    return gap < 0.05 || gap > Math.PI * 1.12;
  })) return null;
  return 2 * radius;
}

export function parallelPlaneSpacing(a, b, scale = 1) {
  if (!a.normal || !b.normal || Math.abs(dot(a.normal, b.normal)) < Math.cos(Math.PI / 1200)) return null;
  return Math.abs(dot(sub(b.point, a.point), a.normal)) * scale;
}

function segmentsIntersect(a, b, c, d) {
  const epsilon = 1e-12;
  if ([0, 1].some(i => Math.max(a[i], b[i]) + epsilon < Math.min(c[i], d[i]) ||
    Math.max(c[i], d[i]) + epsilon < Math.min(a[i], b[i]))) return false;
  const side = (p, q, r) => {
    const value = cross(sub(q, p), sub(r, p));
    return Math.abs(value) <= epsilon ? 0 : Math.sign(value);
  };
  return side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0;
}

export function polygonMetrics(points) {
  const translated = points.map(point => sub(point, points[0]));
  const span = Math.max(...translated.map(norm));
  if (points.length < 3 || !span) return null;
  const polygon = translated.map(point => point.map(value => value / span));
  let area = 0, perimeter = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const length = norm(sub(a, b));
    if (!length) return null;
    for (let j = i + 2; j < polygon.length; j++) {
      if (i === 0 && j === polygon.length - 1) continue;
      if (segmentsIntersect(a, b, polygon[j], polygon[(j + 1) % polygon.length])) return null;
    }
    area += cross(a, b);
    perimeter += length;
  }
  return area ? { area: Math.abs(area / 2) * span ** 2, perimeter: perimeter * span } : null;
}

function transformed([a, b, c, d, x, y], [u, v]) {
  return [a * u + c * v + x, b * u + d * v + y];
}

function arcFromBulge(a, b, bulge) {
  const [dx, dy] = sub(b, a);
  const chord = Math.hypot(dx, dy);
  if (!chord || Math.abs(bulge) < 1e-9) return null;
  const shift = (1 / bulge - bulge) / 4;
  const center = [a[0] + dx / 2 - dy * shift, a[1] + dy / 2 + dx * shift];
  return { center, radius: norm(sub(a, center)), start: Math.atan2(a[1] - center[1], a[0] - center[0]),
    sweep: 4 * Math.atan(bulge) };
}

export function pickDrawingPoint(items, position, tolerance, mode = 'point') {
  const radiusOnly = mode === 'radius';
  const segmentOnly = mode === 'segment';
  let anchor, edge, anchorDistance = tolerance, edgeDistance = tolerance;
  function consider(point, isAnchor = false, geometry) {
    const distance = norm(sub(point, position));
    if (isAnchor && distance <= anchorDistance) {
      anchor = { point };
      anchorDistance = distance;
    } else if (!isAnchor && distance <= edgeDistance) {
      edge = { point, ...geometry };
      edgeDistance = distance;
    }
  }
  function line(matrix, start, end) {
    if (radiusOnly) return;
    const a = transformed(matrix, start), b = transformed(matrix, end), delta = sub(b, a);
    if (segmentOnly) {
      if (delta.some(Boolean)) consider(nearestOnSegment(position, a, b), false, { segment: [a, b] });
    } else {
      consider(a, true);
      consider(b, true);
      consider([a[0] + delta[0] / 2, a[1] + delta[1] / 2], true);
      consider(nearestOnSegment(position, a, b));
    }
  }
  function curve(matrix, { center, radius, start = 0, sweep = tau }) {
    if (segmentOnly) return;
    const [a, b, c, d] = matrix;
    const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
    const origin = transformed(matrix, center);
    const full = Math.abs(sweep) >= tau - 1e-9;
    const at = angle => transformed(matrix, [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
    if (!radiusOnly) {
      consider(origin, true);
      if (!full) {
        consider(at(start), true);
        consider(at(start + sweep), true);
        consider(at(start + sweep / 2), true);
      }
      for (const angle of [0, Math.PI / 2, Math.PI, 1.5 * Math.PI]) {
        if (full || turn((angle - start) * Math.sign(sweep)) <= Math.abs(sweep) + 1e-9) consider(at(angle), true);
      }
    }
    // A non-uniform block transform turns the source circle into an ellipse.
    if (!sx || Math.abs(sx - sy) > sx * 1e-8 || Math.abs(a * c + b * d) > sx * sy * 1e-8) return;
    const [dx, dy] = sub(position, origin);
    const angle = Math.atan2(dx * c + dy * d, dx * a + dy * b);
    const circle = { center: origin, radius: radius * sx };
    if (full || turn((angle - start) * Math.sign(sweep)) <= Math.abs(sweep) + 1e-9) consider(at(angle), false, circle);
    else if (radiusOnly) {
      consider(at(start), false, circle);
      consider(at(start + sweep), false, circle);
    }
  }
  for (const { item, element } of items) {
    if (element?.classList.contains('layer-off')) continue;
    const { matrix, kind, arc, polyline } = item;
    if (kind === 'line') line(matrix, item.start, item.end);
    else if (kind === 'circle' || arc) curve(matrix, arc ?? item);
    else if (kind === 'point' && mode === 'point') consider(transformed(matrix, item.center), true);
    else if (polyline || kind === 'outline') {
      const vertices = polyline?.vertices ?? item.vertices.map(point => [point, 0]);
      const closed = polyline?.closed ?? true;
      for (let i = 0; i < vertices.length - Number(!closed); i++) {
        const [start, bulge] = vertices[i];
        const [end] = vertices[(i + 1) % vertices.length];
        const arc = arcFromBulge(start, end, bulge);
        if (arc) curve(matrix, arc);
        else line(matrix, start, end);
      }
    }
  }
  return anchor && anchorDistance <= edgeDistance + tolerance * 0.45 ? anchor : edge;
}

export function projectMeshPoint(camera, { point, partOffset }) {
  const p = point.map((value, i) => value + partOffset[i] * camera.spread);
  const x = dot(p, camera.right) * camera.scale[0] + camera.offset[0];
  const y = dot(p, camera.up) * camera.scale[1] + camera.offset[1];
  return [(1 + x) * camera.width / 2, (1 - y) * camera.height / 2];
}

export function pickMeshPoint(mesh, ranges, camera, [x, y], snapRadius = 0) {
  const { positions, appearance, basis, translation } = mesh;
  const { right, up, eye, scale, offset, width, height, spread, depthScale } = camera;
  const sx = (2 * x / width - 1 - offset[0]) / scale[0];
  const sy = (1 - 2 * y / height - offset[1]) / scale[1];
  const words = appearance && new Int16Array(appearance.bytes.buffer);
  const wordsPerTriangle = appearance && 3 * appearance.stride / 2;
  const localAxis = axis => basis ? [dot(basis.slice(0, 3), axis), dot(basis.slice(3, 6), axis), dot(basis.slice(6, 9), axis)] : axis;
  const [rx, uy, ez] = [right, up, eye].map(localAxis);
  const component = (i, axis) => positions[i] * axis[0] + positions[i + 1] * axis[1] + positions[i + 2] * axis[2];
  const world = point => basis ? translation.map((value, i) =>
    value + point[0] * basis[i] + point[1] * basis[i + 3] + point[2] * basis[i + 6]) : point;
  let depth = -Infinity, hit;
  for (const [start, count] of ranges) for (let i = start * 9, end = (start + count) * 9; i < end; i += 9) {
    const word = i / 9 * wordsPerTriangle;
    const dx = (mesh.partOffset?.[0] ?? words[word] / 32767) * spread + (translation?.[0] ?? 0);
    const dy = (mesh.partOffset?.[1] ?? words[word + 1] / 32767) * spread + (translation?.[1] ?? 0);
    const dz = (mesh.partOffset?.[2] ?? words[word + 2] / 32767) * spread + (translation?.[2] ?? 0);
    const u = sx - dx * right[0] - dy * right[1] - dz * right[2];
    const v = sy - dx * up[0] - dy * up[1] - dz * up[2];
    const ax = component(i, rx), bx = component(i + 3, rx), cx = component(i + 6, rx);
    if (u < Math.min(ax, bx, cx) || u > Math.max(ax, bx, cx)) continue;
    const ay = component(i, uy), by = component(i + 3, uy), cy = component(i + 6, uy);
    if (v < Math.min(ay, by, cy) || v > Math.max(ay, by, cy)) continue;
    const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(det) < 1e-18) continue;
    const b = ((u - ax) * (cy - ay) - (v - ay) * (cx - ax)) / det;
    const c = ((bx - ax) * (v - ay) - (by - ay) * (u - ax)) / det;
    const a = 1 - b - c;
    if (Math.min(a, b, c) < -1e-8) continue;
    const z = a * component(i, ez) + b * component(i + 3, ez) + c * component(i + 6, ez) +
      dx * eye[0] + dy * eye[1] + dz * eye[2];
    if (z <= depth || Math.abs(z * depthScale) > 1) continue;
    depth = z;
    hit = { index: i, partOffset: mesh.partOffset ?? [words[word], words[word + 1], words[word + 2]].map(value => value / 32767),
      weights: [a, b, c] };
  }
  if (!hit) return null;
  const { index, partOffset, weights: [a, b, c] } = hit;
  let point = world([0, 1, 2].map(i => a * positions[index + i] + b * positions[index + 3 + i] + c * positions[index + 6 + i]));
  let best = snapRadius;
  for (const offset of [0, 3, 6]) {
    const vertex = world(Array.from(positions.subarray(index + offset, index + offset + 3)));
    const distance = norm(sub(projectMeshPoint(camera, { point: vertex, partOffset }), [x, y]));
    if (distance < best) { best = distance; point = vertex; }
  }
  const [p, q, r] = [0, 3, 6].map(offset => world(Array.from(positions.subarray(index + offset, index + offset + 3))));
  const axis = cross3(sub(q, p), sub(r, p));
  const length = norm(axis);
  return { point, partOffset, normal: length ? Array.from(axis, value => value / length) : null };
}
