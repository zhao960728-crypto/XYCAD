import { Buffer } from 'node:buffer';
import { projectionTriangleLimit } from '../public/cad-limits.mjs';

const weldTolerance = 1e-7;
const depthTolerance = 2e-7;
const crease = Math.cos(25 * Math.PI / 180);
const millimeters = new Map([['µm', 0.001], ['mm', 1], ['cm', 10], ['m', 1000], ['in', 25.4], ['ft', 304.8]]);
// Signed, one-based XYZ axes. Each frame is right, up, toward the viewer.
const frontFrames = { ny: [1, 3, -2], py: [-1, 3, 2], px: [2, 3, 1],
  nx: [-2, 3, -1], pz: [1, 2, 3], nz: [1, -2, -3] };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pointKey = point => point.map(value => Math.round(value / weldTolerance)).join(',');
const pairKey = (a, b) => a < b ? a + ':' + b : b + ':' + a;

function meshEdges(mesh) {
  const bytes = Buffer.from(mesh.positions, 'base64');
  const vertexIds = new Map(), vertices = [], triangles = [], edges = new Map();
  for (let offset = 0; offset < bytes.length; offset += 36) {
    const ids = [0, 12, 24].map(delta => {
      const point = [0, 4, 8].map(axis => bytes.readFloatLE(offset + delta + axis));
      const key = pointKey(point);
      if (!vertexIds.has(key)) {
        vertexIds.set(key, vertices.length);
        vertices.push(point);
      }
      return vertexIds.get(key);
    });
    const [a, b, c] = ids.map(id => vertices[id]);
    const [ux, uy, uz] = b.map((value, i) => value - a[i]);
    const [vx, vy, vz] = c.map((value, i) => value - a[i]);
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(...n);
    if (!length) continue;
    const normal = n.map(value => value / length);
    triangles.push(ids);
    for (let i = 0; i < 3; i++) {
      const from = ids[i], to = ids[(i + 1) % 3];
      const key = pairKey(from, to);
      const edge = edges.get(key);
      if (!edge) edges.set(key, { from, to, normal });
      else if (edge.other) edge.feature = true;
      else {
        // Orient the adjacent normals consistently even on meshes with mixed winding.
        edge.other = from === edge.from ? normal.map(value => -value) : normal;
        edge.feature = dot(edge.normal, edge.other) < crease;
      }
    }
  }
  return { vertices, triangles, edges: [...edges.values()] };
}

function triangleInView([a, b, c]) {
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - a[0], vy = c[1] - a[1];
  const area = ux * vy - uy * vx;
  if (Math.abs(area) <= 1e-15) return null;
  return { a, u: [vy / area, -vx / area], v: [-uy / area, ux / area], du: b[2] - a[2], dv: c[2] - a[2],
    lowX: Math.min(a[0], b[0], c[0]), highX: Math.max(a[0], b[0], c[0]),
    lowY: Math.min(a[1], b[1], c[1]), highY: Math.max(a[1], b[1], c[1]), highZ: Math.max(a[2], b[2], c[2]) };
}

function indexTriangles(triangles) {
  if (!triangles.length) return null;
  const node = { lowX: Infinity, lowY: Infinity, highX: -Infinity, highY: -Infinity, highZ: -Infinity };
  for (const tri of triangles) {
    node.lowX = Math.min(node.lowX, tri.lowX);
    node.lowY = Math.min(node.lowY, tri.lowY);
    node.highX = Math.max(node.highX, tri.highX);
    node.highY = Math.max(node.highY, tri.highY);
    node.highZ = Math.max(node.highZ, tri.highZ);
  }
  if (triangles.length <= 16) {
    node.triangles = triangles;
  } else {
    const center = node.highX - node.lowX >= node.highY - node.lowY ? tri => tri.lowX + tri.highX : tri => tri.lowY + tri.highY;
    triangles.sort((a, b) => center(a) - center(b));
    const middle = triangles.length >>> 1;
    node.children = [indexTriangles(triangles.slice(0, middle)), indexTriangles(triangles.slice(middle))];
  }
  return node;
}

