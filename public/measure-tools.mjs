import { distanceBetween, angleBetween, triangleArea, polygonMetrics, nearestOnSegment, pickDrawingPoint, projectMeshPoint,
  rimDiameter, parallelPlaneSpacing } from './cad-measure.mjs';

const modes = [
  ['distance', '距离 / 轴向差', '依次点选两个位置。'],
  ['segment', '点到直线段', '先选测量点，再点选一条直线段。'],
  ['angle', '三点角度', '依次点选三点，第二点是角的顶点。'],
  ['area', '面积 / 周长', '依次点选边界顶点，再点「闭合面积」。'],
  ['coordinates', '点坐标', '点选要读取坐标的位置。'],
  ['radius', '半径 / 直径', '点选圆、圆弧或多段线上的圆弧段。'],
  ['hole', '三维孔径', '沿同一孔口分散点选四处圆边。'],
  ['planes', '两平面间距', '分别点选两个平行平面的内部。'],
];
const meshModes = new Set(['hole', 'planes']);
const maxPolygonPoints = 128;
const formatted = (value, resolution = 0) => resolution
  ? Number(value.toFixed(Math.max(0, Math.min(100, Math.ceil(-Math.log10(resolution)))))).toString()
  : Number(value.toPrecision(12)).toString();
const byId = id => document.getElementById(id);

