import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';
import { polylinePath, richText, splinePath } from './dxf-scene.mjs';
import { exbLimits } from './cad-budget.mjs';

// Record IDs and layouts observed in the local CaxaDraft Document samples.
const type = {
  block: '81305fb60e5c004d97b40c5231051af1',
  layer: '5fe60a6d04a8f34c9d9207831c336a7a',
  linetype: '60fff1c882a8394693cb87921b4f5d0b',
  line: '2df7ec1746c09a4e8416fd8220fd33b5',
  circle: '3c738775f63d9d4c8b0820aeffe18291',
  arc: '6b55d691b80f134e998fbdacbfd31025',
  polyline: '32e7d8561fad6d42a4b06c5998434583',
  spline: 'be96888369c066458991afd750b4547c',
  solid: '4e6d67d7e0b9c346894de9ef7fb66fb2',
  text: '2162d77658435d46bc534449b3004657',
  insert: 'ba4e8bd31fa8284baa1971a60d884004',
  attribute: 'af5bd8602e4d004084f0e77d42fb999c',
  attributeDefinition: '6d2218e273dd9d4aaa95764b4d3bc072',
  linearDimension: 'b548a81d848c114c80d645cf9b26aa48',
  diameterDimension: '78cb91f30a24bd4f9e3f4f19572391fc',
  leader: '1ebda4ab22d94d4b931e7f4c9d6919e7',
  annotation: 'e68286cccfa84f4aaa36c600b07aa69c',
  annotation2: 'cffae48682ecc2458c00c6a37e4e1c77',
  annotation3: '3521e9640bbb374cbee3e7dcdabf179e',
  annotation4: 'd490945f97b7194190b193668e2db71a',
  annotation5: '46dd354bdb6d034bb23351c18f214cf1',
  ole: '9a34882c86c4a74eac2b063d16b763cc',
};
const labels = new Map(Object.entries(type).map(([label, id]) => [id, label]));
const annotationKinds = new Set(['linearDimension','diameterDimension','leader',
  'annotation','annotation2','annotation3','annotation4','annotation5']);
const properties = new Set([
  '8f3159c272111446b5548e8accc41d9e',
  'bf32eef220a1664193b77bca1f99f688',
  'a6f1f95e22a2cf4f9de54f3fb99c0ac2',
]);
const identity = [1, 0, 0, 1, 0, 0];
const defaultColor = '#e8edf5';
const chunkSize = 0x40000;
const { expandedBytes: maxExpanded, records: maxRecords, items: maxItems } = exbLimits;
const modelId = -5;
const recordStart = 172;
const coord = n => Number.isFinite(n) && Math.abs(n) <= 1e12;
const tau = 2 * Math.PI;

function requireValid(ok) {
  if (!ok) throw new Error('EXB 的模型数据布局暂不支持或已损坏。');
}

function unpack(stream, limit) {
  if (stream.length < 20 || stream.readUInt32LE(0) !== 0x3de3de00) {
    requireValid(stream.length <= limit);
    return stream;
  }
  const total = stream.readBigUInt64LE(8);
  requireValid(stream.readUInt32LE(4) === chunkSize && total > 0n && total <= BigInt(limit));
  const bytes = Buffer.allocUnsafe(Number(total));
  let offset = 16;
  for (let out = 0; out < bytes.length; out += chunkSize) {
    requireValid(offset + 4 <= stream.length);
    const size = stream.readUInt32LE(offset);
    offset += 4;
    requireValid(size > 0 && offset + size <= stream.length);
    const part = inflateSync(stream.subarray(offset, offset + size), { maxOutputLength: chunkSize });
    const written = Math.min(chunkSize, bytes.length - out);
    // Some writers compress a zero padded final page.
    requireValid(part.length === written || part.length === chunkSize);
    part.copy(bytes, out, 0, written);
    offset += size;
  }
  requireValid(offset === stream.length);
  return bytes;
}

