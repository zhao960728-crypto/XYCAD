import { Buffer } from 'node:buffer';
import { definitionKey, displayListKey, openSolidWorksDrawing, solidWorksSheetInfo, textAt, unicodeMarker, viewListKey } from './slddrw-preview.mjs';
import { indexedShading, readShadedFaces, shadedView } from './slddrw-shaded.mjs';

const layerMarker = Buffer.from('uiLayerMgr_c');
const polylineTail = Buffer.from('ffffffff0100000001000000', 'hex');
const tau = Math.PI * 2;
export class SolidWorksVectorUnavailable extends Error {}

const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const roundMm = value => Number((1000 * value).toFixed(7));
const pointMm = ([x, y]) => [roundMm(x), roundMm(y)];
const coordOk = point => point.every(value => Number.isFinite(value) && Math.abs(value) <= 10);
const modelCoordOk = point => point.every(value => Number.isFinite(value) && Math.abs(value) <= 1000);
const isUnit = vector => Math.abs(dot(vector, vector) - 1) < 1e-7;
const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function floats(bytes, start, count, single = false) {
  return Array.from({ length: count }, (_, i) => single ? bytes.readFloatLE(start + i * 4) : bytes.readDoubleLE(start + i * 8));
}

function addLine(entities, start, end, layer) {
  const a = pointMm(start), b = pointMm(end);
  if (a[0] !== b[0] || a[1] !== b[1]) entities.push({ type: 'LINE', a, b, layer });
}

