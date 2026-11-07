import { Buffer } from 'node:buffer';
import { readAc1032Sections } from './dwg-ac1032-container.mjs';
import { readAc1021Sections } from './dwg-ac1021-container.mjs';
import { readAc1015, readAc1015Units, readAc1018Units, readDwgCodepage } from './dwg-ac1015.mjs';
import { entityHeader, objectIndex, openObject, readClasses, readDrawingUnits } from './dwg-ac1032-records.mjs';
import { coordinates, entityTypes, readDrawingEntity, readSortOrder, readSymbol, readWipeoutFrame } from './dwg-ac1032-entities.mjs';
import { readAc1018MLeader, readAc1018MLeaderStyle } from './dwg-mleader.mjs';

import { MiB } from '../public/cad-limits.mjs';
import { dxfExportBytes, modelRecordLimit } from './cad-budget.mjs';

const symbolTypes = new Map([[49, 'BLOCK_RECORD'], [51, 'LAYER'], [53, 'STYLE'], [57, 'LTYPE'], [69, 'DIMSTYLE']]);
const symbolSubclasses = {
  BLOCK_RECORD: 'AcDbBlockTableRecord', LAYER: 'AcDbLayerTableRecord', STYLE: 'AcDbTextStyleTableRecord',
  LTYPE: 'AcDbLinetypeTableRecord', DIMSTYLE: 'AcDbDimStyleTableRecord', APPID: 'AcDbRegAppTableRecord',
};
const subclasses = {
  ARC: 'AcDbCircle', CIRCLE: 'AcDbCircle', DIMENSION: 'AcDbDimension', ELLIPSE: 'AcDbEllipse',
  ARC_DIMENSION: 'AcDbDimension', WIPEOUT: 'AcDbWipeout',
  LARGE_RADIAL_DIMENSION: 'AcDbDimension',
  INSERT: 'AcDbBlockReference', LEADER: 'AcDbLeader', LINE: 'AcDbLine', LWPOLYLINE: 'AcDbPolyline',
  POLYLINE: 'AcDb2dPolyline', VERTEX: 'AcDbVertex',
  MTEXT: 'AcDbMText', POINT: 'AcDbPoint', SOLID: 'AcDbTrace', TRACE: 'AcDbTrace', TEXT: 'AcDbText', SPLINE: 'AcDbSpline',
  ATTRIB: 'AcDbText', ATTDEF: 'AcDbText', HATCH: 'AcDbHatch',
  MULTILEADER: 'AcDbMLeader',
};

const hex = value => value.toString(16).toUpperCase();
const normalized = name => name.toUpperCase();
const modelSpace = '*MODEL_SPACE';
const paperSpace = '*PAPER_SPACE';
const unnamedBlock = name => /^\*[A-Za-z]$/.test(name);
const customEntities = new Set(['ACAD_TABLE', 'LARGE_RADIAL_DIMENSION', 'ARC_DIMENSION', 'WIPEOUT']);
const entitiesWithReferences = new Set(['INSERT', 'ACAD_TABLE', 'DIMENSION', 'LARGE_RADIAL_DIMENSION', 'ARC_DIMENSION', 'LEADER']);
const recognizedOtherEntities = new Set([11, 12, 13, 14, 16, 28, 29, 30, 33, 37, 38, 39, 40, 41, 46, 47, 498]);
const drawingOrderObjects = new Set(['SORTENTSTABLE', 'WIPEOUTVARIABLES', 'WIPEOUTVARIABLE']);
const hasMLeaderLayout = (object, type) => object.version === 1018 && type === 'MULTILEADER';

function ensureUnique(symbols, report) {
  const seen = new Map();
  for (const [handle, entry] of symbols) {
    const table = seen.get(entry.table) ?? new Set();
    seen.set(entry.table, table);
    const upper = normalized(entry.name);
    if (entry.table === 'MLEADERSTYLE') continue;
    if (entry.table === 'BLOCK_RECORD' && upper.startsWith(paperSpace)) continue;
    if (table.has(upper) || (entry.table === 'BLOCK_RECORD' && unnamedBlock(entry.name))) {
      if (entry.table === 'BLOCK_RECORD' && entry.name.startsWith('*')) {
        entry.name = entry.name.slice(0, 2) + hex(handle);
      } else {
        entry.name += '_XY' + hex(handle);
        report('重名的符号表记录已区分命名。');
      }
      while (table.has(normalized(entry.name))) entry.name += '_';
    }
    table.add(normalized(entry.name));
  }
}

