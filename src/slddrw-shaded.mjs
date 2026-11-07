import { Buffer } from 'node:buffer';
import { textAt, unicodeMarker } from './slddrw-preview.mjs';

const assemblyClass = Buffer.from('uoTempAssemblySHDData_c');
const subAssemblyClass = Buffer.from('uoTempSubAssemblySHDData_c');
const bodyClass = Buffer.from('uoTempBodyTessData_c');
const faceClass = Buffer.from('uoTempFaceTessData_c');
const tripleArray = Buffer.from('0c0000006400000002000000', 'hex');
const integerArray = Buffer.from('040000000800000002000000', 'hex');
const materialTail = Buffer.from('00000000c0c0c000fffeff', 'hex');
const visualClass = Buffer.from('moVisualProperties_c');
const defaultColor = 0xc0c0c0;
const emptyInstance = Buffer.from('00000000ffffffff000000000000000000000000ffffffff00000000', 'hex');
const appearanceReference = Buffer.from('5280', 'hex');

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const mm = value => Number((1000 * value).toFixed(7));
const triplet = (bytes, start) => [0, 4, 8].map(delta => bytes.readFloatLE(start + delta));
const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function assemblyFaces(bytes, start, faces, indexed = false) {
  const instances = [];
  for (let at = bytes.indexOf(unicodeMarker, start); at >= 0; at = bytes.indexOf(unicodeMarker, at + 3)) {
    const label = textAt(bytes, at);
    if (!label?.value.includes('@') || /[\u0000-\u001f]/.test(label.value)) continue;
    const offset = label.end + 1;
    const full = bytes[label.end];
    if ((full !== 0 && full !== 1) || offset + 211 > bytes.length) continue;
    const matrixBytes = full ? 72 : 0;
    if (bytes.readDoubleLE(offset + matrixBytes + 24) !== 1) continue;
    const basis = full ? [0, 8, 16].map(axis => [0, 24, 48].map(delta => bytes.readDoubleLE(offset + axis + delta))) : identity;
    if (!basis.every((axis, i) => basis.every((other, j) => Math.abs(dot(axis, other) - (i === j ? 1 : 0)) < 1e-7))) continue;
    const shift = [0, 8, 16].map(delta => bytes.readDoubleLE(offset + matrixBytes + delta));
    if (!shift.every(value => Math.abs(value) <= (indexed ? 1000 : 10))) continue;
    const configStart = offset + matrixBytes + 115;
    let config = textAt(bytes, configStart);
    let color;
    if (!config && indexed && bytes.readUInt16LE(configStart - 2) === appearanceReference.readUInt16LE()) {
      const end = Math.min(bytes.length, configStart + 900);
      for (let i = bytes.indexOf(unicodeMarker, configStart); i >= 0 && i < end; i = bytes.indexOf(unicodeMarker, i + 3)) {
        const candidate = textAt(bytes, i);
        const name = candidate && textAt(bytes, candidate.end + 12);
        const path = name && textAt(bytes, name.end);
        if (!path || !/\.sldprt$/i.test(path.value)) continue;
        config = candidate;
        color = faceColor(bytes, configStart - 2, i, appearanceReference);
        break;
      }
    }
    const name = config && textAt(bytes, config.end + 12);
    const path = name && textAt(bytes, name.end);
    if (!path || !/\.sldprt$/i.test(path.value)) continue;
    if (instances.length >= 256) return null;
    instances.push({ at, offset, basis, shift, color, pathEnd: path.end,
      key: JSON.stringify([path.value.toLowerCase(), config.value]), faces: [] });
    at = path.end - 3;
  }
  if (!instances.length || faces[0].start < instances[0].offset) return null;

  let index = 0;
  for (const face of faces) {
    while (instances[index + 1]?.offset < face.start) index++;
    instances[index].faces.push(face);
  }
  const templates = new Map();
  const ambiguous = new Set();
  for (const { key, faces: local } of instances) if (local.length) {
    if (templates.has(key)) ambiguous.add(key);
    templates.set(key, local);
  }
  const result = [];
  let total = 0;
  for (const [i, { key, basis, shift, color, pathEnd, faces: local }] of instances.entries()) {
    const end = instances[i + 1] ? instances[i + 1].at - 2 : bytes.length;
    if (indexed && !local.length && end - pathEnd === 304 && bytes.subarray(end - 28, end).equals(emptyInstance)) continue;
    const shape = local.length ? local : !ambiguous.has(key) && templates.get(key);
    if (!shape) return null;
    for (const face of shape) {
      if ((total += face.points.length) > 96_000) return null;
      const points = face.points.map(point => basis.map((axis, i) => dot(axis, point) + shift[i]));
      const normals = face.normals.map(normal => basis.map(axis => dot(axis, normal)));
      result.push({ ...face, points, normals, color: color ?? face.color });
    }
  }
  return result;
}