function displayRecords(bytes, start = bytes.indexOf(layerMarker) + layerMarker.length, end = bytes.length, readInactive = false, indexed = false) {
  const entities = [], views = [];
  let firstAnnotation = 0;
  let height, widthFactor, hasView = false;
  const lineStyle = /^(?:CONTINUOUS|CENTER|HIDDEN|CHAIN|PHANTOM|CHAIN_THICK|DUMMYTHREAD|STITCH|Visible|)$/i;
  for (let i = start; i + 8 <= end; i++) {
    if (entities.length > 100_000 || views.length > 256) throw new Error('SLDDRW 矢量图元或视图超过预览预算。');
    const size = bytes.readUInt32LE(i);
    const kind = bytes.readUInt32LE(i + 4);
    if (size === 78 && kind === 12) {
      const name = textAt(bytes, i + 26);
      if (!name || name.end > end || name.length > 64 || !lineStyle.test(name.value)) continue;
      height = undefined;
      i = name.end - 1;
      continue;
    }
    if (size === 80 && kind === 4 && i + 57 <= end && bytes[i + 56] === 0) {
      const p = floats(bytes, i + 8, 6);
      if (!coordOk(p)) continue;
      addLine(entities, p, p.slice(3), hasView ? 'ANNOTATION' : 'SHEET');
      i += 56;
      continue;
    }
    if (kind === 10 && size >= 98 && size <= 610) {
      const name = textAt(bytes, i + 40);
      if (!name || size !== 98 + 2 * name.length || name.end + 16 > end) continue;
      height = bytes.readDoubleLE(i + 8);
      widthFactor = bytes.readDoubleLE(name.end);
      i = name.end + 15;
      continue;
    }
    if (kind === 18 && size >= 156 && size <= 82_066) {
      const text = textAt(bytes, i + 48);
      if (!text || size !== 146 + 10 * text.length || text.end + 18 + 4 * text.length > end ||
          bytes.readUInt16LE(text.end) !== 1 || bytes.readUInt32LE(text.end + 2) !== text.length) continue;
      const position = floats(bytes, i + 8, 3);
      const angle = bytes.readDoubleLE(i + 36);
      const value = text.value.replace(/[\u0000-\u001f\u007f]/g, ' ').trimEnd();
      const advances = floats(bytes, text.end + 6, value.length, true);
      const validAdvances = advances.every(advance => Number.isFinite(advance) && advance >= 0 && advance < 0.25);
      const wide = /[^\u0000-\u00ff]/.test(value);
      const textHeight = height > 0 ? height : height === -1 && validAdvances ? Math.max(...advances) / (wide ? 1.25 : 0.55) : 0;
      if (value.trim() && textHeight > 0 && textHeight < 0.25 && coordOk(position) && Number.isFinite(angle) && Math.abs(angle) <= tau) {
        const nominal = value.split('').reduce((sum, char) => sum + (/[^\u0000-\u00ff]/.test(char) ? 1 : 0.55), 0) * textHeight;
        const width = validAdvances ? advances.reduce((sum, advance) => sum + advance, 0) / nominal : widthFactor;
        entities.push({ type: 'TEXT', a: pointMm(position), value, height: roundMm(textHeight),
          angle: angle * 180 / Math.PI, width: width >= 0.2 && width <= 5 ? width : 1,
          layer: hasView ? 'ANNOTATION' : 'SHEET-TEXT' });
      }
      i = text.end + 17 + 4 * text.length;
      continue;
    }
    // An identity basis can be omitted. Some compact records carry a marker before a nonzero translation.
    const compact = bytes[i - 1] === 0 && bytes[i - 2] === 0 && i + 32 <= end &&
      (!bytes.readBigUInt64LE(i) && !bytes.readBigUInt64LE(i + 8) ||
        i >= start + 16 && bytes.readUInt32LE(i - 13) === 5 && !bytes.readBigUInt64LE(i - 9));
    if (!compact && bytes[i - 1] !== 1) continue;
    const placement = i + (compact ? 24 : 96);
    if (placement + 47 > end || bytes[placement + 8] || bytes[placement + 9] ||
        bytes.readDoubleLE(placement + 34) !== 1) continue;
    const activity = bytes.readUInt32LE(placement + 43);
    if (activity !== 1 && !(readInactive && activity === 0 && placement + 119 <= end)) continue;
    const shift = floats(bytes, placement + 10, 3);
    const scale = bytes.readDoubleLE(placement);
    if (!(scale >= 0.001 && scale <= 100) || !coordOk(shift) || shift[0] < -0.01 || shift[1] < -0.01) continue;
    const basis = compact ? identity : [0, 1, 2].map(axis => [0, 24, 48].map(delta => bytes.readDoubleLE(i + axis * 8 + delta)));
    if (!basis.every(isUnit) || Math.abs(dot(basis[0], basis[1])) > 1e-7 ||
        Math.abs(dot(basis[0], basis[2])) > 1e-7 || Math.abs(dot(basis[1], basis[2])) > 1e-7) continue;
    const hasBounds = placement + 119 <= end;
    const mode = hasBounds ? bytes.readUInt32LE(placement + 115) : 0;
    const bounds = hasBounds ? floats(bytes, placement + 79, 4) : null;
    const move = floats(bytes, placement - 24, 3);
    if ((indexed || compact || !activity) && (!bounds || !(indexed ? modelCoordOk : coordOk)(move) || !coordOk(bounds) || mode < 1 || mode > 3 ||
        bounds[0] >= bounds[2] || bounds[1] >= bounds[3])) continue;
    const view = { basis, shift, move, scale, shaded: mode === 3, bounds, compact, mode, active: activity === 1 };
    if (indexed) {
      view.position = Buffer.concat([bytes.subarray(placement + 79, placement + 111), bytes.subarray(placement + 10, placement + 34)]);
      view.annotations = entities.slice(firstAnnotation).map(entity => ({ ...entity, layer: 'ANNOTATION' }));
      firstAnnotation = entities.length;
    }
    views.push(view);
    hasView = true;
    i = placement + 46;
  }
  return { entities, views };
}