function polylineVertices(open, index, parent, definition) {
  const visited = new Set();
  function child(id, type) {
    if (!id || !index.has(id) || visited.has(id)) throw new Error('旧式多段线子对象链无效。');
    visited.add(id);
    const object = open(index.get(id), id);
    if (object.type !== type) throw new Error('旧式多段线子对象类型不符。');
    const header = entityHeader(object);
    if (header.mode !== 0 || header.owner !== parent) throw new Error('旧式多段线子对象归属不符。');
    return { object, header };
  }
  function vertex(id) {
    const { object, header } = child(id, 10);
    const definition = readDrawingEntity(object, 'VERTEX');
    if (definition.groups.some(([, value]) => !Number.isFinite(value))) throw new Error('顶点包含非有限数。');
    return { handle: id, header, type: 'VERTEX', definition };
  }
  let vertices;
  if (definition.vertexHandles) {
    vertices = definition.vertexHandles.map(vertex);
  } else {
    vertices = [];
    const [first, last] = definition.vertexRange;
    for (let id = first; id && vertices.length < 30000;) {
      const item = vertex(id);
      vertices.push(item);
      if (id === last) break;
      id = item.header.next;
    }
    if (vertices.at(-1)?.handle !== last) throw new Error('旧式多段线顶点链不完整。');
  }
  if (!vertices.length) throw new Error('旧式多段线没有顶点。');
  child(definition.sequenceEnd, 6);
  return vertices;
}

// The large AC1021 preview needs the full index for lookups, but only decodes
// geometry reachable from model space. Group members by owner using headers.
function reachableModelObjects(open, index, classes, symbols) {
  const model = [...symbols].find(([, symbol]) => symbol.table === 'BLOCK_RECORD' && normalized(symbol.name) === modelSpace)?.[0];
  const members = new Map();
  const selected = new Set();
  const visitedOwners = new Set();
  const select = handle => {
    if (!selected.has(handle) && selected.size >= modelRecordLimit) {
      throw new Error('模型引用的图元数量超过大图预览容量。');
    }
    selected.add(handle);
  };
  for (const [handle, offset] of index) {
    let header;
    try {
      const object = open(offset, handle);
      const custom = classes.get(object.type);
      if (drawingOrderObjects.has(custom?.name)) {
        select(handle);
        continue;
      }
      if (object.type === 10 || !(entityTypes.has(object.type) || custom?.entity ||
          customEntities.has(custom?.name) || recognizedOtherEntities.has(object.type) ||
          ((object.legacy || object.version === 1018) && object.type === 74))) continue;
      header = entityHeader(object);
    } catch {
      continue;
    }
    if (header.mode === 2 || (header.mode === 0 && header.owner === model)) select(handle);
    else if (header.mode === 0 && header.owner) {
      if (!members.has(header.owner)) members.set(header.owner, []);
      members.get(header.owner).push(handle);
    }
  }
  function selectMembers(owner) {
    if (!owner || visitedOwners.has(owner)) return;
    visitedOwners.add(owner);
    for (const handle of members.get(owner) ?? []) select(handle);
  }
  for (const handle of selected) {
    // Attached attributes are owned by their INSERT, not by the block.
    selectMembers(handle);
    let definition;
    try {
      const object = open(index.get(handle), handle);
      const type = entityTypes.get(object.type) ?? classes.get(object.type)?.name;
      if (!entitiesWithReferences.has(type) && !hasMLeaderLayout(object, type)) continue;
      entityHeader(object);
      definition = hasMLeaderLayout(object, type) ? readAc1018MLeader(object) : readDrawingEntity(object, type);
    } catch {
      // The normal geometry reader reports unreadable reachable entities.
      continue;
    }
    selectMembers(definition.block);
    if (definition.mleaderStyle) {
      selectMembers(symbols.get(definition.mleaderStyle)?.arrow);
      for (const block of definition.arrowBlocks) selectMembers(block);
    }
    for (const [code, block] of symbols.get(definition.dimstyle)?.styleRefs ?? []) {
      if (code >= 341 && code <= 344 && symbols.get(block)?.table === 'BLOCK_RECORD') selectMembers(block);
    }
  }
  return selected;
}

