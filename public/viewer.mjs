import { formatHints, uploadExtensions, uploadHint, projectionHiddenLayers, projectionTriangleLimit } from './cad-limits.mjs';
import { MeshViewer, partColor } from './mesh-viewer.mjs';
import { drawingUnits } from './cad-measure.mjs';
import { createHostTools } from './host-tools.mjs';
import { createMeasureTools } from './measure-tools.mjs';
import { createDrawingBuffer } from './drawing-buffer.mjs';
const byId = id => document.getElementById(id);
const fileInput = byId('file');
fileInput.accept = uploadExtensions.map(extension => '.' + extension).join(',');
byId('empty-note').textContent = uploadHint;
const drawing = byId('drawing');
const viewport = byId('viewport');
const world = byId('world');
const motionCanvas = byId('drawing-motion');
const drawingBuffer = createDrawingBuffer(motionCanvas, viewport, world);
const message = byId('message');
const empty = byId('empty');
const layerList = byId('layers');
const controls = ['fit', 'in', 'out'].map(byId);
const download = byId('download');
const downloadSheet = byId('download-sheet');
const sheetFormat = byId('sheet-format');
const sheetView = byId('sheet-view');
const blockView = byId('block-view');
const partConfiguration = byId('part-configuration');
const meshCanvas = byId('mesh-canvas');
const meshView = byId('mesh-view');
const meshTree = byId('mesh-tree');
const meshSpread = byId('mesh-spread');
const makeProjection = byId('make-projection');
const backToMesh = byId('back-to-mesh');
const downloadProjection = byId('download-projection');
const projectionFormat = byId('projection-format');
const projectionExport = byId('projection-export');
const projectionHidden = byId('projection-hidden');
const projectionFront = byId('projection-front');
const diagnostics = byId('preview-diagnostics');
const diagnose = byId('run-diagnostics');
const diagnosticAnswer = byId('diagnostic-answer');
const nativeSolidWorks = byId('native-solidworks');
const state = { items: [], layers: [], view: null, request: null };
const bufferedPanThreshold = 10_000;
let solidWorksEnabled = false;
fetch('./api/solidworks').then(response => response.json()).then(({ enabled }) => {
  solidWorksEnabled = enabled === true;
  nativeSolidWorks.hidden = !solidWorksEnabled || !state.solidWorksSource;
}).catch(() => {});
let diagnosticEnabled = false, diagnosticContext, diagnosticRequest;
fetch('./api/preview-diagnostics').then(response => response.json()).then(({ enabled }) => {
  diagnosticEnabled = enabled === true;
  diagnostics.hidden = !diagnosticEnabled || !diagnosticContext;
}).catch(() => {});
function setDiagnosticContext(filename, status) {
  diagnosticRequest?.abort();
  diagnosticRequest = undefined;
  const format = filename.split('.').at(-1)?.toLowerCase();
  diagnosticContext = status && uploadExtensions.includes(format) ? { format, status } : undefined;
  diagnostics.hidden = !diagnosticEnabled || !diagnosticContext;
  diagnose.disabled = false;
  diagnosticAnswer.textContent = '';
}
diagnose.addEventListener('click', async () => {
  if (!diagnosticContext || diagnosticRequest) return;
  const request = new AbortController();
  diagnosticRequest = request;
  diagnose.disabled = true;
  diagnosticAnswer.textContent = '正在请求诊断…';
  try {
    const response = await fetch('./api/preview-diagnostics?' + new URLSearchParams(diagnosticContext),
      { method: 'POST', signal: request.signal });
    const result = await response.json();
    if (diagnosticRequest === request) diagnosticAnswer.textContent = result.text || result.error || '未收到诊断结果。';
  } catch {
    if (diagnosticRequest === request) diagnosticAnswer.textContent = '诊断请求未完成。';
  } finally {
    if (diagnosticRequest === request) {
      diagnosticRequest = undefined;
      diagnose.disabled = false;
    }
  }
});
let meshViewer;
const measurement = createMeasureTools(viewport, drawingMatrix, () => state.items, () => meshViewer);
const measure = document.createElement('canvas').getContext('2d');
measure.font = '100px "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif';
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