function stringAt(bytes, offset, max = 32768) {
  const size = bytes.readUInt32LE(offset);
  requireValid(size >= 2 && size <= max && size % 2 === 0 && offset + 4 + size <= bytes.length);
  const end = offset + 4 + size;
  requireValid(bytes.readUInt16LE(end - 2) === 0);
  return [bytes.toString('utf16le', offset + 4, end - 2), end];
}

function objectAt(bytes, at) {
  requireValid(at + 30 <= bytes.length);
  const guid = bytes.toString('hex', at, at + 16);
  const id = bytes.readInt32LE(at + 16);
  const owner = bytes.readInt32LE(at + 20);
  const version = bytes[at + 24];
  const hasProps = bytes[at + 25];
  requireValid(version > 0 && version <= 100 && hasProps <= 1);
  let offset = at + 26;
  if (hasProps) {
    const bags = bytes.readUInt32LE(offset);
    requireValid(bags <= 16);
    offset += 4;
    for (let i = 0; i < bags; i++) {
      requireValid(properties.has(bytes.toString('hex', offset, offset + 16)));
      const count = bytes.readUInt32LE(offset + 16);
      requireValid(count <= 256);
      offset += 20;
      for (let j = 0; j < count; j++) {
        const propertyType = bytes[offset++];
        [, offset] = stringAt(bytes, offset, 2048);
        if (propertyType === 7) [, offset] = stringAt(bytes, offset, 65536);
        else {
          const size = [0, 1, 4, 8, 4, 4, 8, null, 2, 24, 4][propertyType];
          requireValid(size != null);
          offset += size;
        }
      }
    }
  }
  const size = bytes.readUInt32LE(offset);
  const start = offset + 4, end = start + size;
  requireValid(size > 0 && end <= bytes.length);
  return { guid, id, owner, start, end };
}

function modelObjects(bytes, onGap, expectedOwner) {
  requireValid(bytes.length >= recordStart && bytes.readUInt32LE(0) === 8 && bytes.toString('utf16le', 4, 12) === '0.0\0');
  const output = [];
  let gaps = 0;
  let active = expectedOwner;
  let offset = recordStart;
  for (; offset + 30 <= bytes.length;) {
    if (output.length >= maxRecords) throw new Error('EXB 模型记录数超过预览容量。');
    let rec;
    try { rec = objectAt(bytes, offset); } catch { /* Search for a verified record boundary below. */ }
    const bodyValid = !rec || !labels.has(rec.guid) || [type.block,type.layer,type.linetype].includes(rec.guid) ||
      (rec.end - rec.start >= 33 && bytes.readUInt32LE(rec.start) === 0x800000);
    if (!rec || !bodyValid) {
      if (active == null || gaps++ >= 256) break;
      const marker = Buffer.alloc(4);
      marker.writeInt32LE(active);
      // Recover only on a recognized class, known owner and a validated record header.
      let resume = -1;
      for (let match = offset + 9; (match = bytes.indexOf(marker, match)) >= 0; match++) {
        const at = match - 20;
        if (!labels.has(bytes.toString('hex', at, at + 16))) continue;
        try {
          const candidate = objectAt(bytes, at);
          if (at > offset - 20 && bytes.readUInt32LE(candidate.start) === 0x800000) { resume = at; break; }
        } catch { /* Not a complete record. */ }
      }
      if (resume < 0) break;
      onGap?.();
      offset = resume;
      continue;
    }
    if (rec.guid === type.block) active = rec.id;
    output.push({ ...rec, data: bytes.subarray(rec.start, rec.end) });
    offset = rec.end;
  }
  if (offset !== bytes.length) onGap?.();
  return output;
}

function rgb(bytes, offset) {
  const value = bytes.toString('hex', offset, offset + 3);
  return value === 'ffffff' || value === '000000' ? defaultColor : '#' + value;
}