function cachedEdges(bytes, readHidden = false, indexed = false) {
  if (!bytes || !bytes.subarray(0, 64).includes(Buffer.from('uiViewBucket_c'))) return [];
  const groups = [];
  let totalVertices = 0;
  for (let start = 80; start + 24 < bytes.length; start++) {
    const encoding = bytes.readUInt32LE(start - 20);
    if (indexed ? encoding !== 25 : encoding !== 40 && encoding !== 50) continue;
    const mode = bytes.readUInt32LE(start - 36);
    const modern = indexed || encoding === 50 || encoding === 40 && mode === 0;
    const scale = bytes.readDoubleLE(start - 28);
    if (!(modern ? mode <= 2 && scale > 0.001 && scale <= 100 : scale === 1 && mode === 2) ||
        bytes.readUInt32LE(start - 16)) continue;
    const normal = floats(bytes, start - 60, 3);
    if (!isUnit(normal)) continue;
    if (modern) {
      const bucket = modernEdges(bytes, start - 12, vertices => {
        totalVertices += vertices;
        if (totalVertices > 300_000) throw new Error('SLDDRW 模型视图顶点超过预览预算。');
      }, readHidden && mode === 0, indexed ? modelCoordOk : coordOk);
      if (bucket) {
        groups.push({ normal, scale, mode, offset: start, ...bucket });
        start = bucket.end - 1;
      }
      continue;
    }
    if (bytes.readUInt32LE(start - 12) || bytes.readUInt32LE(start - 8)) continue;
    const count = bytes.readUInt32LE(start - 4);
    if (!count || count > 100_000) continue;
    const edges = [];
    let offset = start;
    for (let index = 0; index < count && offset + 89 <= bytes.length; index++) {
      const side = bytes.readUInt32LE(offset + 4);
      const vertices = bytes.readUInt32LE(offset + 12);
      if (side > 3 || !side || vertices < 2 || vertices > 16_384) break;
      const afterVertices = offset + 16 + vertices * 12;
      if (afterVertices + 49 > bytes.length) break;
      const type = bytes.readUInt32LE(afterVertices + 1);
      const analytic = type === 1 && bytes.readUInt32LE(afterVertices + 5) === 12;
      const end = afterVertices + 49 + (analytic ? 100 : 0);
      if (end > bytes.length) break;
      if (!bytes.subarray(end - 12, end).equals(polylineTail)) break;
      totalVertices += vertices;
      if (totalVertices > 300_000) throw new Error('SLDDRW 模型视图顶点超过预览预算。');
      const points = Array.from({ length: vertices }, (_, i) => floats(bytes, offset + 16 + i * 12, 3, true));
      if (!points.every(coordOk)) break;
      const arc = analytic ? [9, 33, 57].map(delta => floats(bytes, afterVertices + delta, 3)) : null;
      edges.push({ points, arc: arc?.every(coordOk) ? arc : null });
      offset = end;
    }
    if (edges.length === count) {
      groups.push({ normal, edges, scale });
      start = offset - 1;
    }
  }
  return groups;
}