function modelEntities(open, index, classes, symbols, report, selected) {
  const top = [];
  const members = new Map();
  const attributes = new Map();
  const legacyLinks = new Map();
  const sortObjects = [];
  let wipeoutFrame;
  let hasWipeout = false;
  const paper = new Set([...symbols].filter(([, value]) => value.table === 'BLOCK_RECORD' &&
    normalized(value.name).startsWith(paperSpace)).map(([handle]) => handle));
  const model = [...symbols].find(([, item]) => item.table === 'BLOCK_RECORD' && normalized(item.name) === modelSpace);
  const inModel = header => header.mode === 2 || (header.mode === 0 && header.owner === model?.[0]);
  let modelHadEntities = false;
  let unreadableObjects = false;
  let paperCount = 0;
  let detached = 0;
  const counts = {};
  for (const [handle, offset] of index) {
    if (selected && !selected.has(handle)) continue;
    let object;
    let type;
    try {
      object = open(offset, handle);
      if (object.type === 10) continue; // 2D vertices are read through their owning polyline.
      const custom = classes.get(object.type);
      type = entityTypes.get(object.type) || custom?.name;
      if (type === 'SORTENTSTABLE') {
        sortObjects.push([offset, handle]);
        continue;
      }
      if (type === 'WIPEOUTVARIABLES' || type === 'WIPEOUTVARIABLE') {
        wipeoutFrame = readWipeoutFrame(object);
        continue;
      }
      const multiLeader = hasMLeaderLayout(object, type);
      const known = entityTypes.has(object.type) || customEntities.has(type) || multiLeader || (object.legacy && type === 'HATCH');
      if (!known) {
        const oldOle = (object.legacy || object.version === 1018) && object.type === 74;
        if (custom?.entity || oldOle ||
            recognizedOtherEntities.has(object.type)) {
          const header = entityHeader(object);
          if (inModel(header)) modelHadEntities = true;
          if (object.legacy) legacyLinks.set(handle, header.next);
          const legacyName = oldOle ? 'OLE2FRAME' : object.legacy && object.type === 33 ? 'SHAPE' : undefined;
          if (header.mode !== 1 && !paper.has(header.owner)) {
            report(type === 'PDFUNDERLAY' ? '图纸包含外部 PDF 底图，当前矢量只显示 DWG 内的图元。'
              : '尚未转出图元 ' + (type || legacyName || '0x' + hex(object.type)) + '。');
          }
        }
        continue;
      }
      const header = entityHeader(object);
      if (inModel(header)) modelHadEntities = true;
      if (object.legacy) legacyLinks.set(handle, header.next);
      if (header.mode === 1 || paper.has(header.owner)) {
        paperCount++;
        continue;
      }
      if (header.mode === 0 && !index.has(header.owner)) {
        detached++;
        continue;
      }
      const definition = multiLeader ? readAc1018MLeader(object) : readDrawingEntity(object, type);
      if (multiLeader && symbols.get(definition.mleaderStyle)?.table !== 'MLEADERSTYLE') {
        report('多重引线引用的样式不可用，已跳过。');
        continue;
      }
      if (definition.obliqueInBlock) report('倾斜尺寸沿用保存的图形块，DXF 重新生成标注时可能改变倾斜角。');
      if (type === 'WIPEOUT') hasWipeout = true;
      if (definition.groups.some(([, value]) => typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error('图元几何包含非有限数。');
      }
      if (type === 'POLYLINE') definition.vertices = polylineVertices(open, index, handle, definition);
      if (type === 'ATTRIB') {
        attributes.set(handle, { handle, type, header, definition });
      } else if (inModel(header)) {
        top.push({ handle, type, header, definition });
        counts[type] = (counts[type] ?? 0) + 1;
      } else if (header.mode === 0 && symbols.get(header.owner)?.table === 'BLOCK_RECORD') {
        if (!members.has(header.owner)) members.set(header.owner, []);
        members.get(header.owner).push({ handle, type, header, definition });
      } else {
        report('有图元归属未知，已跳过。');
      }
    } catch (error) {
      unreadableObjects = true;
      const reason = error.message.includes('非有限') ? '含无效数值' : '读取失败';
      report(type ? type + ' ' + reason + '，已跳过。' : '有 DWG 对象记录无法读取，已跳过。');
    }
  }
  if (paperCount) report('本阶段只转换模型空间，已跳过布局图元。', paperCount);
  let modelItems = top;
  if (legacyLinks.size) {
    for (const items of [top, ...members.values()]) {
      for (const item of items) {
        const range = item.definition.attributeRange;
        if (!range?.[0]) continue;
        const [first, last] = range;
        const linked = [];
        const visited = new Set();
        for (let id = first; id && !visited.has(id) && linked.length < 8192;) {
          const attribute = attributes.get(id);
          if (!attribute || attribute.header.owner !== item.handle) break;
          linked.push(id);
          visited.add(id);
          if (id === last) break;
          id = attribute.header.next;
        }
        if (linked.at(-1) !== last) report('有块引用属性链不完整。');
        item.definition.attributes = linked;
      }
    }
    for (const [id, items] of members) members.set(id, linkedOrder(items, symbols.get(id).entityRange, legacyLinks));
    modelItems = linkedOrder(top, model?.[1].entityRange, legacyLinks);
  }
  if (hasWipeout) {
    for (const [offset, handle] of sortObjects) {
      try {
        const { block, order } = readSortOrder(open(offset, handle));
        if (!order.size) continue;
        const items = block === model?.[0] ? modelItems : members.get(block);
        items?.sort((a, b) => (order.get(a.handle) ?? a.handle) - (order.get(b.handle) ?? b.handle));
      } catch { report('部分 DWG 绘制顺序无法读取，遮罩覆盖关系可能有差异。'); }
    }
  }
  const emptyModel = Boolean(model && !modelHadEntities && !unreadableObjects);
  return { top: modelItems, members, attributes, counts, detached, wipeoutFrame, emptyModel };
}

function linkedOrder(items, range, links) {
  if (items.length < 2 || !range?.[0]) return items;
  const [first, last] = range;
  const indexed = new Map(items.map(item => [item.handle, item]));
  const result = [];
  const visited = new Set();
  for (let id = first; id && !visited.has(id); id = links.get(id)) {
    visited.add(id);
    if (indexed.has(id)) result.push(indexed.get(id));
    if (id === last) return result.length === items.length ? result : items;
  }
  return items;
}

function serialize(symbols, geometry, units, nextHandle, report, keepChunks, emptyModel) {
  const chunks = [];
  const out = [];
  let size = 0;
  const flush = () => {
    if (!out.length) return;
    const chunk = Buffer.from(out.join('\n') + '\n', 'utf8');
    size += chunk.length;
    if (size > dxfExportBytes) throw new Error('转换结果超出本版 DXF 容量。');
    chunks.push(chunk);
    out.length = 0;
  };
  const emit = (code, value) => {
    const safe = typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ') : value;
    out.push(String(code), String(safe));
    if (out.length >= 16384) flush();
  };
  const emitAll = groups => { for (const [code, value] of groups) emit(code, value); };
  const section = (name, body) => {
    emit(0, 'SECTION'); emit(2, name);
    body();
    emit(0, 'ENDSEC');
  };
  const allocate = () => ++nextHandle;
  const symbolName = (id, table, fallback) => symbols.get(id)?.table === table ? symbols.get(id).name : fallback;
  function ensure(table, name, groups) {
    const existing = [...symbols].find(([, item]) => item.table === table && normalized(item.name) === normalized(name));
    if (existing) return existing[0];
    const handle = allocate();
    symbols.set(handle, { table, name, groups, base: [0, 0, 0], flags: 0 });
    return handle;
  }
  const model = ensure('BLOCK_RECORD', '*Model_Space', []);
  const paper = ensure('BLOCK_RECORD', '*Paper_Space', []);
  ensure('LAYER', '0', [[70, 0], [62, 7]]);
  ensure('STYLE', 'Standard', [[70, 0], [40, 0], [41, 1], [50, 0], [71, 0], [42, 1], [3, 'txt'], [4, '']]);
  ensure('DIMSTYLE', 'Standard', [[70, 0]]);
  ensure('APPID', 'ACAD', [[70, 0]]);
  for (const type of ['ByBlock', 'ByLayer', 'Continuous']) ensure('LTYPE', type, [[70, 0], [3, ''], [72, 65], [73, 0], [40, 0]]);
  const namedObjects = allocate();
  const plotStyles = allocate();
  const normalPlotStyle = allocate();

  const blocks = [...symbols].filter(([handle, item]) => item.table === 'BLOCK_RECORD' &&
    (!normalized(item.name).startsWith(paperSpace) || handle === paper));
  const entityLists = [geometry.top, ...blocks.filter(([id]) => id !== model && id !== paper)
    .map(([id]) => geometry.members.get(id) ?? [])];
  const hatchReactors = new Map();
  const associative = [];
  const boundaryHandles = new Set();
  let wipeouts = 0;
  let arcDimensions = 0;
  let mleaders = 0;
  const mleaderStyles = new Map();
  for (const items of entityLists) {
    for (const item of items) {
      if (item.type === 'WIPEOUT') wipeouts++;
      if (item.type === 'ARC_DIMENSION') arcDimensions++;
      if (item.type === 'MULTILEADER') {
        mleaders++;
        const style = item.definition.mleaderStyle;
        mleaderStyles.set(style, symbols.get(style));
      }
      if (item.type !== 'HATCH' || !item.definition.groups.some(([code, value]) => code === 71 && value)) continue;
      const boundary = new Set(item.definition.groups.filter(([code]) => code === 330).map(([, value]) => value));
      associative.push({ hatch: item, boundary });
      for (const id of boundary) boundaryHandles.add(id);
    }
  }
  const availableBoundaries = new Set();
  if (boundaryHandles.size) {
    for (const items of entityLists) {
      for (const item of items) {
        const id = hex(item.handle);
        if (boundaryHandles.has(id) &&
            (!['INSERT', 'ACAD_TABLE'].includes(item.type) || symbolName(item.definition.block, 'BLOCK_RECORD'))) availableBoundaries.add(id);
      }
    }
  }
  for (const { hatch, boundary } of associative) {
    if (boundary.size && [...boundary].every(id => availableBoundaries.has(id) && id !== hex(hatch.handle))) {
      for (const id of boundary) {
        if (!hatchReactors.has(id)) hatchReactors.set(id, []);
        hatchReactors.get(id).push(hex(hatch.handle));
      }
    } else {
      const groups = hatch.definition.groups;
      hatch.definition.groups = groups.flatMap(([code, value], i) => {
        if (code === 330) return [];
        return [[code, code === 71 || (code === 97 && groups[i + 1]?.[0] === 330) ? 0 : value]];
      });
      report('有填充边界无法关联，已保留填充形状。');
    }
  }
  const wipeoutVariables = wipeouts ? allocate() : 0;
  const mleaderDictionary = mleaders ? allocate() : 0;

  function entity({ handle, type, header, definition }, owner, polylineHeader) {
    const block = symbolName(definition.block, 'BLOCK_RECORD');
    const isTable = type === 'ACAD_TABLE';
    const needsBlock = isTable || type === 'INSERT';
    if (needsBlock && !block) {
      report(type + ' 引用的图形块不可用。');
      return;
    }
    const isDimension = type === 'DIMENSION' || type === 'LARGE_RADIAL_DIMENSION' || type === 'ARC_DIMENSION';
    if (isDimension && (!block || !geometry.members.get(definition.block)?.length)) {
      report('有尺寸缺少可转换的原始标注块。');
    }
    if (isTable) report('DWG 表格保留为可编辑的线和文字块。');
    const attached = definition.vertices ?? (definition.attributes ?? []).map(id => geometry.attributes.get(id))
      .filter(item => item?.header.owner === handle);
    if (attached.length < (definition.attributes?.length ?? 0)) report('有块引用属性无法读取。');
    const outputType = isTable ? 'INSERT' : type;
    emit(0, outputType); emit(5, hex(handle));
    const reactors = hatchReactors.get(hex(handle));
    if (reactors) {
      emit(102, '{ACAD_REACTORS');
      for (const reactor of reactors) emit(330, reactor);
      emit(102, '}');
    }
    emit(330, hex(owner)); emit(100, 'AcDbEntity');
    emit(8, symbolName(header.layer, 'LAYER', '0'));
    if (header.lineType !== 0) emit(6, header.lineType === 3
      ? symbolName(header.lineTypeHandle, 'LTYPE', 'Continuous') : ['ByLayer', 'ByBlock', 'Continuous'][header.lineType]);
    const { color, rgb } = polylineHeader ?? header;
    if (color !== 256) emit(62, color);
    if (rgb !== undefined) emit(420, rgb);
    if (header.transparency !== undefined) emit(440, header.transparency);
    if (header.lineScale !== 1 && Number.isFinite(header.lineScale)) emit(48, header.lineScale);
    if (header.invisible) emit(60, 1);
    emit(100, subclasses[outputType]);
    if (type === 'VERTEX') emit(100, 'AcDb2dVertex');
    if (attached.length) emit(66, 1);
    if (needsBlock) emit(2, block ?? '');
    if (definition.style) emit(7, symbolName(definition.style, 'STYLE', 'Standard'));
    if (type === 'LEADER') emit(3, symbolName(definition.dimstyle, 'DIMSTYLE', 'Standard'));
    if (type === 'ARC') {
      emitAll(definition.groups.filter(([code]) => code !== 50 && code !== 51));
      emit(100, 'AcDbArc');
      emitAll(definition.groups.filter(([code]) => code === 50 || code === 51));
    } else if (type === 'TEXT') {
      emitAll(definition.groups.filter(([code]) => code !== 73));
      emit(100, 'AcDbText');
      emitAll(definition.groups.filter(([code]) => code === 73));
    } else if (type === 'ATTRIB' || type === 'ATTDEF') {
      emitAll(definition.groups);
      emit(100, type === 'ATTRIB' ? 'AcDbAttribute' : 'AcDbAttributeDefinition');
      emitAll(definition.attribute);
    } else if (definition.hook) {
      const { vertices, lastVertex, horizontal, hookDirection } = definition.hook;
      const style = new Map(symbols.get(definition.dimstyle)?.groups);
      const length = Math.hypot(...horizontal);
      const size = (style.get(40) || 1) * (style.get(41) ?? 0);
      if (length && size > 0) {
        const offset = (hookDirection ? 1 : -1) * size / length;
        const point = lastVertex.map((value, axis) => value + horizontal[axis] * offset);
        const beforeLast = definition.groups.findIndex(([code]) => code === 10) + (vertices - 1) * 3;
        emitAll(definition.groups.slice(0, beforeLast).map(pair => pair[0] === 76 ? [76, vertices + 1] : pair));
        emitAll(coordinates(10, point));
        emitAll(definition.groups.slice(beforeLast));
        emit(75, 1);
      } else emitAll(definition.groups);
    } else if (isDimension) {
      const values = new Map(definition.groups);
      const fields = codes => codes.forEach(code => { if (values.has(code)) emit(code, values.get(code)); });
      fields([280]);
      emit(2, block ?? '');
      fields([10, 20, 30, 11, 21, 31, 12, 22, 32, 70, 1, 53, 51, 210, 220, 230, 71, 72]);
      if (!definition.specific || values.get(41) !== 1) fields([41]);
      fields([42, 73, 74, 75]);
      emit(3, symbolName(definition.dimstyle, 'DIMSTYLE', 'Standard'));
      const rotated = definition.subclass === 'AcDbRotatedDimension';
      emit(100, rotated ? 'AcDbAlignedDimension' : definition.subclass);
      if (definition.specific) emitAll(definition.specific);
      else {
        fields([13, 23, 33, 14, 24, 34, 15, 25, 35, 16, 26, 36, 40]);
        fields([50, 52].filter(code => values.get(code)));
      }
      if (rotated) emit(100, definition.subclass);
    } else {
      emitAll(definition.groups);
    }
    if (attached.length) {
      for (const child of attached) entity(child, handle, type === 'POLYLINE' ? header : undefined);
      emitAll([[0, 'SEQEND'], [5, hex(definition.sequenceEnd ?? allocate())], [330, hex(handle)], [100, 'AcDbEntity'],
        [8, symbolName(header.layer, 'LAYER', '0')]]);
    }
    return true;
  }

  section('HEADER', () => {
    emit(9, '$ACADVER'); emit(1, 'AC1032');
    emit(9, '$DWGCODEPAGE'); emit(3, 'ANSI_1252');
    emit(9, '$HANDSEED'); emit(5, hex(nextHandle + 20 + blocks.length * 2 + geometry.attributes.size));
    emit(9, '$PSTYLEMODE'); emit(290, 1);
    if (units !== undefined) { emit(9, '$INSUNITS'); emit(70, units); }
  });
  if (wipeouts || arcDimensions || mleaders) section('CLASSES', () => {
    const emitClass = (type, subclass, application, flags, count, entity) =>
      emitAll([[0,'CLASS'], [1,type], [2,subclass], [3,application], [90,flags], [91,count], [280,0], [281,entity]]);
    if (wipeouts) {
      emitClass('WIPEOUT', 'AcDbWipeout', 'WipeOut', 2175, wipeouts, 1);
      emitClass('WIPEOUTVARIABLES', 'AcDbWipeoutVariables', 'WipeOut', 0, 1, 0);
    }
    if (arcDimensions) emitClass('ARC_DIMENSION', 'AcDbArcDimension', 'ObjectDBX Classes', 1025, arcDimensions, 1);
    if (mleaders) {
      emitClass('MULTILEADER', 'AcDbMLeader', 'ACDB_MLEADER_CLASS', 1025, mleaders, 1);
      emitClass('MLEADERSTYLE', 'AcDbMLeaderStyle', 'ACDB_MLEADERSTYLE_CLASS', 4095, mleaderStyles.size, 0);
    }
  });
  section('TABLES', () => {
    for (const table of ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE', 'BLOCK_RECORD']) {
      const records = table === 'BLOCK_RECORD' ? blocks : [...symbols].filter(([, item]) => item.table === table);
      const tableHandle = allocate();
      emit(0, 'TABLE'); emit(2, table); emit(5, hex(tableHandle)); emit(330, '0'); emit(100, 'AcDbSymbolTable'); emit(70, records.length);
      if (table === 'DIMSTYLE') { emit(100, 'AcDbDimStyleTable'); emit(71, 0); }
      for (const [id, item] of records) {
        emit(0, table); emit(table === 'DIMSTYLE' ? 105 : 5, hex(id)); emit(330, hex(tableHandle)); emit(100, 'AcDbSymbolTableRecord');
        emit(100, symbolSubclasses[table]); emit(2, item.name);
        if (table === 'BLOCK_RECORD') { emit(70, 0); emit(280, 1); emit(281, 0); }
        else emitAll(item.groups);
        if (table === 'LAYER') {
          const linetype = symbolName(item.linetype, 'LTYPE', 'Continuous');
          const inherited = /^(bylayer|byblock)$/i.test(linetype);
          if (inherited) report('有图层线型为继承值，已按 Continuous 输出。');
          emit(6, inherited ? 'Continuous' : linetype);
          emit(370, -3);
          emit(390, hex(normalPlotStyle));
        }
        if (table === 'DIMSTYLE') {
          for (const [code, handle] of item.styleRefs ?? []) {
            const expected = code === 340 ? 'STYLE' : code <= 344 ? 'BLOCK_RECORD' : 'LTYPE';
            if (symbolName(handle, expected)) emit(code, hex(handle));
          }
        }
      }
      emit(0, 'ENDTAB');
    }
  });
  section('BLOCKS', () => {
    for (const [handle, item] of blocks) {
      emit(0, 'BLOCK'); emit(5, hex(allocate())); emit(330, hex(handle)); emit(100, 'AcDbEntity'); emit(8, '0');
      emit(100, 'AcDbBlockBegin'); emit(2, item.name); emit(70, item.flags || 0);
      emitAll(coordinates(10, item.base)); emit(3, item.name); emit(1, '');
      if (handle !== model && handle !== paper) for (const child of geometry.members.get(handle) ?? []) entity(child, handle);
      emit(0, 'ENDBLK'); emit(5, hex(allocate())); emit(330, hex(handle)); emit(100, 'AcDbEntity'); emit(8, '0'); emit(100, 'AcDbBlockEnd');
    }
  });
  section('ENTITIES', () => {
    let emitted = false;
    for (const item of geometry.top) if (entity(item, model)) emitted = true;
    if (!emitted && !emptyModel) throw new Error('转换结果没有模型空间图元。');
  });
  section('OBJECTS', () => {
    emitAll([[0, 'DICTIONARY'], [5, hex(namedObjects)], [330, '0'], [100, 'AcDbDictionary'], [281, 1],
      [3, 'ACAD_PLOTSTYLENAME'], [350, hex(plotStyles)]]);
    if (mleaderDictionary) emitAll([[3, 'ACAD_MLEADERSTYLE'], [350, hex(mleaderDictionary)]]);
    if (wipeoutVariables) {
      emitAll([[3, 'ACAD_WIPEOUT_VARS'], [350, hex(wipeoutVariables)], [0, 'WIPEOUTVARIABLES'],
        [5, hex(wipeoutVariables)], [330, hex(namedObjects)], [100, 'AcDbWipeoutVariables'], [70, geometry.wipeoutFrame ?? 1]]);
    }
    emitAll([[0, 'ACDBDICTIONARYWDFLT'], [5, hex(plotStyles)], [330, hex(namedObjects)], [100, 'AcDbDictionary'],
      [281, 1], [3, 'Normal'], [350, hex(normalPlotStyle)], [100, 'AcDbDictionaryWithDefault'], [340, hex(normalPlotStyle)]]);
    emitAll([[0, 'ACDBPLACEHOLDER'], [5, hex(normalPlotStyle)], [330, hex(plotStyles)]]);
    if (mleaderDictionary) {
      emitAll([[0, 'DICTIONARY'], [5, hex(mleaderDictionary)], [330, hex(namedObjects)], [100, 'AcDbDictionary'], [281, 1]]);
      const used = new Set();
      for (const [handle, style] of mleaderStyles) {
        let name = style.name || 'Standard';
        if (used.has(normalized(name))) name += '_' + hex(handle);
        while (used.has(normalized(name))) name += '_';
        used.add(normalized(name));
        emit(3, name); emit(350, hex(handle));
      }
      for (const [handle, style] of mleaderStyles) {
        emitAll([[0, 'MLEADERSTYLE'], [5, hex(handle)], [330, hex(mleaderDictionary)], [100, 'AcDbMLeaderStyle']]);
        emitAll(style.groups);
      }
    }
  });
  emit(0, 'EOF');
  flush();
  return keepChunks ? { dxfChunks: chunks } : { dxf: Buffer.concat(chunks, size) };
}

export function convertAc1032(bytes, options) {
  return convertPagedDwg(bytes, 'AC1032', options);
}

export function convertAc102x(bytes, version, options) {
  if (!['AC1021', 'AC1024', 'AC1027'].includes(version)) throw new Error('此入口读取 AC1021、AC1024 或 AC1027。');
  return convertPagedDwg(bytes, version, options);
}

export function convertAc1018(bytes, options) {
  return convertPagedDwg(bytes, 'AC1018', options);
}

export function convertAc1021ModelPreview(bytes) {
  return convertPagedDwg(bytes, 'AC1021', { modelOnly: true });
}

function convertPagedDwg(bytes, version, options = {}) {
  const sections = version === 'AC1021' ? readAc1021Sections(bytes) : readAc1032Sections(bytes, version);
  const objects = sections.get('AcDb:AcDbObjects');
  const index = objectIndex(sections.get('AcDb:Handles'), objects.length);
  const maintenance = bytes[11];
  const revision = Number(version.slice(2));
  const { decoder, unknownCodepage } = revision === 1018 ? readDwgCodepage(bytes) : { decoder: null, unknownCodepage: null };
  const classes = readClasses(sections.get('AcDb:Classes'), maintenance, revision, decoder);
  const header = sections.get('AcDb:Header');
  return convertDrawing((offset, handle) => openObject(objects, offset, handle, decoder, revision), index, classes,
    () => revision === 1018 ? readAc1018Units(header, decoder) : readDrawingUnits(header, revision, maintenance),
    codepageWarning(unknownCodepage),
    { ...options, allowEmpty: revision === 1018,
      modelOnly: options.modelOnly || (options.preview && (objects.length > 32 * MiB || index.size > 250000)) });
}

function codepageWarning(codepage) {
  return codepage === null ? '' : `源图代码页 ${codepage} 暂按 Windows-1252 读取，请核对文字。`;
}

export function convertAc1015(bytes, options = {}) {
  const { index, decoder, classes, variables, unknownCodepage } = readAc1015(bytes);
  return convertDrawing((offset, handle) => openObject(bytes, offset, handle, decoder), index, classes,
    () => readAc1015Units(variables, decoder),
    codepageWarning(unknownCodepage),
    { ...options, modelOnly: options.preview && index.size > 250000 });
}

function convertDrawing(open, index, classes, drawingUnits, encodingWarning, { modelOnly, keepChunks, allowEmpty } = {}) {
  const warnings = new Map();
  const report = (warning, count = 1) => warnings.set(warning, (warnings.get(warning) ?? 0) + count);
  if (encodingWarning) report(encodingWarning);
  let units;
  try { units = drawingUnits?.(); }
  catch { report('源文件单位设置未恢复，坐标按原值保留。'); }
  const symbols = new Map();
  let maxHandle = 0;
  for (const [handle, offset] of index) {
    maxHandle = Math.max(handle, maxHandle);
    try {
      const object = open(offset, handle);
      if (object.version === 1018 && classes.get(object.type)?.name === 'MLEADERSTYLE') {
        symbols.set(handle, { ...readAc1018MLeaderStyle(object), table: 'MLEADERSTYLE' });
        continue;
      }
      if (object.version === 1018 && classes.get(object.type)?.name === 'FIELD') {
        report('图纸含动态字段，文字沿用源文件保存的值。');
      }
      const table = symbolTypes.get(object.type);
      if (!table) continue;
      const symbol = readSymbol(object);
      if (!symbol) continue;
      if ((symbol.groups ?? []).some(([, value]) => typeof value === 'number' && !Number.isFinite(value)) ||
          symbol.base?.some(value => !Number.isFinite(value))) throw new Error('Invalid symbol data');
      if (symbol.complex) report('复杂线型保留线段图案，文字或形状部分已简化。');
      if (symbol.defaultTolerance) report('有源标注样式的公差精度为 -1，导出使用 DXF 默认精度。');
      symbols.set(handle, { ...symbol, table });
    } catch {
      report('部分 DWG 符号表或对象记录无法读取。');
    }
  }
  ensureUnique(symbols, report);
  const selected = modelOnly ? reachableModelObjects(open, index, classes, symbols) : undefined;
  const geometry = modelEntities(open, index, classes, symbols, report, selected);
  const emptyModel = Boolean(allowEmpty && geometry.emptyModel);
  if (!geometry.top.length && !emptyModel) throw new Error('此 DWG 没有可转换的二维模型空间图元。');
  if (emptyModel) report('模型空间为空，已读取图层和样式。');
  const result = serialize(symbols, geometry, units, maxHandle, report, keepChunks, emptyModel);
  return { ...result, warnings: [...warnings], counts: geometry.counts, detached: geometry.detached, modelOnly, emptyModel };
}