function layerForRecord(rec) {
  const b = rec.data;
  const [name, first] = stringAt(b, 0, 512);
  const [, second] = stringAt(b, first, 1024);
  const [, third] = stringAt(b, second, 512);
  const flags = b[third + 7];
  const [, styles] = stringAt(b, third + 8, 4096);
  const linetype = b.readInt32LE(styles + 12);
  return { id: String(rec.id), name: name || String(rec.id), color: rgb(b, third),
    visible: (flags & 0x40) !== 0, count: 0, linetype };
}

function compose([a,b,c,d,x,y], [e,f,g,h,u,v]) {
  return [a*e+c*f, b*e+d*f, a*g+c*h, b*g+d*h, a*u+c*v+x, b*u+d*v+y];
}

function num(b, p) { return b.readDoubleLE(p); }
function xy(b, p) {
  const point = [num(b, p), num(b, p + 8)];
  requireValid(point.every(coord));
  return point;
}

function childObjects(bytes, start, count, limit = 4096) {
  requireValid(count > 0 && count <= limit);
  const out = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    const rec = objectAt(bytes, p);
    requireValid(rec.id === 0 && rec.owner === 0 && bytes.readUInt32LE(rec.start) === 0x800000);
    out.push({ ...rec, data: bytes.subarray(rec.start, rec.end) });
    p = rec.end;
  }
  return out;
}

function shapeText(bytes) {
  for (const prefix of [33, 37]) {
    try {
      const [raw, p] = stringAt(bytes, prefix);
      if (![93,109,147,163].includes(bytes.length - p)) continue;
      const content = richText(raw.replace(/(?<!%)%([cdp])/gi, '%%$1').replace(/(?<!%)%x/gi, '×'), () => {});
      if (!content.trim()) return null;
      const height = num(bytes, p);
      const angle = num(bytes, p + 24);
      const widthScale = num(bytes, p + 37);
      const origin = xy(bytes, p + 53);
      requireValid(height > 0 && coord(height) && Number.isFinite(angle) && Math.abs(angle) <= 100 &&
        Number.isFinite(widthScale) && Math.abs(widthScale) <= 100 && !content.includes('\ufffd'));
      const width = num(bytes, p + 8), depth = num(bytes, p + 16);
      const length = Math.abs(Math.sin(angle)) > Math.abs(Math.cos(angle)) ? depth : width;
      return { kind: 'text', content, height, angle, origin, anchor: 'start', vertical: 'baseline', widthScale: widthScale || 1,
        length: !content.includes('\n') && coord(length) && length > 0 && length <= height * content.length * 5 ? length : undefined };
    } catch { /* Alternate property layout. */ }
  }
  return null;
}

function attributeText(b, definition) {
  for (const prefix of [33,37]) {
    try {
      const [tag, p] = stringAt(b,prefix);
      let offsets = [p + 4];
      if (definition) {
        offsets = [p + 12];
        try { offsets.unshift(stringAt(b,p)[1] + 6); } catch { /* The description is optional. */ }
      } else {
        offsets.push(p + 6);
        try { offsets.unshift(stringAt(b,p)[1]); } catch { /* Older attributes have no separate value field. */ }
      }
      for (const q of offsets) {
        if (b.toString('hex', q, q + 16) !== type.text) continue;
        const text = childObjects(b,q,1)[0];
        return { tag, text };
      }
    } catch { /* Alternate property layout. */ }
  }
  return null;
}