const bdycSource = byId('bdyc-source');
const hostTools = createHostTools();
const openBdyc = byId('open-bdyc');
fetch('./api/bdyc-file').then(response => response.json()).then(({ login, embedded }) => {
  if (login) {
    byId('bdyc-login').href = login;
    openBdyc.hidden = false;
  }
  if (embedded) {
    hostTools.enable();
    diagnose.textContent = 'AI 辅助排查';
    byId('host-home').hidden = false;
    byId('host-home').target = '_top';
    byId('host-uploads').hidden = false;
    byId('host-uploads').target = '_top';
    byId('bdyc-login').textContent = '返回账号登录';
  }
  const current = new URLSearchParams(location.search);
  const path = current.get('path'), source = current.get('source');
  const filename = current.get('name') || path?.replaceAll('\\', '/').split('/').at(-1);
  if (embedded && (path || source)) {
    byId('host-download').href = path ? '/download?' + new URLSearchParams({path}) : './api/bdyc-file?' + new URLSearchParams({source, name:filename || ''});
    // Task downloads must pass through the host's original permission-checked route.
    if (source && /^\/drawing\/api\//.test(source)) byId('host-download').href = source;
    byId('host-download').hidden = false;
    if (path) {
      byId('host-legacy').href = '/view?' + new URLSearchParams({path, viewer:'legacy'});
      byId('host-legacy').hidden = false;
    }
  }
  if (login && filename && (path || embedded && source)) {
    const params = new URLSearchParams(path ? { path } : { source, name: filename });
    loadBdycDrawing(filename, params);
  }
}).catch(() => {});
function loadBdycDrawing(filename, params) {
  const extension = filename.split('.').at(-1).toLowerCase();
  if (!uploadExtensions.includes(extension)) return setMessage('此格式请使用 BDYC 原预览或下载原件。', true);
  openDrawing(filename, async signal => {
    const response = await fetch('./api/bdyc-file?' + params,
      { signal, headers: { 'X-XYCAD-BDYC': '1' }, cache: 'no-store' });
    if (!response.ok) throw new Error((await response.json()).error || '无法读取 BDYC 图纸。');
    return new File([await response.blob()], filename);
  }, '', extension, false, undefined, Object.fromEntries(params));
}
openBdyc.addEventListener('click', () => {
  bdycSource.hidden = !bdycSource.hidden;
  if (!bdycSource.hidden) byId('bdyc-path').focus();
});
bdycSource.addEventListener('submit', event => {
  event.preventDefault();
  const path = byId('bdyc-path').value.trim().replaceAll('\\', '/');
  const filename = path.split('/').at(-1);
  loadBdycDrawing(filename, new URLSearchParams({ path }));
});

function svg(tag, attributes = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function wrapText(paragraph, maxWidth, fontSize) {
  if (!maxWidth || measure.measureText(paragraph).width / 100 * fontSize <= maxWidth) return [paragraph];
  const limit = maxWidth / fontSize * 100;
  const rows = [];
  let row = '';
  for (const { segment } of segmenter.segment(paragraph)) {
    if (row && measure.measureText(row + segment).width > limit) {
      rows.push(row.trimEnd());
      row = '';
    }
    if (!row && !segment.trim()) continue;
    if (measure.measureText(segment).width <= limit) {
      row += segment;
    } else {
      for (const char of segment) {
        if (row && measure.measureText(row + char).width > limit) {
          rows.push(row);
          row = '';
        }
        row += char;
      }
    }
  }
  if (row || !rows.length) rows.push(row);
  return rows;
}

function drawText(item, transform) {
  const { origin, color, height, angle, anchor, vertical, widthScale = 1, heightScale = 1, oblique = 0, spacing = 1 } = item;
  let fontSize = height / 0.73;
  if (item.scaleHeight && item.length) {
    const referenceWidth = measure.measureText(item.content).width * Math.abs(widthScale) / 100;
    if (referenceWidth > 0) fontSize = item.length / referenceWidth;
  }
  const rows = item.content.split('\n').flatMap(row => wrapText(row, item.maxWidth, fontSize));
  const lineHeight = fontSize * 1.15 * spacing;
  const capHeight = fontSize * 0.73;
  const blockHeight = lineHeight * (rows.length - 1) + capHeight;
  const y = { top: capHeight, middle: capHeight - blockHeight / 2, bottom: capHeight - blockHeight, baseline: 0 }[vertical];
  const local = `translate(${origin.join(' ')}) rotate(${angle * 180 / Math.PI}) scale(${widthScale} ${-heightScale}) skewX(${-oblique})`;
  const text = svg('text', { fill: color, transform: `${transform} ${local}`, 'text-anchor': anchor, 'font-size': fontSize });
  if (item.length > 0 && rows.length === 1) {
    text.setAttribute('textLength', item.length / Math.abs(widthScale));
    text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
  }
  rows.forEach((row, index) => {
    const span = svg('tspan', { x: 0, y: y + index * lineHeight });
    span.textContent = row;
    text.append(span);
  });
  return text;
}

let nextClipId = 0;

function drawFixedPage({ width, height, offset, shapes }) {
  const page = svg('g', { transform: `translate(0 ${-offset}) scale(1 -1)` });
  const sheet = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, overflow: 'hidden' });
  const defs = svg('defs');
  sheet.append(defs, svg('rect', { width, height, fill: '#ffffff' }));
  function draw(parent, nodes) {
    for (const node of nodes) {
      const transform = node.matrix ? { transform: `matrix(${node.matrix.join(' ')})` } : {};
      const group = svg('g', { ...transform, opacity: node.opacity });
      if (node.clip) {
        const id = `xycad-plot-clip-${++nextClipId}`;
        const clip = svg('clipPath', { id });
        clip.append(svg('path', { d: node.clip.d, 'clip-rule': node.clip.rule }));
        defs.append(clip);
        group.setAttribute('clip-path', `url(#${id})`);
      }
      if (node.children) draw(group, node.children);
      else {
        const path = svg('path', { d: node.path.d, 'fill-rule': node.path.rule, fill: node.fill,
          stroke: node.stroke, 'stroke-width': node.width, 'stroke-linecap': node.cap, 'stroke-linejoin': node.join });
        if (node.dash.length) {
          path.setAttribute('stroke-dasharray', node.dash.join(' '));
          path.setAttribute('stroke-dashoffset', node.dashOffset);
        }
        group.append(path);
      }
      parent.append(group);
    }
  }
  draw(sheet, shapes);
  page.append(sheet);
  return page;
}

function drawItem(item) {
  if (item.kind === 'fixedPage') return drawFixedPage(item);
  if (item.kind === 'image') {
    const { width, height, mime, base64 } = item;
    return svg('image', { width, height, y: -height, transform: 'scale(1 -1)', href: `data:${mime};base64,${base64}` });
  }
  const transform = `matrix(${item.matrix.join(' ')})`;
  const { kind, color } = item;
  if (kind === 'text') return drawText(item, transform);
  const stroke = { transform, fill: 'none', stroke: color, 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke' };
  if (item.dash) stroke['stroke-dasharray'] = '6 4';
  switch (kind) {
    case 'line':
      return svg('line', { ...stroke, x1: item.start[0], y1: item.start[1], x2: item.end[0], y2: item.end[1] });
    case 'circle':
      return svg('circle', { ...stroke, cx: item.center[0], cy: item.center[1], r: item.radius });
    case 'ellipse':
      return svg('ellipse', { ...stroke, rx: item.radius, ry: item.minor });
    case 'path':
      return svg('path', { ...stroke, d: item.path });
    case 'widePath':
      return svg('path', { transform, d: item.path, fill: 'none', stroke: color, 'stroke-width': item.width });
    case 'filledPath':
      return svg('path', { transform, d: item.path, fill: color, 'fill-opacity': item.opacity, 'fill-rule': 'evenodd' });
    case 'wipeout': {
      const mask = svg('g', { transform, 'data-wipeout': '' });
      mask.append(svg('path', { d: item.path, class: 'wipeout-fill', 'fill-rule': 'evenodd' }));
      if (item.frame) mask.append(svg('path', { ...stroke, transform: '', d: item.frame }));
      return mask;
    }
    case 'point': {
      const [x, y] = item.center;
      return svg('line', { ...stroke, x1: x, y1: y, x2: x, y2: y, 'stroke-width': 3, 'stroke-linecap': 'round' });
    }
    case 'fill':
      return svg('polygon', { transform, fill: color, points: item.vertices.map(vertex => vertex.join(',')).join(' '),
        ...(item.solidFace && { 'shape-rendering': 'crispEdges' }) });
    case 'outline':
      return svg('polygon', { ...stroke, points: item.vertices.map(vertex => vertex.join(',')).join(' ') });
  }
}

function setMessage(text, error = false) {
  message.hidden = !text;
  message.classList.toggle('error', error);
  message.textContent = text;
}

let wheelFrame, settleTimer;

function drawingMatrix() {
  if (motionCanvas.hidden) return world.getScreenCTM();
  const { x, y, width, height } = state.view;
  const rect = viewport.getBoundingClientRect();
  const sx = rect.width / width, sy = rect.height / height;
  return new DOMMatrix([sx, 0, 0, -sy, rect.left - x * sx, rect.top - y * sy]);
}

function paintVector(panRect) {
  const { x, y, width, height } = state.view;
  const painted = state.paintView;
  if (state.bufferedPan && panRect && painted?.width === width && painted.height === height &&
      Math.abs(x - painted.x) <= width / 2 && Math.abs(y - painted.y) <= height / 2) {
    // Move the already painted SVG while the visible area stays inside its margins.
    const dx = (painted.x - x) * panRect.width / width;
    const dy = (painted.y - y) * panRect.height / height;
    drawing.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
  } else {
    state.paintView = state.view;
    drawing.style.transform = '';
    drawing.setAttribute('viewBox', state.bufferedPan
      ? `${x - width / 2} ${y - height / 2} ${width * 2} ${height * 2}`
      : `${x} ${y} ${width} ${height}`);
  }
}

function paintMotion(panRect) {
  drawingBuffer.cancelDetail();
  if (!state.bufferedPan || !drawingBuffer.draw(state.view)) paintVector(panRect);
  measurement.redraw();
}

function clearMotion() {
  clearTimeout(settleTimer);
  if (wheelFrame !== undefined) cancelAnimationFrame(wheelFrame);
  wheelFrame = undefined;
  motionCanvas.hidden = true;
}

function finishMotion() {
  clearMotion();
  if (!state.view || state.mesh) return;
  paintVector();
  measurement.redraw();
  if (state.bufferedPan) drawingBuffer.prepareDetail(state.view);
}

function settleMotion() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (!drag) finishMotion();
  }, 180);
}