function clip(interval, a, b) {
  if (a < 0 && b < 0) return false;
  if (a < 0) interval[0] = Math.max(interval[0], a / (a - b));
  if (b < 0) interval[1] = Math.min(interval[1], a / (a - b));
  return interval[0] < interval[1];
}

function hiddenIntervals(index, start, end, work) {
  const found = [];
  const lowZ = Math.min(start[2], end[2]) + depthTolerance;
  const lowX = Math.min(start[0], end[0]), highX = Math.max(start[0], end[0]);
  const lowY = Math.min(start[1], end[1]), highY = Math.max(start[1], end[1]);
  const stack = index ? [index] : [];
  function overlaps(box) {
    if (box.highZ <= lowZ || highX < box.lowX || lowX > box.highX || highY < box.lowY || lowY > box.highY) return false;
    const interval = [0, 1];
    return clip(interval, start[0] - box.lowX, end[0] - box.lowX) &&
      clip(interval, box.highX - start[0], box.highX - end[0]) &&
      clip(interval, start[1] - box.lowY, end[1] - box.lowY) &&
      clip(interval, box.highY - start[1], box.highY - end[1]);
  }
  while (stack.length) {
    if (++work.visits > 45_000_000) throw new Error('模型遮挡关系超过三视图计算预算，请拆分模型后重试。');
    const node = stack.pop();
    if (!overlaps(node)) continue;
    if (node.children) {
      stack.push(...node.children);
      continue;
    }
    for (const tri of node.triangles) {
      if (!overlaps(tri)) continue;
      const coords = ([x, y]) => [
        (x - tri.a[0]) * tri.u[0] + (y - tri.a[1]) * tri.u[1],
        (x - tri.a[0]) * tri.v[0] + (y - tri.a[1]) * tri.v[1],
      ];
      const [u0, v0] = coords(start), [u1, v1] = coords(end);
      const interval = [0, 1], tolerance = 1e-8;
      if (!clip(interval, u0 + tolerance, u1 + tolerance) || !clip(interval, v0 + tolerance, v1 + tolerance) ||
          !clip(interval, 1 - u0 - v0 + tolerance, 1 - u1 - v1 + tolerance)) continue;
      const depth = tri.a[2] - depthTolerance;
      if (!clip(interval, depth + u0 * tri.du + v0 * tri.dv - start[2], depth + u1 * tri.du + v1 * tri.dv - end[2])) continue;
      if (interval[0] === 0 && interval[1] === 1) return [interval];
      found.push(interval);
    }
  }
  return found.sort((a, b) => a[0] - b[0]);
}

function unionIntervals(intervals) {
  const result = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && interval[0] - last[1] <= weldTolerance) last[1] = Math.max(last[1], interval[1]);
    else result.push(interval);
  }
  return result;
}

function* coalesceLines(lines) {
  const groups = new Map();
  for (const { a, b, hidden } of lines) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const sign = (Math.abs(dx) >= Math.abs(dy) ? dx : dy) < 0 ? -1 : 1;
    const x = sign * dx / length, y = sign * dy / length;
    const offset = a[1] * x - a[0] * y;
    const key = pointKey([x, y, offset]);
    let group = groups.get(key);
    if (!group) {
      group = { x, y, offset, visible: [], hidden: [] };
      groups.set(key, group);
    }
    const distance = point => point[0] * group.x + point[1] * group.y;
    const start = distance(a), end = distance(b);
    group[hidden ? 'hidden' : 'visible'].push([Math.min(start, end), Math.max(start, end)]);
  }
  for (const { x, y, offset, visible, hidden } of groups.values()) {
    const point = length => [length * x - offset * y, length * y + offset * x];
    const solid = unionIntervals(visible);
    for (const [start, end] of solid) yield { a: point(start), b: point(end), hidden: false };
    let cursor = 0;
    for (const [start, end] of unionIntervals(hidden)) {
      let from = start;
      while (cursor < solid.length && solid[cursor][1] <= from + weldTolerance) cursor++;
      for (let i = cursor; i < solid.length && solid[i][0] < end; i++) {
        const [low, high] = solid[i];
        if (low - from > weldTolerance) yield { a: point(from), b: point(low), hidden: true };
        from = Math.max(from, high);
      }
      if (end - from > weldTolerance) yield { a: point(from), b: point(end), hidden: true };
    }
  }
}