function stripsBefore(bytes, offset, count) {
  for (let n = 1; n <= Math.min(512, count / 3); n++) {
    const start = offset - 16 - 4 * n;
    if (start < 0) break;
    if (!bytes.subarray(start, start + 12).equals(integerArray) || bytes.readUInt32LE(start + 12) !== n) continue;
    const strips = Array.from({ length: n }, (_, i) => bytes.readUInt32LE(start + 16 + 4 * i));
    if (strips.every(length => length >= 3) && strips.reduce((sum, length) => sum + length, 0) === count) return { start, strips };
  }
  return null;
}

function faceColor(bytes, start, end, materialRecord, fallback) {
  const record = bytes.subarray(start, end);
  let color;
  for (let offset = record.indexOf(materialRecord); offset >= 0 && offset + 17 <= record.length;
    offset = record.indexOf(materialRecord, offset + 2)) {
    if (record[offset + 5] || !record.subarray(offset + 6, offset + 17).equals(materialTail)) continue;
    const value = (record[offset + 2] << 16) | (record[offset + 3] << 8) | record[offset + 4];
    if (color !== undefined && color !== value) return null;
    color = value;
  }
  return color ?? fallback;
}

function cachedFaces(bytes, body, first, indexed, faceReference) {
  const visual = bytes.lastIndexOf(visualClass, body);
  const defaultBody = visual < 0 ? defaultColor : bytes.readUIntBE(visual + visualClass.length, 3);
  const faces = [];
  let prefix;
  let total = 0;
  for (let offset = bytes.indexOf(tripleArray, first); offset >= 0 && offset + 16 <= bytes.length;
    offset = bytes.indexOf(tripleArray, offset + 12)) {
    const count = bytes.readUInt32LE(offset + 12);
    const normalOffset = offset + 16 + count * 12;
    const end = normalOffset + 16 + count * 12;
    if (count < 3 || count > 16_384 || end > bytes.length ||
        !bytes.subarray(normalOffset, normalOffset + 12).equals(tripleArray) ||
        bytes.readUInt32LE(normalOffset + 12) !== count) continue;
    const layout = stripsBefore(bytes, offset, count);
    if (!layout) continue;
    const { start, strips } = layout;
    if (prefix === undefined) {
      const layoutSize = start - first;
      if (layoutSize !== 8 && layoutSize !== 40) continue;
      prefix = layoutSize;
    } else {
      const ref = bytes.readUInt16LE(start - prefix - 2);
      if (ref < 0x8005 || ref >= 0x8100 || faceReference !== undefined && ref !== faceReference) continue;
      faceReference ??= ref;
    }
    if ((total += count) > 48_000 || faces.length >= 2048) return null;
    const points = [], normals = [];
    for (let i = 0; i < count; i++) {
      const point = triplet(bytes, offset + 16 + i * 12);
      const normal = triplet(bytes, normalOffset + 16 + i * 12);
      if (!point.every(value => Math.abs(value) <= (indexed ? 1000 : 10)) || Math.abs(dot(normal, normal) - 1) > 1e-4 ||
          !normal.every(Number.isFinite)) return null;
      points.push(point);
      normals.push(normal);
    }
    faces.push({ start, end, points, normals, strips });
    offset = end - 12;
  }
  if (!faces.length) return null;

  // Each body declares a face count. Later bodies reuse the serialized class IDs.
  let remaining = body < 0 ? 0 : bytes.readUInt16LE(body + bodyClass.length);
  const materialRecord = indexed ? appearanceReference : Buffer.alloc(2);
  if (!indexed) materialRecord.writeUInt16LE((faceReference ?? 0x800f) - 4);
  const bodyColor = indexed && body < 0 ? faceColor(bytes, 0, first, materialRecord, defaultColor) : defaultBody;
  for (const [i, face] of faces.entries()) {
    if (!remaining) {
      if (face.start < prefix + 6 || bytes.readUInt16LE(face.start - prefix - 6) !== faceReference - 2) return null;
      remaining = bytes.readUInt16LE(face.start - prefix - 4);
      if (!remaining) return null;
    }
    remaining--;
    const nextFace = faces[i + 1]?.start ?? bytes.length;
    const next = indexed && !remaining ? Math.min(nextFace, face.end + 400) : nextFace;
    face.color = faceColor(bytes, face.end, next, materialRecord, prefix === 40 ? bodyColor : defaultColor);
    if (face.color === null) return null;
  }
  if (remaining) return null;
  return { faces, faceReference };
}