function modernEdges(bytes, offset, countVertices, readHidden, validPoint) {
  const edges = [];
  let extended = false;
  // The first two lists carry contour records. The next list holds visible
  // model edges, followed by occluded model edges.
  function readList(list) {
    const result = [];
    if (offset + 4 > bytes.length) return null;
    const count = bytes.readUInt32LE(offset);
    if (count > 100_000) return null;
    offset += 4;
    for (let i = 0; i < count; i++) {
      if (offset + 16 > bytes.length) return null;
      const kind = bytes.readUInt32LE(offset + 8);
      const alternate = kind === 0 && bytes.readUInt32LE(offset + 4) === 1;
      if (!alternate && (list < 2 ? kind !== 785 && kind !== 817 : kind !== 769 && kind !== 801)) return null;
      const vertices = bytes.readUInt32LE(offset + 12);
      const start = offset + 16;
      const tail = start + vertices * 24;
      if (vertices < 2 || vertices > 16_384 || tail + 57 > bytes.length) return null;
      const type = bytes.readUInt32LE(tail + 1);
      const descriptor = bytes.readUInt32LE(tail + 5);
      const analytic = type === 1 && descriptor === 12;
      const footer = tail + (analytic ? 100 : 0);
      if (alternate) {
        // Descriptor 101 has a separate flag for the optional 83-byte geometry payload.
        if (footer + 89 > bytes.length || bytes[footer] ||
            !floats(bytes, footer + 1, 2, true).every(Number.isFinite) ||
            bytes.readUInt32LE(footer + 9) !== 101 || bytes.readUInt32LE(footer + 49) > 1) return null;
        offset = footer + 89 + 83 * bytes.readUInt32LE(footer + 49);
        extended = true;
      } else {
        if (!analytic && (type !== 0 || descriptor < 106 || descriptor > 111)) return null;
        offset = footer + (kind & 32 ? 140 : 57);
      }
      if (offset > bytes.length) return null;
      countVertices(vertices);
      const points = Array.from({ length: vertices }, (_, j) => floats(bytes, start + j * 24, 3));
      if (!points.every(validPoint)) return null;
      const arc = analytic ? [9, 33, 57].map(delta => floats(bytes, tail + delta, 3)) : null;
      result.push({ points, arc: arc?.every(validPoint) ? arc : null });
    }
    return result;
  }
  for (let list = 0; list < 3; list++) {
    const result = readList(list);
    if (!result) return null;
    for (const edge of result) edges.push(edge);
  }
  if (!edges.length) return null;
  const end = offset;
  const hidden = readHidden ? readList(3) : null;
  return { edges, hidden, modern: true, extended, end: hidden ? offset : end };
}

function project(view, point) {
  return view.basis.slice(0, 2).map((axis, i) => dot(axis, point) * view.scale + view.move[i] + view.shift[i]);
}

function viewBoundsError(group, view, outer) {
  if (outer) {
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const { points } of group.edges) for (const point of points) for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i], point[i]);
      high[i] = Math.max(high[i], point[i]);
    }
    return Math.max(...view.bounds.map((value, index) => {
      const axis = index % 2;
      const corner = view.basis[axis].map((coefficient, i) => (coefficient < 0) === (index >= 2) ? low[i] : high[i]);
      return Math.abs(value - project(view, corner)[axis]);
    }));
  }
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { points } of group.edges) for (const point of points) {
    const [x, y] = project(view, point);
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  }
  return Math.max(...bounds.map((value, i) => Math.abs(value - view.bounds[i])));
}

function scaleFits(group, view) {
  const sameScale = Math.abs(group.scale - view.scale) <= 1e-7 ||
    group.modern && Math.abs(group.scale * view.scale - 1) <= 1e-7;
  return sameScale && view.bounds?.every(Number.isFinite);
}

function edgesFit(group, view) {
  return scaleFits(group, view) && viewBoundsError(group, view, view.shaded) <= 0.00005;
}

function projectEdge(entities, edge, view, layer) {
  const points = edge.points.map(point => project(view, point));
  if (edge.arc) {
    const [center, start, end] = edge.arc.map(point => project(view, point));
    const distance = point => Math.hypot(point[0] - center[0], point[1] - center[1]);
    const radius = distance(start);
    if (radius > 1e-8 && Math.abs(distance(end) - radius) < 1e-7 &&
        points.every(point => Math.abs(distance(point) - radius) < Math.max(radius * 1e-5, 1e-8))) {
      const radians = point => Math.atan2(point[1] - center[1], point[0] - center[0]);
      const angles = points.map(radians);
      let sweep = 0;
      for (let i = 1; i < angles.length; i++) sweep += Math.atan2(Math.sin(angles[i] - angles[i - 1]), Math.cos(angles[i] - angles[i - 1]));
      if (Math.abs(sweep) > 1e-5) {
        const deg = point => (radians(point) * 180 / Math.PI + 360) % 360;
        const pair = sweep < 0 ? [end, start] : [start, end];
        const full = Math.abs(Math.abs(sweep) - tau) < 1e-4;
        entities.push({ type: full ? 'CIRCLE' : 'ARC', a: pointMm(center), radius: roundMm(radius), angles: pair.map(deg), layer });
        return;
      }
    }
  }
  if (points.length === 2) return addLine(entities, points[0], points[1], layer);
  const anchor = points[0];
  const far = points.reduce((best, point) => Math.hypot(point[0] - anchor[0], point[1] - anchor[1]) >
    Math.hypot(best[0] - anchor[0], best[1] - anchor[1]) ? point : best);
  const delta = [far[0] - anchor[0], far[1] - anchor[1]];
  const length = Math.hypot(...delta);
  if (length <= 1e-8) return;
  if (points.every(([x, y]) => Math.abs((x - anchor[0]) * delta[1] - (y - anchor[1]) * delta[0]) <= 1e-8 * length)) {
    const start = points.reduce((best, point) => dot(point, delta) < dot(best, delta) ? point : best);
    return addLine(entities, start, far, layer);
  }
  const vertices = [];
  for (const point of points.map(pointMm)) {
    const last = vertices.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) vertices.push(point);
  }
  if (vertices.length === 2) entities.push({ type: 'LINE', a: vertices[0], b: vertices[1], layer });
  else if (vertices.length > 2) entities.push({ type: 'LWPOLYLINE', vertices, layer });
}