function setView(x, y, width, height) {
  state.view = { x, y, width, height };
  finishMotion();
}

function fittedView() {
  const { width: w, height: h } = viewport.getBoundingClientRect();
  if (!w || !h) return;
  const box = world.getBBox();
  const ratio = w / h;
  let padX = 0;
  let padY = 0;
  for (const { element, strokePadding } of state.items) {
    if (!strokePadding || element.classList.contains('layer-off')) continue;
    padX = Math.max(padX, strokePadding[0]);
    padY = Math.max(padY, strokePadding[1]);
  }
  const height = Math.max(box.height + 2 * padY, (box.width + 2 * padX) / ratio, 1e-5) * 1.16;
  const width = height * ratio;
  return { x: box.x + box.width / 2 - width / 2, y: -(box.y + box.height / 2) - height / 2, width, height };
}

function fit() {
  if (state.mesh) return meshViewer.fit();
  if (!state.visibleCount) return;
  const view = fittedView();
  if (!view) return;
  state.fitWidth = view.width;
  setView(view.x, view.y, view.width, view.height);
}

function zoom(factor, x = 0.5, y = 0.5, wheel = false) {
  if (state.mesh) return meshViewer.zoom(factor, x, y);
  if (!state.visibleCount || !state.view) return;
  const current = state.view;
  const width = Math.max(state.fitWidth * 1e-5, Math.min(state.fitWidth * 1e3, current.width * factor));
  const height = width * current.height / current.width;
  state.view = { x: current.x + (current.width - width) * x, y: current.y + (current.height - height) * y, width, height };
  if (!wheel) return finishMotion();
  if (wheelFrame === undefined) wheelFrame = requestAnimationFrame(() => {
    wheelFrame = undefined;
    if (state.view && !state.mesh) paintMotion();
  });
  settleMotion();
}

function updateLayers() {
  measurement.clearHover();
  const visible = new Set(state.layers.filter(layer => layer.checkbox.checked).map(layer => layer.id));
  let count = 0;
  for (const { element, layerIds } of state.items) {
    const show = layerIds.every(id => visible.has(id));
    element.classList.toggle('layer-off', !show);
    if (show) count++;
  }
  const needsFit = count && !state.view;
  state.visibleCount = count;
  const total = state.items.length;
  const visibilityKind = state.fixedPlot ? '页面' : '图层';
  empty.hidden = Boolean(count);
  byId('empty-title').textContent = total ? `当前${visibilityKind}无可见内容` : '未找到可预览的图元';
  byId('empty-note').textContent = total ? `请显示${visibilityKind}或恢复原始状态。` : '请查看下方预览提示，或打开另一份图纸。';
  byId('visible-count').textContent = state.raster ? '内嵌图' : `${count} / ${total} ${state.fixedPlot ? '页' : '项'}可见`;
  controls.forEach(button => { button.disabled = !count; });
  if (!projectionExport.hidden) {
    const hidden = state.layers.filter(layer => projectionHiddenLayers.includes(layer.name));
    const checked = hidden.filter(layer => layer.checkbox.checked).length;
    projectionHidden.disabled = !hidden.length;
    projectionHidden.checked = checked > 0;
    projectionHidden.indeterminate = checked > 0 && checked < hidden.length;
  }
  if (needsFit) fit();
  if (state.bufferedPan) {
    if (!motionCanvas.hidden) finishMotion();
    drawingBuffer.reset(count ? (needsFit ? state.view : fittedView()) : null);
  }
}

function makeLayerRow(layer) {
  const row = document.createElement('li');
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = layer.visible;
  checkbox.addEventListener('change', updateLayers);
  const chip = svg('svg', { width: 11, height: 11, viewBox: '0 0 11 11', 'aria-hidden': 'true' });
  chip.append(svg('rect', { width: 11, height: 11, rx: 2, fill: layer.color }));
  const name = document.createElement('span');
  name.className = 'layer-name';
  name.textContent = layer.name;
  const count = document.createElement('span');
  count.className = 'layer-total';
  count.setAttribute('aria-hidden', 'true');
  count.textContent = layer.count;
  label.append(checkbox, chip, name, count);
  row.append(label);
  return { ...layer, checkbox, row };
}