export function readShadedFaces(bytes, indexed = false) {
  if (!bytes) return null;
  const body = bytes.indexOf(bodyClass);
  const firstFace = body < 0 ? -1 : bytes.indexOf(faceClass, body + bodyClass.length);
  if (firstFace < 0 || firstFace - body !== bodyClass.length + 8) return null;
  const cached = cachedFaces(bytes, body, firstFace + faceClass.length, indexed);
  if (!cached) return null;
  const assembly = bytes.lastIndexOf(assemblyClass, body);
  return assembly < 0 ? cached.faces : assemblyFaces(bytes, assembly + assemblyClass.length, cached.faces, indexed);
}

export function indexedShading(bytes, views) {
  const result = new Map();
  const first = views[0];
  if (!first?.shaded || first.group.mode !== 0) return result;
  const start = bytes.indexOf(subAssemblyClass, views.at(-1).group.end);
  const body = start < 0 ? -1 : bytes.indexOf(bodyClass, start);
  const firstFace = body < 0 ? -1 : bytes.indexOf(faceClass, body + bodyClass.length);
  if (firstFace < 0 || firstFace - body !== bodyClass.length + 8) return result;

  const partMarker = Buffer.from('0000fffeff', 'hex');
  const partHeader = Buffer.from('00000100000005004b80', 'hex');
  const parts = [];
  for (let at = bytes.indexOf(partMarker, firstFace); at >= 0; at = bytes.indexOf(partMarker, at + partMarker.length)) {
    const path = textAt(bytes, at + 2);
    if (bytes[at - 2] !== 1 || bytes[at - 1] > 1 || !path || !/\.sldprt$/i.test(path.value) ||
        !bytes.subarray(path.end, path.end + partHeader.length).equals(partHeader)) continue;
    parts.push({ at: at - 2, end: path.end, name: path.value.split(/[\\/]/).at(-1).slice(0, -7).toLowerCase() });
    if (parts.length > views.length) return result;
  }
  const shadedParts = views.slice(1).filter(view => view.shaded);
  if (parts.length !== shadedParts.length || !parts.length) return result;
  const assembly = bytes.lastIndexOf(assemblyClass, body);
  const assemblyEnd = parts[0].at;
  if (assembly < start || assemblyEnd <= firstFace) return result;
  const cached = cachedFaces(bytes.subarray(0, assemblyEnd), body, firstFace + faceClass.length, true);
  if (!cached?.faceReference) return result;
  const assemblyGeometry = assemblyFaces(bytes.subarray(0, assemblyEnd), assembly + assemblyClass.length, cached.faces, true);
  if (assemblyGeometry) result.set(first, assemblyGeometry);

  const firstPartFace = Buffer.alloc(6);
  firstPartFace.writeUInt16LE(1, 2);
  firstPartFace.writeUInt16LE(cached.faceReference - 2, 4);
  for (const [index, view] of shadedParts.entries()) {
    const part = parts[index];
    const nextGroup = views[views.indexOf(view) + 1]?.group.offset ?? start;
    let component;
    for (let at = bytes.indexOf(unicodeMarker, view.group.end); at >= 0 && at < nextGroup; at = bytes.indexOf(unicodeMarker, at + 3)) {
      const label = textAt(bytes, at);
      const suffix = '@' + view.name;
      if (label?.value.endsWith(suffix)) {
        component = label.value.slice(0, -suffix.length).replace(/-\d+$/, '').toLowerCase();
        break;
      }
    }
    if (component !== part.name) continue;
    const section = bytes.subarray(part.end, parts[index + 1]?.at ?? bytes.length);
    let face = section.indexOf(firstPartFace);
    while (face >= 0 && (face + 10 > section.length || section.readUInt16LE(face + 8) !== cached.faceReference)) {
      face = section.indexOf(firstPartFace, face + 1);
    }
    if (face < 0) continue;
    const geometry = cachedFaces(section, -1, face + 10, true, cached.faceReference);
    if (geometry) result.set(view, geometry.faces);
  }
  return result;
}