function sheetHeader(bytes, name) {
  const size = name.length < 255 ? Buffer.from([name.length]) : Buffer.from([255, name.length & 255, name.length >>> 8]);
  const marker = Buffer.concat([unicodeMarker, size, Buffer.from(name, 'utf16le')]);
  let result;
  for (let i = bytes.indexOf(marker); i >= 0; i = bytes.indexOf(marker, i + marker.length)) {
    if (i < 16) continue;
    const [height, width] = floats(bytes, i - 16, 2);
    if (!(height >= 0.03 && width >= 0.03 && height <= 5 && width <= 5)) continue;
    if (result) return null;
    result = { start: i - 16, end: i + marker.length, width: roundMm(width) };
  }
  return result;
}

function indexedPages(definition, bytes, pages, start, active, groups) {
  if (!definition?.subarray(0, 256).includes(Buffer.from('moDrawing_c'))) return false;
  const catalogueEnd = definition.indexOf('moExtObjectList_c');
  if (catalogueEnd < 0) return false;
  const records = displayRecords(bytes, start, bytes.length, true, true);
  if (groups.length !== records.views.length || records.views.length === 0 ||
      records.views.reduce((sum, view) => sum + view.annotations.length, 0) !== records.entities.length) return false;

  const byId = new Map();
  let sheet = 0;
  for (let at = definition.indexOf(unicodeMarker); at >= 0 && at < catalogueEnd; at = definition.indexOf(unicodeMarker, at + 3)) {
    const entry = textAt(definition, at);
    if (!entry?.length || at < 24 || entry.end > catalogueEnd) continue;
    const stamp = textAt(definition, at - 24);
    if (stamp?.value === 'Modified' && entry.value === pages[sheet]?.name) {
      sheet++;
      if (sheet === pages.length) break;
    } else if (textAt(definition, at - 22)?.value === 'Created') {
      const id = definition.readUInt32LE(at - 4);
      if (byId.has(id)) return false;
      byId.set(id, { sheet, name: entry.value });
    }
  }
  if (sheet !== pages.length) return false;

  // The detailed view carries the catalogue object ID and the display rectangle and origin.
  const detailed = [];
  const viewMarker = Buffer.from('0000d386fffeff', 'hex');
  for (let at = definition.indexOf(viewMarker, catalogueEnd); at >= 0; at = definition.indexOf(viewMarker, at + viewMarker.length)) {
    const name = textAt(definition, at + 4);
    if (!name?.length || name.end + 20 > definition.length || definition.readDoubleLE(name.end) !== 2 ||
        textAt(definition, name.end + 16)?.length !== 0) continue;
    const entry = byId.get(definition.readUInt32LE(name.end + 8));
    if (entry?.name === name.value) detailed.push({ ...entry, at: name.end });
    if (detailed.length > records.views.length) return false;
  }
  if (detailed.length !== records.views.length) return false;

  const assignments = [];
  for (const [i, view] of records.views.entries()) {
    const { sheet, at, name } = detailed[i];
    const end = detailed[i + 1]?.at ?? definition.length;
    const position = definition.indexOf(view.position, at);
    const group = groups[i];
    const direction = view.basis.map(axis => axis[2]);
    if (view.active !== (sheet === active) || position < at || position + view.position.length > end ||
        !scaleFits(group, view) || dot(direction, group.normal) < 0.999999 ||
        Math.min(viewBoundsError(group, view, false), viewBoundsError(group, view, true)) > 0.00025 ||
        (!view.shaded && (group.mode !== 0 || view.mode === 1 && !group.hidden))) return false;
    assignments.push({ sheet, view: { ...view, name }, group });
  }
  for (const { sheet, view, group } of assignments) {
    for (const entity of view.annotations) pages[sheet].entities.push(entity);
    pages[sheet].views.push({ ...view, group });
  }
  return true;
}