function updateSheetControls(scene, index = 0) {
  const sheets = scene?.sheets;
  if (sheets && state.sheetScene !== scene) {
    sheetView.replaceChildren(...sheets.map(({ name, vector }, i) =>
      new Option((i + 1) + '. ' + name + (vector ? '' : '（暂无法矢量预览）'), String(i))));
  }
  state.sheetScene = sheets ? scene : null;
  byId('sheet-controls').hidden = !sheets;
  if (sheets) {
    sheetView.value = index;
    byId('previous-sheet').disabled = index === 0;
    byId('next-sheet').disabled = index === sheets.length - 1;
  }
}

function loadScene(scene, filename, page = 0, resumeMesh = false) {
  clearMotion();
  drawingBuffer.reset(null);
  makeProjection.hidden = !scene.mesh || scene.projectionAvailable === false ||
    (scene.mesh.asset && scene.mesh.count > projectionTriangleLimit);
  backToMesh.hidden = projectionExport.hidden = !scene.projection;
  projectionFront.hidden = !scene.mesh && !scene.projection;
  if (!resumeMesh) projectionFront.value = scene.projectionFront ?? 'ny';
  if (scene.mesh) {
    loadMesh(scene, filename, resumeMesh);
    measurement.configure({ dimension: 3, unit: scene.mesh.unit, scale: Math.max(...scene.mesh.size), origin: scene.mesh.origin });
    updateSheetControls(null);
    return;
  }
  const sheet = scene.sheets?.[page];
  const image = scene.image;
  const fragment = document.createDocumentFragment();
  const previewItems = image ? [{ ...image, kind: 'image', layerIds: [] }] : (sheet?.items ?? scene.items);
  const items = previewItems.map(item => {
    const element = drawItem(item);
    if (item.kind === 'image') element.addEventListener('error', () => {
      if (element.isConnected) setMessage(sheet ? '此图纸页的保存画面无法解码。' : '内嵌图无法解码。请提供矢量图纸。', true);
    });
    fragment.append(element);
    const strokePadding = item.kind === 'widePath' ? [
      // The SVG default miter limit bounds each join to four half-widths.
      2 * item.width * Math.hypot(item.matrix[0], item.matrix[2]),
      2 * item.width * Math.hypot(item.matrix[1], item.matrix[3]),
    ] : null;
    return { item, element, layerIds: item.layerIds, strokePadding };
  });
  const layers = (sheet?.layers ?? scene.layers).sort((a, b) => a.name.localeCompare(b.name, 'zh')).map(makeLayerRow);
  const rows = document.createDocumentFragment();
  for (const layer of layers) rows.append(layer.row);
  if (state.mesh) meshViewer.clear();
  showMesh(false, Boolean(scene.projection));
  layerList.replaceChildren(rows);
  world.replaceChildren(fragment);
  state.items = items;
  state.layers = layers;
  state.view = state.paintView = null;
  state.bufferedPan = items.length >= bufferedPanThreshold;
  drawing.classList.toggle('buffered-pan', state.bufferedPan);
  drawing.style.transform = '';
  state.raster = Boolean(image);
  state.fixedPlot = scene.format === 'DWFx';
  measurement.configure(items.length && !state.raster ? {
    dimension: 2, unit: state.fixedPlot ? 'mm' : drawingUnits[sheet?.units ?? scene.units],
    scale: state.fixedPlot ? 25.4 / 96 : 1, sheet: Boolean(sheet || state.fixedPlot), fixedPlot: state.fixedPlot,
  } : null);
  updateSheetControls(scene, page);
  byId('layers-title').textContent = sheet || state.fixedPlot ? '页面' : '图层';
  byId('layer-count').textContent = sheet ? (page + 1) + ' / ' + scene.sheets.length : layers.length;
  byId('layer-controls').hidden = !layers.length;
  const layersEmpty = byId('layers-empty');
  layersEmpty.hidden = Boolean(sheet || layers.length);
  layersEmpty.textContent = state.raster ? '内嵌图没有可切换的图层。' : '当前图纸没有可显示的图层。';
  byId('file-name').textContent = scene.projectionPart ? `${filename} · ${scene.projectionPart.label}` : filename;
  const dwgMode = state.raster ? '内嵌图' : scene.previewMode === 'model' ? '模型矢量' : '转换后矢量';
  const format = sheet ? `${scene.format ?? 'SolidWorks SLDDRW'} · ${sheet.vector ? '页面矢量' : '矢量预览暂不可用'}` : scene.dwgVersion ? `DWG ${scene.dwgVersion} · ${dwgMode}`
    : state.fixedPlot ? 'DWFx · 页面矢量' : scene.format ? `${scene.format} · ${state.raster ? '内嵌图' : '模型矢量'}` : 'DXF 矢量';
  const details = sheet ? `第 ${page + 1} / ${scene.sheets.length} 页` : state.raster ? `${image.width} × ${image.height} px`
    : state.fixedPlot ? `${scene.items.length} 页` :
      [scene.version, scene.encoding, `${scene.items.length} 项预览元素`].filter(Boolean).join(' · ');
  byId('file-meta').textContent = `${format} · ${details}`;
  const viewName = sheet?.name ?? (scene.blockView ? `块定义 ${scene.blockView.name}` : state.raster ? '内嵌图' :
    state.fixedPlot ? '打印页面' : scene.projection ? '三视图' : '模型空间');
  byId('view-hints').textContent = `${viewName} · 滚轮缩放 · 拖动平移 · 双击适配`;
  const views = scene.blockViews ?? [];
  blockView.replaceChildren(new Option('模型空间', ''), ...views.map(({ handle, name, count }) =>
    new Option(`${name}（${count} 条多重引线）`, handle)));
  state.block = scene.blockView?.handle ?? '';
  blockView.value = state.block;
  byId('block-picker').hidden = !views.length;
  updateWarnings(sheet?.issues?.length ? [...scene.issues, ...sheet.issues] : scene.issues);
  updateLayers();
  if (sheet && !sheet.vector) {
    byId('visible-count').textContent = '无可预览矢量';
    byId('empty-title').textContent = '此页暂无法生成矢量预览';
    byId('empty-note').textContent = scene.pdfAvailable ? '可通过上方菜单导出保存画面的 PDF。' : '请查看下方的预览提示。';
  } else if (sheet && !items.length) {
    byId('empty-title').textContent = '此页没有已读取的矢量图元';
    byId('empty-note').textContent = '可在右侧切换到其他图纸页。';
  }
}

