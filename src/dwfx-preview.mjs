import { posix } from 'node:path';
import { openCadPackage } from './dwfx-zip.mjs';
import { dwfxLimits } from './cad-budget.mjs';

const dwfxRelation = 'http://schemas.autodesk.com/dwfx/2007/relationships/documentsequence';
const xps = 'http://schemas.microsoft.com/xps/2005/06';
const openXps = 'http://schemas.openxps.org/oxps/v1.0';
const caps = new Map([['Flat', 'butt'], ['Round', 'round'], ['Square', 'square']]);
const joins = new Map([['Miter', 'miter'], ['Round', 'round'], ['Bevel', 'bevel']]);

function check(valid, message = 'DWFx 的页面 XML 无效或超出读取容量。') {
  if (!valid) throw new Error(message);
}

function xmlValue(value) {
  return value.replace(/&([^;\s&]{1,20});|&/g, (match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16)
      : /^#\d+$/.test(entity) ? Number(entity.slice(1)) : 0;
    check(code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff));
    return String.fromCodePoint(code);
  });
}

function attributes(source) {
  const output = Object.create(null);
  const pattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  const body = source.trimEnd();
  while (pattern.lastIndex < body.length) {
    const match = pattern.exec(body);
    check(match && !Object.hasOwn(output, match[1]));
    output[match[1]] = xmlValue(match[2] ?? match[3]);
  }
  return output;
}