function displayPages(bytes, names, active, definition, indexedGroups) {
  const marker = bytes.indexOf(layerMarker);
  if (marker < 0) return null;
  if (names.length === 1) return [{ name: names[0], ...displayRecords(bytes) }];
  if (!Number.isInteger(active) || active < 0 || active >= names.length) return null;
  const headers = names.map((name, i) => sheetHeader(bytes, i === active ? name + '-Active' : name));
  if (headers.some((header, i) => !header || header.start < (i ? headers[i - 1]?.end : marker))) return null;
  const pages = headers.map(({ start, width }, i) => ({ name: names[i], width,
    ...displayRecords(bytes, i ? headers[i - 1].end : marker + layerMarker.length, start) }));
  if (indexedGroups.length && indexedPages(definition, bytes, pages, headers.at(-1).end, active, indexedGroups)) return pages;
  const tail = displayRecords(bytes, headers.at(-1).end, bytes.length, names.length === 2);
  for (const entity of tail.entities) pages[active].entities.push(entity);
  for (const view of tail.views) pages[view.active ? active : 1 - active].views.push(view);
  return pages;
}

function viewGroup(groups, view, strict, usedExtended) {
  const matches = groups.filter(group => !group.extended && (group.modern ? (group.mode === 1) === view.shaded && edgesFit(group, view) :
    Math.abs(dot(view.basis[2], group.normal)) > 0.999999 && (!strict && !view.compact || edgesFit(group, view))));
  if (!matches.length || strict && matches.length > 1) {
    // This cache stores the third basis column. Its page box can use model extents instead of visible edges.
    const column = view.basis.map(axis => axis[2]);
    const ranked = (matches.length ? matches : groups).filter(group => group.modern &&
      (group.extended ? !view.shaded && view.mode === 2 && group.mode === 2 && !usedExtended?.has(group)
        : strict && group.mode === Number(view.shaded)) && scaleFits(group, view) && Math.abs(dot(column, group.normal)) > 0.999999)
      .map(group => ({ group, error: Math.min(viewBoundsError(group, view, false), viewBoundsError(group, view, true)) }))
      .filter(({ error }) => error <= 0.00025).sort((a, b) => a.error - b.error);
    if (ranked.length && (ranked.length === 1 || ranked[1].error - ranked[0].error > 0.00001)) return ranked[0].group;
  }
  if (matches.length === 1) return matches[0];
  const parallel = matches.filter(group => Math.abs(dot(view.basis[2], group.normal)) > 0.999999);
  if (parallel.length === 1) return parallel[0];
  const direct = parallel.filter(group => dot(view.basis[2], group.normal) > 0.999999);
  return direct.length === 1 ? direct[0] : null;
}

