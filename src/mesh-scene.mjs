import { meshLimits } from './cad-budget.mjs';

export const decimalPattern = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[Ee][+-]?[0-9]+)?';

export class MeshPartSelectionError extends Error {}

export function meshLabel(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 160) : '';
}

export function hasArea([ax, ay, az, bx, by, bz, cx, cy, cz]) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  return uy * vz !== uz * vy || uz * vx !== ux * vz || ux * vy !== uy * vx;
}

export function buildMeshScene(format, unit, triangles, issues = [], partPath) {
  let vertices = new Float64Array(9 * 1024);
  let total = 0, count = 0;
  const tree = [], stack = [], colors = new Map();
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) {
    // Section markers bracket contiguous triangle ranges without repeating an ID for every face.
    if (!Array.isArray(triangle)) {
      if (triangle === null) {
        const { node, siblings, keepEmpty } = stack.pop();
        node.count = count - node.start;
        const parent = stack.at(-1)?.node;
        if (node.projectionAvailable === false && parent) parent.projectionAvailable = false;
        if (node.count) {
          siblings.push(node);
          if (parent) for (let i = 0; i < 3; i++) {
            parent.low[i] = Math.min(parent.low[i], node.low[i]);
            parent.high[i] = Math.max(parent.high[i], node.high[i]);
          }
        } else if (keepEmpty) siblings.push(node);
      } else {
        const siblings = stack.at(-1)?.node.children ?? tree;
        const { label, key } = triangle;
        const node = { label: meshLabel(label) || '网格', start: count,
          low: [Infinity, Infinity, Infinity], high: [-Infinity, -Infinity, -Infinity] };
        if (triangle.projectionAvailable === false) node.projectionAvailable = false;
        if (key === undefined) node.children = [];
        else {
          if (!colors.has(key)) colors.set(key, colors.size);
          node.color = colors.get(key);
        }
        stack.push({ node, siblings, keepEmpty: triangle.keepEmpty });
      }
      continue;
    }
    if (++total > meshLimits.triangles) throw new Error('模型展开后超过 50 万个三角面。');
    if (!triangle.every(value => Math.abs(value) <= 1e100)) throw new Error('模型包含无效或超出范围的坐标。');
    if (!hasArea(triangle)) continue;
    if (count * 9 === vertices.length) {
      const next = new Float64Array(Math.min(vertices.length * 2, meshLimits.triangles * 9));
      next.set(vertices);
      vertices = next;
    }
    vertices.set(triangle, count++ * 9);
    const part = stack.at(-1)?.node;
    for (let i = 0; i < 9; i++) {
      const axis = i % 3;
      min[axis] = Math.min(min[axis], triangle[i]);
      max[axis] = Math.max(max[axis], triangle[i]);
      if (part) {
        part.low[axis] = Math.min(part.low[axis], triangle[i]);
        part.high[axis] = Math.max(part.high[axis], triangle[i]);
      }
    }
  }
  if (!count) throw new Error('模型没有可预览的三角面。');
  if (total !== count) issues.push(['已跳过面积为零的三角面。', total - count]);
  let part, siblings = tree;
  for (const index of partPath ?? []) {
    part = siblings?.[index];
    if (!part) throw new MeshPartSelectionError('模型中找不到所选零件或装配节点。');
    siblings = part.children;
  }
  if (part?.count === 0) throw new MeshPartSelectionError('所选节点没有可生成三视图的几何。');
  const low = part?.low ?? min, high = part?.high ?? max;
  const size = high.map((value, i) => value - low[i]);
  const center = low.map((value, i) => value + size[i] / 2);
  const span = Math.max(...size);
  function normalize(nodes) {
    for (const node of nodes) {
      const { low, high } = node;
      if (node.count) {
        const extents = high.map((value, i) => value - low[i]);
        node.center = low.map((value, i) => (value + extents[i] / 2 - center[i]) / span);
        node.span = Math.max(...extents) / span;
      }
      delete node.low;
      delete node.high;
      if (node.children) normalize(node.children);
    }
  }
  if (!part) normalize(tree);
  const start = (part?.start ?? 0) * 9;
  count = part?.count ?? count;
  const packed = Buffer.allocUnsafe(count * 36);
  for (let i = 0; i < count * 9; i++) packed.writeFloatLE((vertices[start + i] - center[i % 3]) / span, i * 4);
  return { format, mesh: { count, size, unit, origin: center, positions: packed.toString('base64'), ...(!part && tree.length && { tree }) },
    issues, ...(part && { partLabel: part.label }),
    ...((part ? part.projectionAvailable === false : tree.some(node => node.projectionAvailable === false)) &&
      { projectionAvailable: false }) };
}