function readXml(bytes, expected) {
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const elements = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y;
  const space = /\s*/y;
  const stack = [];
  let offset = 0;
  let root;
  let count = 0;
  while (offset < text.length) {
    space.lastIndex = offset;
    space.exec(text);
    offset = space.lastIndex;
    if (offset === text.length) break;
    const comment = text.startsWith('<!--', offset);
    if (comment || (!root && text.startsWith('<?xml ', offset))) {
      const marker = comment ? '-->' : '?>';
      const end = text.indexOf(marker, offset + (comment ? 4 : 6));
      check(end >= 0);
      offset = end + marker.length;
      continue;
    }
    elements.lastIndex = offset;
    const match = elements.exec(text);
    check(match);
    offset = elements.lastIndex;
    const [, close, name, body] = match;
    if (close) {
      check(!body.trim() && stack.pop()?.name === name);
      continue;
    }
    check(++count <= dwfxLimits.elementsPerPart && stack.length < 48);
    const empty = body.endsWith('/');
    const node = { name, tag: name.split(':').at(-1), props: attributes(empty ? body.slice(0, -1) : body), children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else { check(!root); root = node; }
    if (!empty) stack.push(node);
  }
  check(!stack.length && root?.tag === expected);
  return root;
}

function partPath(reference, parent) {
  check(typeof reference === 'string' && /^[\w.%/ ()-]{1,1024}$/.test(reference), 'DWFx 页面引用无效。');
  const path = posix.normalize(reference.startsWith('/') ? reference.slice(1) : posix.join(posix.dirname(parent), reference));
  check(path !== '..' && !path.startsWith('../'), 'DWFx 页面引用越界。');
  return path;
}

function geometry(value, fillRule) {
  if (!value || value.length > 1024 * 1024) return null;
  let d = value.trim();
  const prefix = d.match(/^F([01])\s*/);
  if (prefix) d = d.slice(prefix[0].length);
  return /^[Mm][MmLlHhVvCcSsQqTtAaZz\dEe,.+\-\s]*$/.test(d)
    ? { d, rule: prefix ? (prefix[1] === '1' ? 'nonzero' : 'evenodd') : fillRule === 'Nonzero' ? 'nonzero' : 'evenodd' }
    : null;
}

function numbers(value) {
  const terms = value.trim().split(/[\s,]+/);
  if (terms.some(term => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(term))) return null;
  const values = terms.map(Number);
  return values.every(number => Math.abs(number) <= 1e8) ? values : null;
}

function paint(value) {
  if (value === undefined) return 'none';
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  return /^#[0-9a-f]{8}$/i.test(value) ? `#${value.slice(3)}${value.slice(1, 3)}` : null;
}

function brushColor(brush, value) {
  if (brush === undefined) return paint(value);
  if (!brush?.Color || brush.Transform !== undefined) return null;
  const color = paint(brush.Color);
  const opacity = Number(brush.Opacity ?? 1);
  if (!color || !(opacity >= 0 && opacity <= 1)) return null;
  const alpha = color.length === 9 ? parseInt(color.slice(7), 16) : 255;
  return color.slice(0, 7) + Math.round(alpha * opacity).toString(16).padStart(2, '0');
}

function property(node, name, tag, consumed) {
  const matches = node.children.filter(child => child.tag === node.tag + '.' + name);
  for (const match of matches) consumed.add(match);
  if (!matches.length) return undefined;
  if (matches.length !== 1 || node.props[name] !== undefined || matches[0].children.length !== 1) return null;
  const [value] = matches[0].children;
  return value.tag === tag && !value.children.length ? value.props : null;
}

function drawNodes(nodes, report) {
  const shapes = [];
  for (const node of nodes) {
    const p = node.props;
    if (node.tag === 'Canvas.Resources' || node.tag === 'FixedPage.Resources') continue;
    if (node.tag !== 'Canvas' && node.tag !== 'Path') {
      report('有 DWFx 对象暂未绘制，例如嵌入字体、图片或扩展对象。');
      continue;
    }
    const consumed = new Set();
    const transform = property(node, 'RenderTransform', 'MatrixTransform', consumed);
    const clipping = property(node, 'Clip', 'PathGeometry', consumed);
    const matrix = transform === undefined && p.RenderTransform === undefined ? null : numbers(transform?.Matrix ?? p.RenderTransform ?? '');
    const clip = clipping === undefined ? geometry(p.Clip) : geometry(clipping?.Figures, clipping?.FillRule);
    const opacity = p.Opacity === undefined ? 1 : Number(p.Opacity);
    if (((transform !== undefined || p.RenderTransform !== undefined) && (transform === null || matrix?.length !== 6)) ||
        ((clipping !== undefined || p.Clip !== undefined) && (!clip || clipping?.Transform !== undefined)) ||
        !(opacity >= 0 && opacity <= 1) || p.OpacityMask !== undefined ||
        node.children.some(child => child.tag === node.tag + '.OpacityMask')) {
      report('有 DWFx 对象使用暂不支持的变换、裁剪或透明遮罩。');
      continue;
    }
    if (node.tag === 'Canvas') {
      shapes.push({ matrix, clip, opacity, children: drawNodes(node.children.filter(child => !consumed.has(child)), report) });
      continue;
    }
    const data = property(node, 'Data', 'PathGeometry', consumed);
    const path = data === undefined ? geometry(p.Data) : geometry(data?.Figures, data?.FillRule);
    const fillBrush = property(node, 'Fill', 'SolidColorBrush', consumed);
    const strokeBrush = property(node, 'Stroke', 'SolidColorBrush', consumed);
    const fill = brushColor(fillBrush, p.Fill);
    const stroke = brushColor(strokeBrush, p.Stroke);
    const width = p.StrokeThickness === undefined ? 1 : Number(p.StrokeThickness);
    const dash = p.StrokeDashArray === undefined ? [] : numbers(p.StrokeDashArray);
    const dashOffset = p.StrokeDashOffset === undefined ? 0 : Number(p.StrokeDashOffset);
    if (!path || data?.Transform !== undefined || node.children.some(child => !consumed.has(child)) || !fill || !stroke || !(width >= 0 && width <= 10000) ||
        !dash || dash.length > 64 || dash.some(value => value < 0) || !(Math.abs(dashOffset) <= 1e8)) {
      report('有 DWFx 路径使用暂不支持的几何或画笔。');
      continue;
    }
    const cap = caps.get(p.StrokeStartLineCap) ?? 'butt';
    const join = joins.get(p.StrokeLineJoin) ?? 'miter';
    if (p.StrokeEndLineCap && p.StrokeEndLineCap !== p.StrokeStartLineCap) report('有 DWFx 路径的两端线帽按起点样式显示。');
    shapes.push({ matrix, clip, opacity, path, fill, stroke, width, cap, join, dash: dash.map(value => value * width), dashOffset: dashOffset * width });
  }
  return shapes;
}

export function readDwfxPreview(bytes, zip = openCadPackage(bytes)) {
  if (!zip?.has('_rels/.rels') || !zip.has('[Content_Types].xml')) return null;
  const rels = readXml(zip.read('_rels/.rels'), 'Relationships').children.filter(node => node.tag === 'Relationship');
  if (!rels.some(node => node.props.Type === dwfxRelation)) return null;
  const fixed = rels.find(node => [xps, openXps].some(ns => node.props.Type === `${ns}/fixedrepresentation`) && node.props.TargetMode !== 'External');
  check(fixed, '此 DWFx 未保存二维固定页面。');
  const sequencePath = partPath(fixed.props.Target, 'root');
  const sequence = readXml(zip.read(sequencePath), 'FixedDocumentSequence');
  const issues = new Map();
  const report = message => issues.set(message, (issues.get(message) ?? 0) + 1);
  const items = [];
  const layers = [];
  let offset = 0;
  for (const document of sequence.children.filter(node => node.tag === 'DocumentReference')) {
    const docPath = partPath(document.props.Source, sequencePath);
    const pages = readXml(zip.read(docPath), 'FixedDocument');
    for (const entry of pages.children.filter(node => node.tag === 'PageContent')) {
      check(items.length < dwfxLimits.pages, 'DWFx 页面数量超出本版预览容量。');
      const page = readXml(zip.read(partPath(entry.props.Source, docPath)), 'FixedPage');
      const width = Number(page.props.Width), height = Number(page.props.Height);
      check(width > 0 && height > 0 && width <= 20000 && height <= 20000);
      const id = String(items.length + 1);
      const shapes = drawNodes(page.children, report);
      items.push({ kind: 'fixedPage', width, height, offset, shapes, layerIds: [id] });
      layers.push({ id, name: `第 ${id} 页`, visible: true, count: 1, color: '#dddddd' });
      offset += height + 24;
    }
  }
  check(items.length, '此 DWFx 未保存二维固定页面。');
  return { format: 'DWFx', items, layers, issues: [...issues] };
}