function viewLines(mesh, view, work) {
  const { axes, signs } = view;
  const points = mesh.vertices.map(point => axes.map((axis, i) => point[axis] * signs[i]));
  const triangles = mesh.triangles.map(triangle => triangleInView(triangle.map(id => points[id]))).filter(Boolean);
  const index = indexTriangles(triangles), lines = new Map();
  for (const edge of mesh.edges) {
    const silhouette = edge.other && (edge.normal[axes[2]] * signs[2] > 1e-8) !== (edge.other[axes[2]] * signs[2] > 1e-8);
    if (edge.other && !edge.feature && !silhouette) continue;
    const a = points[edge.from], b = points[edge.to];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const span = Math.hypot(dx, dy);
    if (span <= weldTolerance) continue;
    function append(start, end, hidden) {
      if ((end - start) * span <= weldTolerance) return;
      const from = [a[0] + start * dx, a[1] + start * dy];
      const to = [a[0] + end * dx, a[1] + end * dy];
      const key = pairKey(pointKey(from), pointKey(to));
      if (!lines.has(key) || !hidden) lines.set(key, { a: from, b: to, hidden });
      if (lines.size > 100_000) throw new Error('三视图线条超过单视图预算，请拆分模型后重试。');
    }
    let visibleFrom = 0, hiddenFrom = 0, hiddenTo = 0;
    for (const [start, end] of hiddenIntervals(index, a, b, work)) {
      if (start > hiddenTo) {
        append(hiddenFrom, hiddenTo, true);
        append(visibleFrom, start, false);
        hiddenFrom = start;
      }
      hiddenTo = Math.max(hiddenTo, end);
      visibleFrom = hiddenTo;
    }
    append(hiddenFrom, hiddenTo, true);
    append(visibleFrom, 1, false);
  }
  return coalesceLines(lines.values());
}

export function buildOrthographic(mesh, front = 'ny') {
  if (mesh.count > projectionTriangleLimit) throw new Error('三视图目前支持 20 万个三角面以内的模型，请拆分模型后重试。');
  const scale = Math.max(...mesh.size);
  const half = mesh.size.map(value => value / scale / 2);
  const [right, up, eye] = frontFrames[front];
  const viewAxes = [
    ['FRONT', '正视图', [right, up, eye]],
    ['TOP', '俯视图', [right, -eye, up]],
    ['RIGHT', '右视图', [-eye, up, right]],
  ].map(([layer, label, frame]) => ({
    layer, label, axes: frame.map(axis => Math.abs(axis) - 1), signs: frame.map(axis => Math.sign(axis)),
  }));
  const [x, z, y] = viewAxes[0].axes.map(axis => half[axis]);
  const unitScale = millimeters.get(mesh.unit);
  const span = scale * (unitScale ?? 1);
  const shifts = [[0, 0], [0, -z - y - 0.18], [-x - y - 0.18, 0]];
  const work = { visits: 0 };
  const entities = [];
  const model = meshEdges(mesh);
  for (const [i, view] of viewAxes.entries()) {
    const [sx, sy] = shifts[i];
    const point = ([u, v]) => [(u + sx) * span, (v + sy) * span];
    const lines = viewLines(model, view, work);
    for (const { a, b, hidden } of lines) {
      entities.push({ type: 'LINE', layer: view.layer + (hidden ? '-HIDDEN' : '-VISIBLE'), a: point(a), b: point(b) });
    }
    entities.push({ type: 'TEXT', layer: 'VIEW-LABELS', value: view.label, height: 0.025 * span, angle: 0, width: 1,
      a: point([-half[view.axes[0]], -half[view.axes[1]] - 0.06]) });
  }
  if (entities.length > 180_000) throw new Error('三视图线条超过导出预算，请拆分模型后重试。');
  if (!entities.some(entity => entity.type === 'LINE')) throw new Error('模型精度不足，无法生成三视图线条。');
  return { entities, units: unitScale ? 4 : 0, hiddenDash: span * 0.012 };
}