function showMesh(active, keepParts = false) {
  state.mesh = active;
  drawing.toggleAttribute('hidden', active);
  meshCanvas.hidden = meshView.hidden = byId('mesh-info').hidden = meshTree.hidden =
    byId('mesh-tree-controls').hidden = !active;
  byId('work-area').classList.toggle('is-3d', active);
  byId('mesh-explosion').hidden = !active || !state.canExplode;
  if (!active && !keepParts) {
    meshTree.replaceChildren();
    state.setParts = null;
    state.refreshParts = null;
    state.canExplode = false;
  }
  byId('axis').textContent = active ? 'XYZ' : '↗ XY';
}

function updateMeshSpread() {
  byId('mesh-spread-value').value = meshSpread.value + '%';
  meshViewer.setExplosion(meshSpread.valueAsNumber / 100);
}

function mountMeshTree(tree, canProjectParts) {
  const leaves = [];
  const spans = new Map();
  const checkboxes = new Map();
  function index(node) {
    const first = leaves.length;
    if (node.children) node.children.forEach(index);
    else if (node.count) leaves.push(node);
    spans.set(node, [first, leaves.length]);
  }
  tree.forEach(index);
  const visibility = new Uint8Array(leaves.length).fill(1);
  const prefix = new Uint32Array(leaves.length + 1);

  function syncCheckbox(node, checkbox) {
    const [first, end] = spans.get(node);
    const visible = prefix[end] - prefix[first];
    checkbox.checked = end > first && visible === end - first;
    checkbox.indeterminate = visible > 0 && !checkbox.checked;
  }

  function update() {
    const ranges = [];
    let faces = 0;
    for (let i = 0; i < leaves.length; i++) {
      prefix[i + 1] = prefix[i] + visibility[i];
      if (!visibility[i]) continue;
      const { start, count } = leaves[i];
      const last = ranges.at(-1);
      if (last && last[0] + last[1] === start) last[1] += count;
      else ranges.push([start, count]);
      faces += count;
    }
    for (const [node, checkbox] of checkboxes) syncCheckbox(node, checkbox);
    meshViewer.setVisible(ranges);
    const visible = prefix[leaves.length];
    byId('layer-count').textContent = visible + ' / ' + leaves.length;
    byId('visible-count').textContent = faces.toLocaleString('zh-CN') + ' 个可见三角面';
    byId('empty-title').textContent = '所有零件已隐藏';
    byId('empty-note').textContent = '在装配结构中勾选零件或点击「全显」。';
    empty.hidden = visible > 0;
  }

  function appendPage(list, nodes, parentPath = '', start = 0) {
    const end = Math.min(start + 80, nodes.length);
    const rows = document.createDocumentFragment();
    for (let i = start; i < end; i++) rows.append(makeRow(nodes[i], parentPath + i));
    if (end < nodes.length) {
      const more = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mesh-more';
      button.textContent = '显示更多（剩余 ' + (nodes.length - end) + '）';
      button.addEventListener('click', () => {
        const previous = more.previousElementSibling;
        more.remove();
        appendPage(list, nodes, parentPath, end);
        previous?.nextElementSibling?.querySelector('input')?.focus();
      });
      more.append(button);
      rows.append(more);
    }
    list.append(rows);
  }

  function makeRow(node, path) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'mesh-tree-row';
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = !node.count;
    checkboxes.set(node, checkbox);
    syncCheckbox(node, checkbox);
    checkbox.addEventListener('change', () => {
      visibility.fill(Number(checkbox.checked), ...spans.get(node));
      update();
    });
    label.append(checkbox);
    if (node.children?.length) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      const children = document.createElement('ul');
      function expand(value) {
        if (value && !children.firstChild) appendPage(children, node.children, path + '.');
        children.hidden = !value;
        toggle.textContent = value ? '▾' : '▸';
        toggle.setAttribute('aria-expanded', String(value));
        toggle.setAttribute('aria-label', (value ? '折叠 ' : '展开 ') + node.label);
      }
      expand(tree.length === 1 && node === tree[0]);
      toggle.addEventListener('click', () => expand(children.hidden));
      row.append(toggle);
      item.append(row, children);
    } else {
      const indent = document.createElement('span');
      indent.className = 'mesh-indent';
      row.append(indent);
      if (!node.children) {
        const chip = svg('svg', { width: 11, height: 11, 'aria-hidden': 'true' });
        chip.append(svg('rect', { width: 11, height: 11, rx: 2, fill: 'rgb(' + partColor(node.color).join(',') + ')' }));
        label.append(chip);
      }
      item.append(row);
    }
    const name = document.createElement('span');
    name.className = 'mesh-node-name';
    name.textContent = name.title = node.label;
    label.append(name);
    if (node.children) {
      const total = document.createElement('span');
      total.className = 'mesh-total';
      const [first, end] = spans.get(node);
      total.textContent = end - first;
      total.setAttribute('aria-hidden', 'true');
      label.append(total);
    }
    row.append(label);
    if (canProjectParts && node.count && node.count <= projectionTriangleLimit && node.projectionAvailable !== false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mesh-project';
      button.textContent = '三视图';
      button.title = '生成「' + node.label + '」的三视图';
      button.setAttribute('aria-label', button.title);
      button.addEventListener('click', () => openProjection(path, button));
      row.append(button);
    }
    return item;
  }

  state.setParts = visible => {
    visibility.fill(Number(visible));
    update();
  };
  state.refreshParts = update;
  meshTree.replaceChildren();
  state.canExplode = leaves.length >= 2;
  byId('mesh-explosion').hidden = !state.canExplode;
  meshSpread.value = 0;
  updateMeshSpread();
  update();
  appendPage(meshTree, tree);
}