export function readExbVector(container) {
  const model = container.streams.get('*BlockStg/*Blk_fffffffb');
  if (!model) return null;
  let expanded = 0, records = 0;
  const issues = new Map();
  const report = message => issues.set(message, (issues.get(message) ?? 0) + 1);
  const gaps = () => report('EXB 中有无法识别的数据段，预览可能缺少部分内容。');
  function read(entry, onGap, owner) {
    const bytes = unpack(container.read(entry, exbLimits.expandedBytes), maxExpanded - expanded);
    expanded += bytes.length;
    const result = modelObjects(bytes, onGap, owner);
    records += result.length;
    if (records > maxRecords) throw new Error('EXB 模型记录数超过预览容量。');
    return result;
  }
  const main = read(model, gaps, modelId);
  requireValid(main[0]?.guid === type.block && main[0].id === modelId);
  const layers = new Map();
  const linetypes = new Map();
  const blocks = new Map();
  const styles = container.streams.get('*StyleStream');
  function optionalRecords(entry, message) {
    try { return read(entry); } catch {
      report(message);
      return [];
    }
  }
  if (styles) {
    for (const rec of optionalRecords(styles, 'EXB 图层样式流无法读取。')) {
      try {
        if (rec.guid === type.linetype) linetypes.set(rec.id, stringAt(rec.data,0,512)[0]);
        if (rec.guid === type.layer && layers.size < 4000) {
          const layer = layerForRecord(rec);
          layers.set(layer.id, layer);
        }
      } catch { report('部分 EXB 图层属性无法读取。'); }
    }
  }
  for (const [path, entry] of container.streams) {
    if (path === '*BlockStg/*GBlock' || (path.startsWith('*BlockStg/*Blk_') && entry !== model)) {
      for (const rec of optionalRecords(entry, '部分 EXB 图块数据流无法读取。')) {
        if (rec.guid === type.block) {
          if (!blocks.has(rec.id)) blocks.set(rec.id, []);
        } else if (blocks.has(rec.owner)) blocks.get(rec.owner).push(rec);
      }
    }
  }

  const items = [];
  let visits = 0, segments = 0, chars = 0;
  function render(rec, matrix = identity, parent = null, stack = []) {
    if (++visits > maxRecords || stack.length >= 12 || items.length >= maxItems ||
        segments > exbLimits.segments || chars > exbLimits.characters) throw new Error('EXB 展开后的图元超过预览容量。');
    const kind = labels.get(rec.guid);
    const b = rec.data;
    if (!kind || b.length < 33 || b.readUInt32LE(0) !== 0x800000) {
      report('部分 EXB 图元类型尚未支持。');
      return;
    }
    const layerNumber = b.readInt32LE(4);
    const inherited = parent && layerNumber === 0;
    const layerId = inherited ? parent.layerId : String(layerNumber);
    if (!layers.has(layerId)) {
      if (layers.size >= 4000) throw new Error('EXB 图层数量超过预览容量。');
      layers.set(layerId, { id: layerId, name: layerNumber === 0 ? '默认图层' : '图层 ' + layerNumber,
        color: defaultColor, visible: true, count: 0 });
    }
    const layer = layers.get(layerId);
    const color = b[19] === 0x40 && parent ? parent.color : b[19] === 0 ? rgb(b, 16) : layer.color;
    let lineStyle = linetypes.get(b.readInt32LE(12));
    if (!lineStyle || lineStyle === 'ByLayer') lineStyle = linetypes.get(layer.linetype);
    const dash = lineStyle === 'ByBlock' ? Boolean(parent?.dash) : /dash|center|hidden|虚线|点划|中心/i.test(lineStyle ?? '');
    const layerIds = parent && !parent.layerIds.includes(layerId) ? [...parent.layerIds, layerId] : parent?.layerIds ?? [layerId];
    const context = { layerId, layerIds, color, dash, overrides: parent?.overrides };
    const emit = (shape, transform = matrix, count = 1) => {
      segments += count;
      if (shape.kind === 'text') chars += shape.content.length;
      items.push({ ...shape, matrix: transform, layerIds, color, dash });
      layer.count++;
    };

    if (kind === 'line' && (b.length === 81 || b.length === 85)) {
      const p = b.length - 48;
      emit({ kind: 'line', start: xy(b, p), end: xy(b, p + 24) });
    } else if ((kind === 'circle' || kind === 'arc') && (b.length === 121 || b.length === 125)) {
      const p = b.length - 88;
      const [x,y] = xy(b,p);
      const radius = num(b,p + 24);
      const [a,c] = xy(b,p + 32), [d,e] = xy(b,p + 56);
      const from = num(b,p + 72), to = num(b,p + 80);
      requireValid(radius > 0 && coord(radius) && [a,c,d,e].every(v => Math.abs(v) <= 1.001) &&
        Math.abs(a*e-c*d) > 1e-9 && [from,to].every(v => Number.isFinite(v) && Math.abs(v) < 100));
      if (kind === 'circle' || Math.abs(to - from) >= tau - 1e-8) {
        emit({ kind: 'circle', radius, center: [x,y] });
      } else {
        const sweep = ((to - from) % tau + tau) % tau;
        if (sweep < 1e-10) return;
        const end = angle => [radius * Math.cos(angle), radius * Math.sin(angle)].join(' ');
        emit({ kind: 'path', path: 'M ' + end(from) + ' A ' + radius + ' ' + radius + ' 0 ' +
          Number(sweep > Math.PI) + ' 1 ' + end(to), arc: { center: [0, 0], radius, start: from, sweep } },
          compose(matrix,[a,c,d,e,x,y]));
      }
    } else if (kind === 'text') {
      const shape = shapeText(b);
      if (shape) emit(shape);
      else report('部分 EXB 文字无法读取。');
    } else if (annotationKinds.has(kind)) {
      let children;
      for (const p of [33,37]) {
        try { children = childObjects(b, p + 4, b.readUInt32LE(p), 512); break; } catch { /* Alternate layout. */ }
      }
      if (!children) report('部分 EXB 标注缺少可读的线条或文字。');
      else for (const child of children) safeRender(child, matrix, context, [...stack, rec.id]);
    } else if (kind === 'attributeDefinition') {
      const value = attributeText(b,true);
      if (!value) report('部分 EXB 图块属性无法读取。');
      else if (!context.overrides?.has(value.tag) && !/^AUTOATTR\d+$/i.test(value.tag)) {
        safeRender(value.text,matrix,context,[...stack,rec.id]);
      }
    } else if (kind === 'spline') {
      for (const p of [33,37]) {
        if (p + 60 > b.length || b.readUInt32LE(p + 52) !== 1015 || b.readUInt32LE(p + 56) !== 1030) continue;
        const n = b.readUInt32LE(p + 44), degree = b.readUInt32LE(p + 48);
        const end = p + 60 + n * 32, knots = n + degree + 1;
        if (n <= degree || n > 10000 || degree < 1 || degree > 3 || end + knots * 8 !== b.length) continue;
        const groups = [[71,String(degree)]];
        for (let i = 0; i < n; i++) {
          const offset = p + 60 + i * 32;
          const [x,y] = xy(b,offset);
          groups.push([10,String(x)],[20,String(y)],[41,String(num(b,offset + 24))]);
        }
        for (let i = 0; i < knots; i++) groups.push([40,String(num(b,end + i * 8))]);
        const curve = splinePath({ type: 'SPLINE', groups }, exbLimits.segments - segments);
        if (curve) {
          emit({ kind: 'path', path: curve.path }, matrix, curve.size);
          return;
        }
      }
      report('部分 EXB 样条曲线尚未支持。');
    } else if (kind === 'solid') {
      for (const p of [33,37]) {
        if (p + 44 > b.length || b.readUInt32LE(p + 24) !== 1) continue;
        const marker = b.readUInt32LE(p + 32), loops = b.readUInt32LE(p + 28);
        if (loops === 3 && marker === 1011 && b.readUInt32LE(p + 36) === 1011 && b.length === p + 388) {
          // The arrow boundary is three straight edges, stored as endpoint pairs.
          const points = Array.from({length: 6}, (_, i) => xy(b, p + 44 + i * 24));
          if (points.every((point, i) => i % 2 === 0 || point.every((v, j) => v === points[(i + 1) % 6][j]))) {
            emit({ kind: 'fill', vertices: [points[0],points[2],points[4]] }, matrix, 3);
            return;
          }
        }
        if (loops !== 1 || marker !== 1019) continue;
        const n = b.readUInt32LE(p + 36);
        const stride = b.length === p + 236 && n === 4 ? 48 : b.length === p + 428 && n === 4 ? 40 : 0;
        if (!stride) continue;
        const vertices = Array.from({length: n}, (_, i) => {
          const offset = p + 40 + i * stride;
          const bulge = num(b, offset + 24);
          requireValid(Number.isFinite(bulge) && Math.abs(bulge) <= 100);
          return [xy(b, offset), bulge];
        });
        emit({ kind: 'filledPath', path: polylinePath(vertices, true), opacity: 1 }, matrix, n);
        return;
      }
      report('部分 EXB 填充样式尚未支持。');
    } else if (kind === 'polyline') {
      for (const p of [33,37]) {
        const start = p + 4;
        const n = b.readUInt32LE(start - 4);
        if (n < 2 || n > 10000 || start + n * 40 + 28 !== b.length) continue;
        const vertices = Array.from({ length: n }, (_, i) => {
          const offset = start + i * 40;
          const bulge = num(b, offset + 24);
          requireValid(Number.isFinite(bulge) && Math.abs(bulge) <= 100);
          return [xy(b, offset), bulge];
        });
        const closed = Boolean(b.readUInt32LE(start + n * 40) & 1);
        emit({ kind: 'path', path: polylinePath(vertices, closed) }, matrix, n);
        return;
      }
      report('部分 EXB 多段线样式尚未支持。');
    } else if (kind === 'insert') {
      for (const p of [33,37]) {
        if (p + 200 > b.length || b.readUInt32LE(p + 188) !== 0x800000) continue;
        const ref = b.readInt32LE(p + 192);
        if (stack.includes(ref)) return report('已跳过循环引用的 EXB 图块。');
        const placement = [60,68,92,100,156,164].map(n => num(b, p + n));
        requireValid(placement.every(coord) && Math.abs(placement[0]*placement[3]-placement[1]*placement[2]) > 1e-12);
        const n = b.readUInt32LE(p + 196);
        let attrs = [];
        if (n && p + 230 <= b.length && b.toString('hex', p + 200, p + 216) === type.attribute) {
          try {
            attrs = childObjects(b,p + 200,n,2048).map(attr => attributeText(attr.data,false));
            if (attrs.some(attr => !attr)) report('部分 EXB 图块属性无法读取。');
            attrs = attrs.filter(Boolean);
          } catch { report('部分 EXB 图块属性无法读取。'); }
        }
        const content = blocks.get(ref);
        const blockContext = { ...context, overrides: new Set(attrs.map(attr => attr.tag)) };
        if (content?.length) {
          const transform = compose(matrix, placement);
          for (const child of content) safeRender(child, transform, blockContext, [...stack, ref]);
        } else report('部分 EXB 图块引用的定义尚未读取。');
        for (const attr of attrs) safeRender(attr.text,matrix,context,[...stack,ref]);
        return;
      }
      report('部分 EXB 图块的变换尚未支持。');
    } else if (kind === 'ole') report('EXB 内嵌的 OLE 对象暂不显示。');
    else report('部分 EXB 图元类型尚未支持。');
  }

  function safeRender(...args) {
    try { render(...args); }
    catch (error) {
      if (error.message.includes('超过')) throw error;
      report('部分 EXB 图元的数据无法读取。');
    }
  }
  for (const rec of main) if (rec.owner === modelId) safeRender(rec);
  if (!items.length) return null;
  if (items.some(item => item.kind === 'text')) report('EXB 文字以系统字体显示，原图字形可能不同。');
  const usedLayers = new Set(items.flatMap(item => item.layerIds));
  return { format: 'CAXA EXB', layers: [...layers.values()].filter(layer => usedLayers.has(layer.id)),
    items, issues: [...issues], encoding: 'UTF-16LE' };
}
