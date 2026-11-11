// Bound the topology pass independently of the preview's triangle limits.
export const volumeTriangleBudget = 300_000;
const unavailable = { reason: 'open' };

export function meshVolume(vertices, start, count) {
  if (count > volumeTriangleBudget) return { reason: 'limit' };
  const points = new Map(), edges = new Map();
  const parents = new Int32Array(count).fill(-1);
  const end = start + count * 9;
  let span = 0;
  for (let i = start; i < end; i++) span = Math.max(span, Math.abs(vertices[i] - vertices[start + i % 3]));
  const grid = span * 1e-10;
  if (!(grid > 0)) return unavailable;

  function pointId(i) {
    const key = [0, 1, 2].map(axis => Math.round((vertices[i + axis] - vertices[start + axis]) / grid)).join(',');
    if (!points.has(key)) points.set(key, points.size);
    return points.get(key);
  }
  function root(i) {
    while (parents[i] >= 0) {
      if (parents[parents[i]] >= 0) parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  }
  function pair(a, b, face) {
    if (a === b) return false;
    const key = Math.min(a, b) * count * 3 + Math.max(a, b);
    const previous = edges.get(key);
    const sign = a < b ? 1 : -1;
    if (previous === undefined) edges.set(key, sign * (face + 1));
    else {
      if (previous * sign >= 0) return false;
      edges.set(key, 0);
      let x = root(face), y = root(Math.abs(previous) - 1);
      if (x !== y) {
        if (parents[x] > parents[y]) [x, y] = [y, x];
        parents[x] += parents[y];
        parents[y] = x;
      }
    }
    return true;
  }
  for (let i = start, face = 0; i < end; i += 9, face++) {
    const a = pointId(i), b = pointId(i + 3), c = pointId(i + 6);
    if (!pair(a, b, face) || !pair(b, c, face) || !pair(c, a, face)) return unavailable;
  }
  for (const value of edges.values()) if (value) return unavailable;

  // Sum signed tetrahedra relative to a nearby point on each closed shell.
  const shells = new Map();
  for (let i = start, face = 0; i < end; i += 9, face++) {
    const id = root(face);
    if (!shells.has(id)) shells.set(id, { origin: i, sum: 0, errorScale: 0 });
    const shell = shells.get(id);
    const { origin } = shell;
    const ax = vertices[i] - vertices[origin], ay = vertices[i + 1] - vertices[origin + 1], az = vertices[i + 2] - vertices[origin + 2];
    const bx = vertices[i + 3] - vertices[origin], by = vertices[i + 4] - vertices[origin + 1], bz = vertices[i + 5] - vertices[origin + 2];
    const cx = vertices[i + 6] - vertices[origin], cy = vertices[i + 7] - vertices[origin + 1], cz = vertices[i + 8] - vertices[origin + 2];
    const terms = [ax * by * cz, ay * bz * cx, az * bx * cy, -ax * bz * cy, -ay * bx * cz, -az * by * cx];
    for (const term of terms) {
      shell.sum += term;
      shell.errorScale += Math.abs(term);
    }
  }
  let sign, value = 0;
  for (const { sum, errorScale } of shells.values()) {
    if (!Number.isFinite(sum) || Math.abs(sum) <= errorScale * 1e-10) return unavailable;
    // An opposite shell might be a cavity or a separate reversed solid.
    if (sign !== undefined && Math.sign(sum) !== sign) return { reason: 'orientation' };
    sign = Math.sign(sum);
    value += Math.abs(sum) / 6;
  }
  return Number.isFinite(value) && value > 0 ? { method: 'mesh', value } : unavailable;
}

export function totalMeshVolume(volumes) {
  const missing = volumes.find(volume => !volume.value);
  if (missing) return missing;
  const value = volumes.reduce((sum, volume) => sum + volume.value, 0);
  return value > 0 && Number.isFinite(value) ? { method: 'mesh', value } : unavailable;
}