function loadMesh({ format, mesh, issues, configurations, selectedConfiguration }, filename, resume) {
  meshViewer ??= new MeshViewer(meshCanvas, text => { if (!state.request) setMessage(text, Boolean(text)); }, measurement.redraw,
    ({ drawn, detailed, visible, failure }) => {
      const count = byId('visible-count');
      count.dataset.drawn = drawn;
      count.dataset.detailed = detailed;
      count.dataset.visible = visible;
      count.textContent = failure || ('已显示 ' + drawn + ' / ' + visible + ' 个视口内实例' +
        (detailed < drawn ? ' · ' + detailed + ' 个已载入完整网格' : ''));
    });
  const tree = meshViewer.load(mesh, resume);
  const counter = byId('visible-count');
  delete counter.dataset.drawn;
  delete counter.dataset.detailed;
  delete counter.dataset.visible;
  showMesh(true);
  makeProjection.textContent = mesh.tree ? '生成整套三视图' : '生成三视图';
  world.replaceChildren();
  layerList.replaceChildren();
  state.items = [];
  state.layers = [];
  state.block = '';
  state.view = null;
  state.visibleCount = mesh.count;
  empty.hidden = true;
  if (!resume) meshView.value = 'iso';
  controls.forEach(button => { button.disabled = false; });
  byId('block-picker').hidden = true;
  byId('layer-controls').hidden = true;
  byId('layers-empty').hidden = true;
  byId('layers-title').textContent = '装配结构';
  byId('mesh-size').textContent = mesh.size.map(value => Number(value.toPrecision(7))).join(' × ');
  byId('mesh-unit').textContent = mesh.unit ?? (format.startsWith('STL') ? 'STL 文件未声明' : '文件未声明');
  byId('file-name').textContent = filename;
  byId('file-meta').textContent = mesh.asset
    ? `${format} · ${mesh.instances} 个实例 · ${mesh.meshes.length} 份网格` +
      (mesh.unavailable ? ` · ${mesh.unavailable} 个实例几何未读出` : '')
    : `${format} · 三维网格`;
  const selected = configurations?.find(row => row.id === selectedConfiguration);
  if (selected) byId('file-meta').textContent += ' · 配置 ' + selected.name;
  if (resume) state.refreshParts();
  else mountMeshTree(tree, Boolean(mesh.tree));
  byId('view-hints').textContent = '拖动旋转 · Shift + 拖动平移 · 滚轮缩放 · 双击适配';
  updateWarnings(issues);
}

function updateWarnings(issues) {
  const warnings = byId('warnings');
  warnings.hidden = !issues.length;
  warnings.open = Boolean(issues.length);
  byId('warning-summary').textContent = `预览提示（${issues.length} 类）`;
  const list = document.createDocumentFragment();
  for (const [issue, count] of issues.slice(0, 30)) {
    const row = document.createElement('li');
    row.textContent = count > 1 ? `${issue}（${count} 处）` : issue;
    list.append(row);
  }
  if (issues.length > 30) {
    const row = document.createElement('li');
    row.textContent = `另有 ${issues.length - 30} 类提示。`;
    list.append(row);
  }
  byId('warning-list').replaceChildren(list);
}

function showOpenFailure(filename, reason) {
  let current = state.mesh || state.items.length ? byId('file-name').textContent : '';
  const source = state.meshSource?.scene;
  const selected = source?.configurations?.find(row => row.id === source.selectedConfiguration);
  if (current && selected) current += '（配置 ' + selected.name + '）';
  setMessage(`未能打开 ${filename}：${reason}${current ? ` 当前仍显示 ${current}。` : ''}`, true);
}

function updatePartConfigurations(details, file, filename) {
  const list = details?.configurations;
  const picker = byId('part-config-picker');
  picker.hidden = !list?.length;
  if (!list?.length) {
    state.partSource = null;
    return;
  }
  state.partSource = { file, filename };
  picker.title = filename;
  partConfiguration.replaceChildren(...list.map(row => new Option(row.name + (row.savedGeometry ? '' : '（未保存几何）'), row.id)));
  partConfiguration.value = details.selectedConfiguration;
}

async function openDrawing(filename, readFile, block = '', formatHint, native = false, configuration, hostContext) {
  if (!block) setDiagnosticContext(filename);
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  const signal = request.signal;
  setMessage(block ? '正在读取图块…' : `正在读取 ${filename}…`);
  blockView.disabled = true;
  partConfiguration.disabled = true;
  try {
    const file = await readFile(signal);
    if (formatHint === 'slddrw' && !native) {
      state.solidWorksSource = { file, filename };
      nativeSolidWorks.hidden = !solidWorksEnabled;
    }
    const route = native ? './api/solidworks?format=preview' :
      block ? `./api/preview?block=${encodeURIComponent(block)}` : './api/preview';
    const shared = !native && !block && ['x_t', 'step', 'stp'].includes(formatHint);
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(formatHint && { 'X-XYCAD-Format': formatHint }),
        ...(configuration !== undefined && { 'X-XYCAD-Configuration': configuration }),
        ...(shared && { 'X-XYCAD-Assembly': '1' }) },
      body: file,
      signal,
    });
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('预览服务不可用。');
    const result = await response.json();
    if (state.request !== request) return;
    const details = result.scene ?? result;
    if (formatHint === 'sldprt' && details.configurations) updatePartConfigurations(details, file, filename);
    if (!response.ok) throw new Error(result.error || '图纸读取失败。');
    if (formatHint !== 'sldprt') updatePartConfigurations(null);
    loadScene(result.scene, filename);
    hostTools.loaded(file, hostContext);
    state.meshSource = result.scene.mesh ? { scene: result.scene, file, filename, formatHint } : null;
    state.previewFile = result.scene.blockViews?.length ? file : null;
    state.downloadFile = result.scene.dwgVersion && !result.scene.image ? file : null;
    const vector = result.scene.dxfAvailable;
    const pdf = result.scene.pdfAvailable;
    state.sheetFile = vector || pdf ? file : null;
    state.nativeSheets = native ? result.scene.sheets.length : 0;
    if (formatHint !== 'slddrw') {
      state.solidWorksSource = null;
      nativeSolidWorks.hidden = true;
    }
    sheetFormat.querySelector('[value="dxf"]').disabled = !vector;
    sheetFormat.querySelector('[value="pdf"]').disabled = !pdf;
    download.hidden = !state.downloadFile;
    byId('sheet-export').hidden = !state.sheetFile;
    sheetFormat.value = '';
    downloadSheet.disabled = true;
    if (!block && (result.scene.projectionAvailable === false || result.scene.dxfAvailable === false || result.scene.image)) {
      setDiagnosticContext(filename, 'partial');
    }
    setMessage('');
  } catch (error) {
    if (state.request === request) {
      blockView.value = state.block ?? '';
      if (!block) setDiagnosticContext(filename, 'failed');
      showOpenFailure(filename, signal.aborted ? '预览请求超时，请重试。' : error.message);
    }
  } finally {
    if (state.request === request) {
      state.request = null;
      blockView.disabled = false;
      partConfiguration.disabled = false;
    }
  }
}