function edgeKey(a, b) {
  const key = point => point.map(value => Math.round(value * 1e7)).join(',');
  const ka = key(a), kb = key(b);
  return ka < kb ? ka + ':' + kb : kb + ':' + ka;
}

export function shadedView(faces, view, layer, drawOutlines = true) {
  if (!faces || !view.bounds) return [];
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  const projected = [];
  for (const face of faces) {
    const points = face.points.map(point =>
      view.basis.map((axis, i) => dot(axis, point) * view.scale + view.move[i] + view.shift[i]));
    for (const point of face.points) for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i], point[i]);
      high[i] = Math.max(high[i], point[i]);
    }
    const depths = face.normals.map(normal => dot(view.basis[2], normal));
    const light = view.group && face.normals.map((normal, i) => 0.64 + 0.36 * Math.max(0,
      -0.3 * dot(view.basis[0], normal) + 0.72 * dot(view.basis[1], normal) + 0.625 * depths[i]));
    const triangles = [];
    const boundary = new Map();
    let start = 0;
    for (const length of face.strips) {
      for (let i = start; i + 2 < start + length; i++) {
        if (depths[i] + depths[i + 1] + depths[i + 2] <= 1e-6) continue;
        const [a, b, c] = points.slice(i, i + 3);
        if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) <= 1e-12) continue;
        const edges = drawOutlines ? [[a, b], [b, c], [c, a]].map(pair => ({ pair, key: edgeKey(...pair) })) : [];
        for (const { key } of edges) boundary.set(key, (boundary.get(key) ?? 0) + 1);
        const brightness = light ? (light[i] + light[i + 1] + light[i + 2]) / 3 : 1;
        const color = [16, 8, 0].reduce((rgb, bit) => rgb | (Math.round((face.color >> bit & 255) * brightness) << bit), 0);
        triangles.push({ depth: (a[2] + b[2] + c[2]) / 3, points: [a, b, c], edges, color });
      }
      start += length;
    }
    for (const triangle of triangles) projected.push({ ...triangle,
      outline: triangle.edges.filter(({ key }) => boundary.get(key) === 1) });
  }
  // The saved view rectangle bounds the projected corners of the model's bounding box.
  const bounds = [0, 1, 2, 3].map(index => {
    const axis = index % 2;
    const corner = view.basis[axis].map((value, i) => (value < 0) === (index >= 2) ? low[i] : high[i]);
    return dot(view.basis[axis], corner) * view.scale + view.move[axis] + view.shift[axis];
  });
  const tolerance = Math.max(2e-6, 1e-4 * Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]));
  if (!bounds.every((value, i) => Math.abs(value - view.bounds[i]) <= tolerance)) return [];
  const xy = point => point.slice(0, 2).map(mm);
  const entities = [];
  for (const triangle of projected.sort((a, b) => a.depth - b.depth)) {
    entities.push({ type: 'SOLID', vertices: triangle.points.map(xy), color: triangle.color, layer: layer + '-FACES' });
    for (const { pair } of triangle.outline) {
      entities.push({ type: 'LINE', a: xy(pair[0]), b: xy(pair[1]), color: 0x202020, layer: layer + '-EDGES' });
    }
  }
  return entities;
}