export function readSolidWorksVector(input, expected = false) {
  const streams = openSolidWorksDrawing(input, expected, true);
  if (!streams) return null;
  const { names, declared, active } = solidWorksSheetInfo(streams);
  if (!declared && !streams.has(displayListKey)) {
    if (!expected) return null;
    throw new Error('此 SLDDRW 没有可识别的工程图页。');
  }
  const display = streams.get(displayListKey);
  if (!declared || declared > 64 || declared > 1 && names?.length !== declared) {
    throw new SolidWorksVectorUnavailable('无法确认此 SLDDRW 的矢量页序。');
  }
  const cache = streams.get(viewListKey);
  const indexedGroups = declared > 2 && cache?.length > 64 && cache.readUInt32LE(64) === 25 &&
    cache.readUInt32LE(0) <= 256 ? cachedEdges(cache, true, true) : [];
  const definition = indexedGroups.length && indexedGroups.length === cache.readUInt32LE(0)
    ? openSolidWorksDrawing(input, expected, 'definition')?.get(definitionKey) : null;
  const pages = display && displayPages(display, names ?? ['图纸 1'], active - 1, definition, indexedGroups);
  if (!pages || !pages.some(page => page.entities.length)) {
    throw new SolidWorksVectorUnavailable('此 SLDDRW 没有可读取的分页面矢量记录。');
  }
  const groups = cachedEdges(cache, declared > 1);
  const usedExtended = new Set();
  const usedGroups = new Set();
  const views = pages.flatMap(page => page.views);
  const indexed = views.some(view => view.group);
  const shadedCache = indexed ? indexedShading(cache, views) : null;
  const faces = !indexed && views.some(view => view.shaded) ? readShadedFaces(cache) : null;
  const sheetOnly = cache?.length === 8 && !cache.readBigUInt64LE(0) && pages.every(page => !page.views.length);
  let total = 0;
  const sheets = pages.map(({ name, width, entities, views }) => {
    const shaded = [];
    let restoredViews = 0, skippedViews = 0;
    for (const [index, view] of views.entries()) {
      const layer = 'VIEW-' + (index + 1);
      const available = declared === 2 ? groups.filter(group => !usedGroups.has(group)) : groups;
      if (view.shaded) {
        const outlines = view.group ?? viewGroup(available.filter(group => group.modern), view, true);
        const result = shadedView(indexed ? shadedCache.get(view) : faces, view, layer, !outlines);
        for (const entity of result) shaded.push(entity);
        if (outlines && (result.length || view.group)) {
          const edges = [];
          for (const edge of outlines.edges) projectEdge(edges, edge, view, layer + '-EDGES');
          for (const edge of edges) shaded.push(view.group ? { ...edge, color: 0x252525 } : edge);
          usedGroups.add(outlines);
        }
        if (result.length) restoredViews++;
        else skippedViews++;
        continue;
      }
      const group = view.group ?? viewGroup(available, view, declared > 1, usedExtended);
      if (!group) {
        skippedViews++;
        continue;
      }
      for (const edge of group.edges) projectEdge(entities, edge, view, layer);
      if (view.mode === 1) {
        for (const edge of group.hidden ?? []) projectEdge(entities, edge, view, layer + '-HIDDEN');
        if (declared > 1 && group.modern && !group.hidden) skippedViews++;
      }
      if (group.extended) usedExtended.add(group);
      usedGroups.add(group);
      restoredViews++;
    }
    total += entities.length + shaded.length;
    return { name, width, entities: [...shaded, ...entities], restoredViews, skippedViews,
      hiddenDash: entities.some(entity => entity.layer.endsWith('-HIDDEN')) ? 1 : undefined };
  });
  if (total > 100_000) throw new Error('SLDDRW 矢量图元超过预览预算。');
  // Drawings with model references can cache only the last active sheet's projected views.
  const completePages = sheetOnly || declared === 1 && sheets[0].restoredViews > 0 && !sheets[0].skippedViews &&
    groups.every(group => !group.extended || usedExtended.has(group)) ||
    declared === 2 && groups.length > 0 && usedGroups.size === groups.length &&
      sheets.every(sheet => sheet.entities.length && !sheet.skippedViews) ||
    indexed && usedGroups.size === indexedGroups.length &&
      sheets.every(sheet => sheet.entities.length && !sheet.skippedViews);
  return { ...sheets[0], sheets, completePages };
}