nativeSolidWorks.addEventListener('click', async () => {
  const source = state.solidWorksSource;
  if (!source || state.request) return;
  nativeSolidWorks.disabled = true;
  try { await openDrawing(source.filename, () => source.file, '', 'slddrw', true); }
  finally { nativeSolidWorks.disabled = false; }
});

blockView.addEventListener('change', () => {
  const file = state.previewFile;
  if (file) openDrawing(byId('file-name').textContent, () => file, blockView.value);
});

partConfiguration.addEventListener('change', () => {
  const source = state.partSource;
  if (source) openDrawing(source.filename, () => source.file, '', 'sldprt', false, partConfiguration.value);
});

async function saveDrawing(key, route, suffix, formatHint) {
  const source = state[key];
  const file = source?.file ?? source;
  if (!file) return;
  try {
    const response = await fetch(route, source.scene?.mesh?.asset ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(formatHint && { 'X-XYCAD-Format': formatHint }) },
      body: file,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      const error = contentType.startsWith('application/json') ? (await response.json()).error : null;
      throw new Error(error || '图纸导出失败。请确认本地服务已更新。');
    }
    const expected = suffix.endsWith('.pdf') ? 'application/pdf' : suffix.endsWith('.zip') ? 'application/zip' : 'application/dxf';
    if (!contentType.startsWith(expected)) {
      throw new Error('服务返回了不符合所选格式的文件。');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = (file.name || '图纸').replace(/\.[^.]+$/, '') + suffix;
    hostTools.exported(blob,link.download,file);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    if (state[key] === source) setMessage(error.message, true);
  }
}

function visibleHiddenMask() {
  let mask = 7;
  for (const { name, checkbox } of state.layers) {
    const index = projectionHiddenLayers.indexOf(name);
    if (index !== -1 && !checkbox.checked) mask &= ~(1 << index);
  }
  return mask;
}

function applyHiddenMask(mask) {
  for (const { name, checkbox } of state.layers) {
    const index = projectionHiddenLayers.indexOf(name);
    if (index !== -1) checkbox.checked = Boolean(mask & (1 << index));
  }
  updateLayers();
}

function projectionRoute(part, front, format) {
  const params = new URLSearchParams();
  if (part) params.set('part', part);
  if (front !== 'ny') params.set('front', front);
  if (format) {
    params.set('format', format);
    const mask = visibleHiddenMask();
    if (mask !== 7) params.set('hidden', mask);
  }
  const asset = state.meshSource?.scene.mesh.asset;
  const route = asset ? './api/assembly/' + asset + '/projection' : './api/projection' + (part ? '/part' : '');
  return route + (params.size ? '?' + params : '');
}

async function openProjection(part, button) {
  const source = state.meshSource;
  if (!source || state.request) return;
  const front = projectionFront.value;
  if (source.projection?.part === part && source.projection.front === front) {
    loadScene(source.projection.scene, source.filename);
    setMessage('');
    return;
  }
  const request = new AbortController();
  state.request = request;
  makeProjection.disabled = projectionFront.disabled = button.disabled = true;
  const hidden = state.mesh ? 7 : visibleHiddenMask();
  setMessage(part ? '正在计算所选节点的三视图…' : '正在计算三视图和遮挡线…');
  try {
    const response = await fetch(projectionRoute(part, front), source.scene.mesh.asset ? { signal: request.signal } : {
      method: 'POST', body: source.file,
      headers: { 'Content-Type': 'application/octet-stream', ...(source.formatHint && { 'X-XYCAD-Format': source.formatHint }) },
      signal: request.signal,
    });
    if (response.status === 404 || response.status === 405) {
      throw new Error(part ? '当前 XYCAD 服务缺少单件三视图接口。请重启本地服务后刷新页面。' :
        '当前 XYCAD 服务缺少三视图接口。请重启本地服务后刷新页面。');
    }
    if (!response.headers.get('content-type')?.startsWith('application/json')) throw new Error('三视图服务不可用。');
    const result = await response.json();
    if (state.request !== request) return;
    if (!response.ok) throw new Error(result.error || '三视图生成失败。');
    if (part && result.scene.projectionPart?.path !== part) throw new Error('三视图结果与所选节点不一致，请重试。');
    if (result.scene.projectionFront !== front) throw new Error('服务返回的主视方向不一致，请更新本地服务。');
    source.projection = { part, front, scene: result.scene };
    loadScene(result.scene, source.filename);
    if (hidden !== 7) applyHiddenMask(hidden);
    setMessage('');
  } catch (error) {
    if (state.request === request) {
      if (!state.mesh) projectionFront.value = source.projection.front;
      setMessage(error.message, true);
    }
  } finally {
    if (state.request === request) state.request = null;
    makeProjection.disabled = projectionFront.disabled = button.disabled = false;
  }
}