export function createMeasureTools(viewport, drawingMatrix, getItems, getMeshViewer) {
  const select = byId('measure-mode');
  const panel = byId('measure-panel');
  const output = byId('measure-result');
  const caption = byId('measure-caption');
  const overlay = byId('measure-overlay');
  const snap = byId('measure-snap');
  const scaleLabel = byId('measure-scale-label');
  const scaleInput = byId('measure-scale');
  const undo = byId('measure-undo');
  const close = byId('measure-close');
  const clear = byId('measure-clear');
  let options, points = [], complete = false, result, target, reference, hoverFrame, hoverEvent, hoverEnabled;

  const active = () => Boolean(options && select.value);
  const isMesh = () => options?.dimension === 3;
  const unit = () => options.unit ?? '原坐标单位';
  const precision = () => isMesh() ? options.scale * 1e-7 : options.fixedPlot ? 0.01 : 0;
  const length = value => formatted(value, precision()) + ' ' + unit();
  const coordinateText = (values, prefix = '') => values.map((value, i) =>
    prefix + 'XYZ'[i] + ' ' + formatted(value, precision())).join(' · ');
  const polygon = () => select.value === 'area' && !isMesh();
  const scale = () => (options.scale ?? 1) * (options.sheet && scaleInput.validity.valid ? scaleInput.valueAsNumber || 1 : 1);
  const areaText = (label, { area, perimeter }) =>
    label + ' ' + formatted(area, options.fixedPlot ? 0.01 : 0) + ' ' + unit() + '² · 周长 ' + length(perimeter);

  function addShape(tag, attributes, text) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    if (text) element.textContent = text;
    overlay.append(element);
  }

  function redraw(camera) {
    overlay.replaceChildren();
    if (!points.length && !target) return;
    const rect = viewport.getBoundingClientRect();
    const matrix = !isMesh() && drawingMatrix();
    if (isMesh()) camera ??= getMeshViewer()?.camera();
    if (!rect.width || !rect.height || (!matrix && !camera)) return;
    overlay.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
    const toScreen = hit => {
      if (isMesh()) return projectMeshPoint(camera, hit);
      const { x, y } = new DOMPoint(...hit.point).matrixTransform(matrix);
      return [x - rect.left, y - rect.top];
    };
    const screen = points.map(toScreen);
    const path = screen.map(point => point.join(',')).join(' ');
    if (reference) {
      const [[x1, y1], [x2, y2]] = reference.map(point => toScreen({ point }));
      addShape('line', { x1, y1, x2, y2, class: 'measure-reference' });
    }
    if (screen.length > 1 && !meshModes.has(select.value)) {
      addShape(complete && select.value === 'area' ? 'polygon' : 'polyline', { points: path, class: 'measure-geometry' });
    }
    for (const [i, [x, y]] of screen.entries()) {
      addShape('circle', { cx: x, cy: y, r: 4.5, class: 'measure-point' });
      addShape('text', { x: x + 8, y: y - 7, class: 'measure-number' }, String(i + 1));
    }
    if (target) {
      const [cx, cy] = toScreen(target);
      addShape('circle', { cx, cy, r: 6, class: 'measure-target' });
    }
  }

  function update(error = '') {
    const mode = select.value;
    panel.hidden = !active();
    viewport.classList.toggle('measuring', active());
    snap.parentElement.hidden = Boolean(options?.fixedPlot);
    snap.disabled = mode === 'radius' || mode === 'planes' || mode === 'segment' && points.length === 1;
    scaleLabel.hidden = !options?.sheet || mode === 'coordinates' || mode === 'angle';
    undo.disabled = clear.disabled = !points.length;
    close.hidden = !polygon();
    close.disabled = points.length < 3 || complete;
    if (!scaleLabel.hidden && (!scaleInput.value || !scaleInput.validity.valid)) error = '请输入 0.000001 至 1000000 的比例。';
    output.classList.toggle('measure-error', Boolean(error));
    const instruction = isMesh() && mode === 'area' ? '点选三点，测量它们构成的三角形。' : modes.find(entry => entry[0] === mode)?.[2];
    output.textContent = error || result?.() || (instruction ? instruction + (points.length ? ' 已选 ' + points.length + ' 点。' : '') : '');
    caption.textContent = !active() ? '' : [
      !options.unit ? '文件未声明单位' : '',
      isMesh() ? (mode === 'planes' ? '按所选网格面的法向和装配原位估算' : '按装配原位计算 · 网格取点为近似值') :
        options.fixedPlot ? '同页自由取点，读数为近似值 · 按打印尺寸，可填写视图比例' :
        options.sheet ? '坐标按图纸页 · 长度及面积可按所选视图比例换算' : '',
    ].filter(Boolean).join(' · ');
    redraw();
  }

  function reset() {
    points = [];
    complete = false;
    result = target = reference = null;
    hoverEvent = null;
    update();
  }

  function configure(value) {
    options = value;
    scaleInput.value = '1';
    select.hidden = !options;
    const available = modes.filter(([key]) => isMesh()
      ? key !== 'radius' && key !== 'segment' && (key !== 'coordinates' || options.origin)
      : !meshModes.has(key) && (!options?.fixedPlot || key !== 'radius' && key !== 'segment'));
    select.replaceChildren(new Option('测量', ''), ...available.map(([key, label]) => new Option(label, key)));
    let count = 0;
    hoverEnabled = Boolean(options && !isMesh() && !options.fixedPlot && getItems().length <= 6000);
    if (hoverEnabled) {
      for (const { item } of getItems()) {
        count += item.polyline?.vertices.length ?? item.vertices?.length ?? 1;
        if (count > 6000) { hoverEnabled = false; break; }
      }
    }
    reset();
  }

  function closeArea() {
    if (!polygon() || points.length < 3) return;
    const metrics = polygonMetrics(points.map(hit => hit.point));
    if (!metrics) return update('边界相交或没有面积，请撤销后重新选点。');
    complete = true;
    result = () => areaText('面积', { area: metrics.area * scale() ** 2, perimeter: metrics.perimeter * scale() });
    update();
  }

  function drawingHit(event, onlySnap = false) {
    const matrix = drawingMatrix();
    if (!matrix) return null;
    const { x, y } = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const point = [x, y];
    if (options.fixedPlot) {
      const page = getItems().find(({ item, element }) => !element.classList.contains('layer-off') &&
        x >= 0 && x <= item.width && y <= -item.offset && y >= -item.offset - item.height)?.item;
      return page ? { point, page } : null;
    }
    const mode = select.value === 'radius' ? 'radius' : select.value === 'segment' && points.length === 1 ? 'segment' : 'point';
    const hit = (snap.checked || mode !== 'point') && pickDrawingPoint(getItems(), point, 10 / Math.hypot(matrix.a, matrix.b), mode);
    return hit || (!onlySnap && mode === 'point' ? { point } : null);
  }

  function hover(event) {
    if (!hoverEnabled || !active() || event.pointerType === 'touch') return;
    hoverEvent = event;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(() => {
      hoverFrame = null;
      target = hoverEvent && active() ? drawingHit(hoverEvent, true) : null;
      redraw();
    });
  }

  function clearHover() {
    hoverEvent = null;
    if (!target) return;
    target = null;
    redraw();
  }

  function pick(event) {
    if (!active()) return;
    const mode = select.value;
    const radiusMode = mode === 'radius';
    const needed = { distance: 2, segment: 2, angle: 3, area: isMesh() ? 3 : Infinity, coordinates: 1, radius: 2, hole: 4, planes: 2 }[mode];
    let hit;
    if (isMesh()) {
      const viewer = getMeshViewer();
      const camera = viewer.camera();
      if (!camera) return;
      const rect = viewport.getBoundingClientRect();
      hit = viewer.pick(camera, [event.clientX - rect.left, event.clientY - rect.top], !snap.disabled && snap.checked ? 8 : 0);
      if (hit?.message) return update(hit.message);
      if (!hit) return update('请点选可见的模型表面。');
    } else {
      hit = drawingHit(event);
      if (!hit) return update(radiusMode ? '请选择可见的圆或圆弧边线。' :
        options.fixedPlot ? '请在可见的打印页内取点。' : '请点选可见的直线段。');
      if (!complete && points.length && hit.page !== points[0].page) return update('请在同一页取点。');
    }
    if (complete || points.length >= needed) {
      points = [];
      complete = false;
      result = reference = null;
    }
    if (points.length >= maxPolygonPoints) return update('已达到 128 点上限，请闭合面积。');
    if (radiusMode) {
      points = [{ point: hit.center }, hit];
      result = () => '半径 R ' + length(hit.radius * scale()) + ' · 直径 Ø ' + length(hit.radius * 2 * scale());
    } else if (hit.segment) {
      reference = hit.segment;
      const point = nearestOnSegment(points[0].point, ...reference);
      points.push({ point });
      const raw = distanceBetween(points[0].point, point).distance;
      result = () => '到直线段的最短距离 ' + length(raw * scale());
    } else {
      const previous = points.at(-1)?.point;
      if (previous?.every((value, i) => value === hit.point[i])) return update('请选择另一个点。');
      if (polygon() && points.length >= 3 && points[0].point.every((value, i) => value === hit.point[i])) return closeArea();
      points.push(hit);
      if (points.length < needed) return update();
      const [a, b, c] = points.map(point => point.point);
      if (mode === 'distance') {
        result = () => {
          const { distance, delta } = distanceBetween(a, b, scale());
          return '距离 ' + length(distance) + ' · ' + coordinateText(delta, 'Δ');
        };
      } else if (mode === 'angle') {
        const angle = angleBetween(a, b, c);
        if (angle === null) { points.pop(); return update('角的顶点和两端需要是不同的位置。'); }
        result = () => '夹角 ' + formatted(angle, isMesh() ? 1e-5 : options.fixedPlot ? 0.01 : 0) + '°';
      } else if (mode === 'coordinates') {
        const coordinates = isMesh() ? a.map((value, i) => value * options.scale + options.origin[i]) : a;
        const local = hit.page ? [a[0] * options.scale, (a[1] + hit.page.offset + hit.page.height) * options.scale] : coordinates;
        result = () => coordinateText(local) + ' ' + unit();
      } else if (mode === 'area') {
        const area = triangleArea(a, b, c, options.scale);
        if (!area) { points.pop(); return update('三点在同一条直线上，请重新选第三点。'); }
        const perimeter = distanceBetween(a, b, options.scale).distance + distanceBetween(b, c, options.scale).distance +
          distanceBetween(c, a, options.scale).distance;
        result = () => areaText('三角形面积', { area, perimeter });
      } else if (mode === 'hole') {
        const diameter = rimDiameter(points.map(point => point.point));
        if (diameter === null) {
          points.pop();
          return update('取点未形成同一圆边。请重选第四点，或撤销后沿孔口分散取点。');
        }
        result = () => '孔径 Ø ' + length(diameter * scale()) + ' · 半径 R ' + length(diameter * scale() / 2);
      } else if (mode === 'planes') {
        const spacing = parallelPlaneSpacing(...points, scale());
        if (spacing === null) {
          points.pop();
          return update('所选网格面不平行，请重新点选第二个平面。');
        }
        result = () => '两平面间距 ' + length(spacing);
      }
    }
    complete = true;
    update();
  }

  select.addEventListener('change', reset);
  scaleInput.addEventListener('input', () => update());
  clear.addEventListener('click', reset);
  undo.addEventListener('click', () => {
    if (select.value === 'radius') return reset();
    points.pop();
    complete = false;
    result = reference = null;
    update();
  });
  close.addEventListener('click', closeArea);
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !active()) return;
    select.value = '';
    reset();
  });
  return { configure, active, pick, redraw, hover, clearHover };
}