makeProjection.addEventListener('click', () => openProjection('', makeProjection));
projectionFront.addEventListener('change', () => {
  if (!projectionExport.hidden && state.meshSource?.projection) {
    openProjection(state.meshSource.projection.part, downloadProjection);
  }
});
backToMesh.addEventListener('click', () => {
  const source = state.meshSource;
  if (!source || state.request) return;
  loadScene(source.scene, source.filename, 0, true);
  setMessage('');
});
projectionFormat.addEventListener('change', () => {
  downloadProjection.textContent = '下载三视图 ' + projectionFormat.value.toUpperCase();
});
projectionHidden.addEventListener('change', () => {
  applyHiddenMask(projectionHidden.checked ? 7 : 0);
});
downloadProjection.addEventListener('click', async () => {
  const source = state.meshSource;
  const projection = source?.projection;
  if (!projection || state.request) return;
  const label = projection.scene.projectionPart?.label.replace(/[<>:"/\\|?*]/g, '_').slice(0, 72);
  const format = projectionFormat.value;
  const suffix = (label ? '.' + label : '') + '.三视图.' + format;
  downloadProjection.disabled = projectionFormat.disabled = projectionFront.disabled = true;
  try { await saveDrawing('meshSource', projectionRoute(projection.part, projection.front, format), suffix, source.formatHint); }
  finally { downloadProjection.disabled = projectionFormat.disabled = projectionFront.disabled = false; }
});

download.addEventListener('click', async () => {
  download.disabled = true;
  try { await saveDrawing('downloadFile', './api/convert', '.xycad.dxf'); }
  finally { download.disabled = false; }
});
sheetFormat.addEventListener('change', () => { downloadSheet.disabled = !sheetFormat.value; });
downloadSheet.addEventListener('click', async () => {
  const format = sheetFormat.value;
  if (!format) return;
  downloadSheet.disabled = sheetFormat.disabled = true;
  const native = state.nativeSheets > 0;
  const extension = format === 'dxf' && state.nativeSheets > 1 ? 'dxf.zip' : format;
  try { await saveDrawing('sheetFile', (native ? './api/solidworks' : './api/export') + '?format=' + format, '.xycad.' + extension); }
  finally {
    sheetFormat.disabled = false;
    downloadSheet.disabled = !sheetFormat.value;
  }
});

function selectSheet(index) {
  if (state.sheetScene?.sheets[index]) loadScene(state.sheetScene, byId('file-name').textContent, index);
}
sheetView.addEventListener('change', () => selectSheet(Number(sheetView.value)));
byId('previous-sheet').addEventListener('click', () => selectSheet(Number(sheetView.value) - 1));
byId('next-sheet').addEventListener('click', () => selectSheet(Number(sheetView.value) + 1));

function openFile(file) {
  if (!file) return;
  const extension = file.name.split('.').at(-1).toLowerCase();
  const supported = file.name.includes('.') && uploadExtensions.includes(extension);
  if (!supported || file.size < 1) {
    state.request?.abort();
    state.request = null;
    blockView.disabled = false;
    const reason = supported ? `请选择非空 ${extension.toUpperCase()} 文件。` : `支持的格式为 ${uploadHint}。`;
    showOpenFailure(file.name, reason);
    return;
  }
  openDrawing(file.name, () => file, '', formatHints.includes(extension) ? extension : undefined);
}

byId('open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  openFile(fileInput.files[0]);
  fileInput.value = '';
});
byId('sample').addEventListener('click', () => openDrawing('铜排示例.dxf', async signal => {
  const response = await fetch('./sample.dxf', { signal });
  if (!response.ok) throw new Error('样图读取失败。');
  return response.blob();
}));

for (const [id, value] of [['show-layers', true], ['hide-layers', false], ['reset-layers', undefined]]) {
  byId(id).addEventListener('click', () => {
    for (const layer of state.layers) layer.checkbox.checked = value ?? layer.visible;
    updateLayers();
  });
}
byId('show-parts').addEventListener('click', () => state.setParts?.(true));
byId('hide-parts').addEventListener('click', () => state.setParts?.(false));
meshSpread.addEventListener('input', updateMeshSpread);
byId('mesh-reset-spread').addEventListener('click', () => {
  meshSpread.value = 0;
  updateMeshSpread();
});

const drop = byId('drop');
document.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
document.addEventListener('drop', event => {
  if (event.dataTransfer.files.length) event.preventDefault();
  drop.hidden = true;
});
viewport.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) {
    event.dataTransfer.dropEffect = 'copy';
    drop.hidden = false;
  }
});
viewport.addEventListener('dragleave', event => {
  if (!viewport.contains(event.relatedTarget)) drop.hidden = true;
});
viewport.addEventListener('drop', event => openFile(event.dataTransfer.files[0]));

byId('fit').addEventListener('click', fit);
byId('in').addEventListener('click', () => zoom(0.8));
byId('out').addEventListener('click', () => zoom(1.25));
viewport.addEventListener('dblclick', () => { if (!measurement.active()) fit(); });
meshView.addEventListener('change', () => meshViewer.setView(meshView.value));
viewport.addEventListener('wheel', event => {
  if (!state.visibleCount) return;
  event.preventDefault();
  measurement.clearHover();
  const rect = viewport.getBoundingClientRect();
  const delta = event.deltaY * [1, 16, rect.height][event.deltaMode];
  zoom(Math.exp(Math.max(-0.55, Math.min(0.55, delta * 0.0015))),
    (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height, true);
}, { passive: false });

let drag, panFrame;

function applyPan() {
  panFrame = undefined;
  if (!drag || drag.mesh || state.mesh || !state.view) return;
  const rect = viewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const view = state.view;
  const dx = drag.nextX - drag.x;
  const dy = drag.nextY - drag.y;
  drag.x = drag.nextX;
  drag.y = drag.nextY;
  if (dx || dy) {
    state.view = { ...view, x: view.x - dx * view.width / rect.width, y: view.y - dy * view.height / rect.height };
    paintMotion(rect);
  }
}

viewport.addEventListener('pointerdown', event => {
  if (!state.visibleCount || drag || event.button !== 0) return;
  measurement.clearHover();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, mesh: state.mesh,
    pan: event.shiftKey, measuring: measurement.active(), moved: false };
  viewport.setPointerCapture(event.pointerId);
  (state.mesh ? meshCanvas : drawing).classList.add('dragging');
});
viewport.addEventListener('pointermove', event => { if (!drag) measurement.hover(event); });
viewport.addEventListener('pointerleave', measurement.clearHover);
window.addEventListener('pointermove', event => {
  if (drag?.id !== event.pointerId || drag.mesh !== state.mesh) return;
  if (drag.measuring && !drag.moved) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.moved = true;
  }
  if (drag.mesh) {
    meshViewer.drag(event.clientX - drag.x, event.clientY - drag.y, drag.pan);
    if (!drag.pan) meshView.value = 'custom';
    drag.x = event.clientX;
    drag.y = event.clientY;
    return;
  }
  drag.nextX = event.clientX;
  drag.nextY = event.clientY;
  if (panFrame === undefined) panFrame = requestAnimationFrame(applyPan);
});
function endDrag(event) {
  if (event.type !== 'blur' && drag?.id !== event.pointerId) return;
  if (panFrame !== undefined) {
    cancelAnimationFrame(panFrame);
    applyPan();
  }
  const pick = event.type === 'pointerup' && drag?.measuring && !drag.moved && drag.mesh === state.mesh &&
    Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5;
  drag = undefined;
  drawing.classList.remove('dragging');
  meshCanvas.classList.remove('dragging');
  if (!motionCanvas.hidden || wheelFrame !== undefined) settleMotion();
  if (pick) measurement.pick(event);
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

new ResizeObserver(() => {
  if (state.mesh) return meshViewer.drawSoon();
  if (!state.view) return;
  const { width, height } = viewport.getBoundingClientRect();
  if (!width || !height) return;
  const view = state.view;
  const nextHeight = view.width * height / width;
  setView(view.x, view.y + (view.height - nextHeight) / 2, view.width, nextHeight);
}).observe(viewport);
