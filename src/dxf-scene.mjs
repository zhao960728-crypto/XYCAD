import { key, name, number, point, raw } from './dxf-parser.mjs';
import { decodeLegacyEscapes } from './cad-text.mjs';
import { fitSplinePath } from './spline-fit.mjs';
import { readMLeaderContext } from './dxf-mleader.mjs';
import { deBoor } from './spline-basis.mjs';

const identity = [1, 0, 0, 1, 0, 0];
const radians = Math.PI / 180;
const palette = ['#e8edf5', '#ff4f57', '#ffe34a', '#53e482', '#46e3e7', '#64a2ff', '#eb76ec', '#e8edf5', '#808080', '#bfbfbf'];

function aciColor(index) {
  if (index < 10) return palette[index] ?? palette[7];
  if (index >= 250) return ['#555555', '#666666', '#808080', '#999999', '#cccccc', '#ffffff'][index - 250] ?? palette[7];
  const hue = Math.floor((index - 10) / 10) / 4;
  const value = [255, 204, 153, 127, 76][Math.floor((index % 10) / 2)];
  const low = index % 2 ? value / 2 : 0;
  const middle = low + (value - low) * (1 - Math.abs(hue % 2 - 1));
  const channels = [[value, middle, low], [middle, value, low], [low, value, middle], [low, middle, value], [middle, low, value], [value, low, middle]][Math.floor(hue)];
  return `#${channels.map(channel => Math.floor(channel).toString(16).padStart(2, '0')).join('')}`;
}

function trueColor(record) {
  const value = number(record, 420);
  return value >= 0 && value <= 0xffffff ? `#${Math.trunc(value).toString(16).padStart(6, '0')}` : null;
}

function packedColor(value, inherited, byLayer) {
  const method = value >>> 24;
  const rgb = value & 0xffffff;
  if (method === 0xc0) return byLayer;
  if (method === 0xc2) return `#${rgb.toString(16).padStart(6, '0')}`;
  if (method === 0xc3 && rgb > 0 && rgb < 256) return aciColor(rgb);
  return inherited;
}

function multiply(first, second) {
  const [a, b, c, d, x, y] = first;
  const [e, f, g, h, u, v] = second;
  return [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h, a * u + c * v + x, b * u + d * v + y];
}

function translate([x, y]) {
  return [1, 0, 0, 1, x, y];
}

function rotate(angle) {
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return [cos, sin, -sin, cos, 0, 0];
}

function words(value) {
  return decodeLegacyEscapes(value).replace(/\^( |J)/g, (_, code) => code === ' ' ? '^' : '\n')
    .replace(/\\U\+([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%([dpcou%]|\d{3})/gi, (_, code) => {
      const codes = { d: '°', p: '±', c: '⌀', o: '', u: '', '%': '%' };
      return codes[code.toLowerCase()] ?? String.fromCharCode(Number(code));
    });
}

export function richText(value, report) {
  let result = '';
  let formatted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '{' || char === '}') continue;
    if (char !== '\\') {
      result += char;
      continue;
    }
    const code = value[index + 1];
    if (code === 'U' && value[index + 2] === '+') {
      result += char;
    } else if (code === 'P' || code === 'X') {
      result += '\n';
      index++;
    } else if (code === '~') {
      result += '\u00a0';
      index++;
    } else if (code === '\\' || code === '{' || code === '}') {
      result += code === '\\' ? '\u0000' : code;
      index++;
    } else if (code && 'LlOoKk'.includes(code)) {
      formatted = true;
      index++;
    } else if (code && 'AaCcFfHhQqSsTtWwp'.includes(code)) {
      const end = value.indexOf(';', index + 2);
      if (end === -1) {
        result += char;
        continue;
      }
      formatted = true;
      if (code === 'S' || code === 's') result += value.slice(index + 2, end).replace(/[\^#]/g, '/');
      index = end;
    } else {
      result += char;
    }
  }
  if (formatted) report('部分 MTEXT 字体、分数或其他格式已简化。');
  if (/%<[^]*?>%/.test(result)) {
    report('含有未求值的文字字段。');
    result = result.replace(/%<[^]*?>%/g, '[未求值字段]');
  }
  return words(result).replaceAll('\u0000', '\\');
}

function verticesFor(entity) {
  if (entity.type === 'POLYLINE') {
    return entity.children.map(vertex => [point(vertex), number(vertex, 42, 0)]);
  }
  const vertices = [];
  let vertex;
  for (const [code, value] of entity.groups) {
    if (code !== 10 && code !== 20 && code !== 42) continue;
    const coordinate = value.trim() ? Number(value) : NaN;
    const valid = Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e12;
    if (code === 10) {
      vertex = [[valid ? coordinate : NaN, NaN], 0];
      vertices.push(vertex);
    } else if (vertex && code === 20) {
      vertex[0][1] = valid ? coordinate : NaN;
    } else if (vertex && valid) {
      vertex[1] = coordinate;
    }
  }
  return vertices;
}

function arcCommand(radius, large, positive, end) {
  return `A ${radius} ${radius} 0 ${Number(large)} ${Number(positive)} ${end.join(' ')}`;
}

export function polylinePath(vertices, closed) {
  const first = vertices[0][0];
  const commands = [`M ${first.join(' ')}`];
  for (let index = 0; index < vertices.length - Number(!closed); index++) {
    const [start, bulge] = vertices[index];
    const [end] = vertices[(index + 1) % vertices.length];
    const chord = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (!chord) continue;
    if (Math.abs(bulge) < 1e-9) {
      commands.push(`L ${end.join(' ')}`);
    } else {
      const radius = chord * (1 + bulge ** 2) / (4 * Math.abs(bulge));
      commands.push(arcCommand(radius, Math.abs(bulge) > 1, bulge > 0, end));
    }
  }
  if (closed) commands.push('Z');
  return commands.join(' ');
}

function hatchPath(entity, availableSegments) {
  const start = entity.groups.findIndex(([code]) => code === 91);
  if (start < 0) return null;
  const loops = [];
  let loop;
  for (let index = start + 1; index < entity.groups.length; index++) {
    const pair = entity.groups[index];
    if (pair[0] === 75) break;
    if (pair[0] === 92) {
      loop = { groups: [] };
      loops.push(loop);
    }
    loop?.groups.push(pair);
  }
  if (loops.length !== number(entity, 91)) return null;

  const style = number(entity, 75, 0);
  const solid = number(entity, 70, 0) === 1 && !number(entity, 450, 0);
  let size = 0;
  const paths = [];
  for (const loop of loops) {
    const flags = number(loop, 92, 0);
    if ((style === 1 && !(flags & 17)) || (style === 2 && !(flags & 1))) continue;
    if (!(flags & 2)) {
      const edges = hatchEdges(loop, availableSegments - size);
      if (!edges) return null;
      size += edges.size;
      paths.push(edges.path);
    } else {
      const vertices = verticesFor(loop);
      if (vertices.length < 2 || vertices.length !== number(loop, 93) ||
          vertices.some(([point]) => !point.every(Number.isFinite))) return null;
      const closed = Boolean(number(loop, 73, 0));
      if (solid && !closed) return null;
      size += vertices.length;
      paths.push(polylinePath(vertices, closed));
    }
    if (size > availableSegments) throw new Error('填充边界超过本版预览容量。');
  }
  return size ? { path: paths.join(' '), size, solid } : null;
}

function hatchEdges(loop, availableSegments) {
  const edges = [];
  let edge;
  for (const pair of loop.groups) {
    if (pair[0] === 72) {
      edge = { groups: [] };
      edges.push(edge);
    }
    edge?.groups.push(pair);
  }
  if (!edges.length || edges.length !== number(loop, 93)) return null;
  const parts = [];
  let start;
  let previous;
  let size = 0;
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;
  for (const edge of edges) {
    const type = number(edge, 72);
    let from = point(edge);
    let to = point(edge, 11);
    let command;
    if (!from) return null;
    if (type === 1 && to) {
      command = 'L ' + to.join(' ');
    } else if (type === 2 || type === 3) {
      if (type === 3 && !to) return null;
      const fraction = number(edge, 40, 0);
      const major = type === 3 ? Math.hypot(...to) : fraction;
      const minor = type === 3 ? major * fraction : major;
      if (major <= 0 || minor <= 0) return null;
      const rotation = type === 3 ? Math.atan2(to[1], to[0]) : 0;
      const startAngle = number(edge, 50);
      const endAngle = number(edge, 51);
      if (startAngle === undefined || endAngle === undefined) return null;
      const ccw = number(edge, 73, 1) === 1;
      const delta = endAngle - startAngle;
      const sweep = Math.abs(delta) >= 360 - 1e-9 ? 360 : ((delta % 360) + 360) % 360;
      const center = from;
      const at = angle => {
        const direction = (ccw ? angle : -angle) * radians;
        // Hatch angles are polar angles measured from the major axis.
        const parameter = type === 3 ? Math.atan2(Math.sin(direction), fraction * Math.cos(direction)) : direction;
        const u = major * Math.cos(parameter), v = minor * Math.sin(parameter);
        return [center[0] + u * Math.cos(rotation) - v * Math.sin(rotation),
          center[1] + u * Math.sin(rotation) + v * Math.cos(rotation)];
      };
      from = at(startAngle);
      to = at(endAngle);
      const arc = (target, large) => ['A', major, minor, rotation / radians, Number(large), Number(ccw), ...target].join(' ');
      command = sweep === 360 ? arc(at(startAngle + 180), false) + ' ' + arc(to, false) : arc(to, sweep > 180);
    } else if (type === 4) {
      const codes = new Map([[94, 71], [10, 10], [20, 20], [40, 40], [42, 41]]);
      const groups = edge.groups.filter(([code]) => codes.has(code)).map(([code, value]) => [codes.get(code), value]);
      const curve = splinePath({ type: 'SPLINE', groups }, availableSegments - size);
      if (!curve || !curve.continuous) return null;
      from = curve.start;
      to = curve.end;
      command = curve.segments.join(' ');
      size += curve.size - 1;
    } else {
      return null;
    }
    if (++size > availableSegments) throw new Error('填充边界超过本版预览容量。');
    if (previous && !near(previous, from)) return null;
    if (!start) {
      start = from;
      parts.push('M ' + from.join(' '));
    }
    parts.push(command);
    previous = to;
  }
  if (!near(start, previous)) return null;
  return { path: parts.join(' ') + ' Z', size };
}

function approximateSplineSpan(evaluate, from, to, start, end, availableSegments) {
  const segments = [];
  function split(left, right, a, b, depth) {
    const tests = [0.25, 0.5, 0.75].map(fraction => {
      const point = evaluate(left + (right - left) * fraction);
      return { point, error: Math.hypot(...point.map((value, axis) => value - a[axis] - (b[axis] - a[axis]) * fraction)) };
    });
    const tolerance = Math.min(0.005, Math.max(1e-7, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.001));
    if (tests.some(({ error }) => !Number.isFinite(error))) return false;
    if (tests.some(({ error }) => error > tolerance)) {
      if (depth === 16) return false;
      const middle = (left + right) / 2;
      return split(left, middle, a, tests[1].point, depth + 1) && split(middle, right, tests[1].point, b, depth + 1);
    }
    if (segments.length >= availableSegments) throw new Error('样条曲线段数超过本版预览容量。');
    segments.push('L ' + b.join(' '));
    return true;
  }
  return split(from, to, start, end, 0) ? segments : null;
}

export function splinePath(entity, availableSegments) {
  const degree = number(entity, 71);
  const control = verticesFor(entity).map(([xy]) => xy);
  const knots = entity.groups.filter(([code]) => code === 40).map(([, value]) => Number(value));
  const weights = entity.groups.filter(([code]) => code === 41).map(([, value]) => Number(value));
  if (!control.length && !knots.length) return fitSplinePath(entity, availableSegments);
  if (!Number.isInteger(degree) || degree < 1 || degree > 25 || control.length <= degree ||
      control.some(xy => !xy.every(Number.isFinite)) || knots.length !== control.length + degree + 1 ||
      knots.some((knot, index) => !Number.isFinite(knot) || Math.abs(knot) > 1e12 || knot < knots[index - 1]) ||
      (weights.length && (weights.length !== control.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0)))) return null;
  const rational = weights.some(weight => weight !== weights[0]);
  const values = rational ? control.map(([x, y], index) => {
    const weight = weights[index];
    return [x * weight, y * weight, weight];
  }) : control;
  if (values.some(point => !point.every(Number.isFinite))) return null;

  function evaluate(span, parameter) {
    const point = deBoor(values, knots, degree, span, parameter);
    return rational ? [point[0] / point[2], point[1] / point[2]] : point;
  }

  const commands = [];
  let start;
  let previous;
  let continuous = true;
  let size = 0;
  for (let span = degree; span < control.length; span++) {
    const from = knots[span];
    const to = knots[span + 1];
    if (from === to) continue;
    const a = evaluate(span, from);
    const b = evaluate(span, to);
    if (![...a, ...b].every(Number.isFinite)) return null;
    if (!start) start = a;
    if (!previous || Math.hypot(a[0] - previous[0], a[1] - previous[1]) > 1e-9) {
      if (previous) continuous = false;
      commands.push('M ' + a.join(' '));
    }
    if (rational || degree > 3) {
      const segments = approximateSplineSpan(t => evaluate(span, t), from, to, a, b, availableSegments - size);
      if (!segments) return null;
      size += segments.length;
      for (const segment of segments) commands.push(segment);
    } else if (degree === 1) {
      size++;
      commands.push('L ' + b.join(' '));
    } else {
      size++;
      // A quadratic or cubic knot span is exactly a cubic Bézier. Recover its
      // control points from the values at one third and two thirds of the span.
      const atOneThird = evaluate(span, from + (to - from) / 3);
      const atTwoThirds = evaluate(span, from + 2 * (to - from) / 3);
      const u = a.map((value, axis) => 27 * (atOneThird[axis] - value) - (b[axis] - value));
      const v = a.map((value, axis) => 27 * (atTwoThirds[axis] - value) - 8 * (b[axis] - value));
      const first = a.map((value, axis) => value + (2 * u[axis] - v[axis]) / 18);
      const second = a.map((value, axis) => value + (2 * v[axis] - u[axis]) / 18);
      commands.push(['C', ...first, ...second, ...b].join(' '));
    }
    if (size > availableSegments) throw new Error('样条曲线段数超过本版预览容量。');
    previous = b;
  }
  return size ? { path: commands.join(' '), size, start, end: previous, continuous, segments: commands.slice(1) } : null;
}

function wipeoutShape(entity, frame) {
  if (!(number(entity, 70, 7) & 1)) return null;
  const origin = point(entity), u = point(entity, 11), v = point(entity, 12);
  const size = point(entity, 13);
  if (!origin || !u || !v || !size?.every(value => value > 0) ||
      Math.abs(u[0] * v[1] - u[1] * v[0]) === 0) return null;
  const type = number(entity, 71, 1);
  const image = [[-0.5, -0.5], [size[0] - 0.5, size[1] - 0.5]];
  let boundary = image;
  const clipped = Boolean(number(entity, 70, 7) & 4) && Boolean(number(entity, 280, 1));
  if (clipped) {
    boundary = [];
    for (const [code, value] of entity.groups) {
      if (code === 14) boundary.push([Number(value), NaN]);
      if (code === 24 && boundary.length) boundary.at(-1)[1] = Number(value);
    }
    if (boundary.length > 8192 || (type === 1 ? boundary.length !== 2 : type !== 2 || boundary.length < 3) ||
        boundary.some(point => !point.every(value => Number.isFinite(value) && Math.abs(value) <= 1e12))) return null;
  }
  const rectangle = ([[x1, y1], [x2, y2]]) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  const outline = coordinates => {
    const points = coordinates.map(([x, y]) => origin.map((value, axis) =>
      value + (x + 0.5) * u[axis] + (size[1] - 0.5 - y) * v[axis]));
    if (points.some(point => !point.every(value => Number.isFinite(value) && Math.abs(value) <= 1e12))) return '';
    return 'M ' + points.map(point => point.join(' ')).join(' L ') + ' Z';
  };
  const edge = outline(boundary.length === 2 ? rectangle(boundary) : boundary);
  const inverse = clipped && number(entity, 290, 0) === 1;
  const outer = inverse ? outline(rectangle(image)) : '';
  return edge && (!inverse || outer) ? { kind: 'wipeout', path: outer ? outer + ' ' + edge : edge,
    frame: frame ? edge : '', size: Math.max(4, boundary.length) + (inverse ? 4 : 0) } : null;
}

function textShape(entity, document, report) {
  const styleName = name(entity, 7, 'STANDARD');
  const style = document.tables.get('STYLE')?.get(key(styleName));
  const font = name(style, 3);
  const bigFont = name(style, 4);
  if (font || bigFont) report('DXF 指定的字体用系统字体代替，请核对字宽和特殊符号。');
  const multi = entity.type === 'MTEXT';
  const content = multi
    ? richText(entity.groups.filter(([code]) => code === 3 || code === 1).map(([, value]) => value).join(''), report)
    : words(raw(entity, 1) ?? '');
  if (!content.trim()) return null;
  if (content.includes('\ufffd')) report('文字含无法解码的字符。');
  const height = number(entity, 40, number(style, 40, 0));
  let origin = point(entity);
  if (!(height > 0) || !origin) return null;

  if (multi) {
    const attachment = Math.max(0, Math.min(8, Math.trunc(number(entity, 71, 1)) - 1));
    const direction = point(entity, 11);
    const directionIndex = entity.groups.findLastIndex(([code]) => code === 11);
    const angleIndex = entity.groups.findLastIndex(([code]) => code === 50);
    const angle = direction && directionIndex > angleIndex
      ? Math.atan2(direction[1], direction[0]) : number(entity, 50, 0) * radians;
    if (number(entity, 72, 1) === 3) report('竖排 MTEXT 已按横排显示。');
    return { kind: 'text', content, height, origin, angle, anchor: ['start', 'middle', 'end'][attachment % 3],
      vertical: ['top', 'middle', 'bottom'][Math.floor(attachment / 3)], maxWidth: number(entity, 41, 0),
      spacing: Math.max(0.25, Math.min(4, number(entity, 44, 1))) };
  }

  const horizontal = number(entity, 72, 0);
  const vertical = number(entity, entity.type === 'TEXT' ? 73 : 74, 0);
  const aligned = horizontal === 3 || horizontal === 5;
  const other = point(entity, 11);
  let angle = number(entity, 50, 0) * radians;
  let length;
  if (aligned && other) {
    length = Math.hypot(other[0] - origin[0], other[1] - origin[1]);
    angle = Math.atan2(other[1] - origin[1], other[0] - origin[0]);
  } else if (horizontal || vertical) {
    origin = other ?? origin;
  }
  const flags = number(entity, 71, 0);
  return { kind: 'text', content, height, origin, angle, length,
    scaleHeight: horizontal === 3,
    widthScale: Math.max(0.01, number(entity, 41, number(style, 41, 1))) * (flags & 2 ? -1 : 1),
    heightScale: flags & 4 ? -1 : 1, oblique: number(entity, 51, number(style, 50, 0)),
    anchor: horizontal === 1 || horizontal === 4 ? 'middle' : horizontal === 2 ? 'end' : 'start',
    vertical: horizontal === 4 ? 'middle' : (['baseline', 'bottom', 'middle', 'top'][vertical] ?? 'baseline') };
}

function line(start, end) {
  return { kind: 'line', start, end };
}

function blockPlacement(matrix, block, origin, angle, scale = 1) {
  const [x, y] = point(block.record) ?? [0, 0];
  return multiply(multiply(multiply(matrix, translate(origin)), rotate(angle)), [scale, 0, 0, scale, -x * scale, -y * scale]);
}

function tableLayout(entity, report) {
  const marker = entity.groups.findIndex(([code, value]) => code === 100 && value.trim() === 'AcDbTable');
  const groups = entity.groups.slice(marker + 1);
  const header = { groups: [] };
  const cells = [];
  let cell;
  for (const pair of groups) {
    if (pair[0] === 171) {
      cell = { groups: [] };
      cells.push(cell);
    }
    (cell ?? header).groups.push(pair);
  }
  const rows = number(header, 91);
  const columns = number(header, 92);
  if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows * columns > 4000) return null;
  const sizes = code => header.groups.filter(([tag]) => tag === code).map(([, value]) => Number(value));
  const widths = sizes(142);
  const heights = sizes(141);
  if (widths.length !== columns || heights.length !== rows ||
      [...widths, ...heights].some(value => !(value > 0 && value <= 1e12))) return null;

  const offsets = (values, sign) => {
    const result = [0];
    for (const value of values) result.push(result.at(-1) + value * sign);
    return result;
  };
  const x = offsets(widths, 1);
  const y = offsets(heights, -1);
  const grid = [
    ...x.map(position => ['M', position, 0, 'L', position, y.at(-1)].join(' ')),
    ...y.map(position => ['M', 0, position, 'L', x.at(-1), position].join(' ')),
  ];
  const labels = [];
  for (let index = 0; index < Math.min(cells.length, rows * columns); index++) {
    const record = cells[index];
    if (number(record, 171, 1) !== 1) continue;
    const value = name(record, 344)
      ? '[未求值字段]'
      : record.groups.filter(([code]) => code === 1 || code === 2 || code === 3).map(([, value]) => value).join('') || raw(record, 302) || '';
    const content = richText(value, report);
    if (!content.trim()) continue;
    const row = Math.floor(index / columns);
    const column = index % columns;
    const alignment = Math.max(0, Math.min(8, Math.trunc(number(record, 170, 5)) - 1));
    const horizontal = alignment % 3;
    const vertical = Math.floor(alignment / 3);
    const height = number(record, 140, number(header, 140, heights[row] * 0.35));
    const margin = Math.min(widths[column], heights[row]) * 0.06;
    if (height <= 0) continue;
    labels.push({ kind: 'text', content, height, angle: number(record, 145, 0), maxWidth: widths[column] - 2 * margin,
      origin: [[x[column] + margin, (x[column] + x[column + 1]) / 2, x[column + 1] - margin][horizontal],
        [y[row] - margin, (y[row] + y[row + 1]) / 2, y[row + 1] + margin][vertical]],
      anchor: ['start', 'middle', 'end'][horizontal], vertical: ['top', 'middle', 'bottom'][vertical] });
  }
  return { grid: grid.join(' '), size: grid.length, labels };
}

function fallbackDimension(entity, document) {
  const type = number(entity, 70, 0) & 15;
  const first = point(entity, 13);
  const second = point(entity, 14);
  const offset = point(entity);
  if (type > 1 || !first || !second || !offset || number(entity, 52, 0)) return null;
  const dx = second[0] - first[0];
  const dy = second[1] - first[1];
  const angle = type === 0 ? number(entity, 50, 0) * radians : Math.atan2(dy, dx);
  const normal = [-Math.sin(angle), Math.cos(angle)];
  const project = ([x, y]) => {
    const distance = (offset[0] - x) * normal[0] + (offset[1] - y) * normal[1];
    return [x + normal[0] * distance, y + normal[1] * distance];
  };
  const a = project(first);
  const b = project(second);
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (span < 1e-9) return null;
  const style = document.tables.get('DIMSTYLE')?.get(key(name(entity, 3, 'STANDARD')));
  const setting = (code, variable, headerCode, fallback) => number(style, code, number(document.header.get(variable), headerCode, fallback));
  const factor = setting(144, '$DIMLFAC', 40, 1);
  const actual = number(entity, 42, span);
  const measured = (actual >= 0 ? actual : span) * (factor > 0 ? factor : 1);
  const decimalPlaces = Math.max(0, Math.min(8, Math.trunc(setting(271, '$DIMDEC', 70, 2))));
  const suppression = setting(78, '$DIMZIN', 70, 8);
  const override = raw(entity, 1);
  const prefixSuffix = override || raw(style, 3) || raw(document.header.get('$DIMPOST'), 1) || '<>';
  let label = prefixSuffix;
  if (prefixSuffix.includes('<>')) {
    if (![0, 2].includes(setting(277, '$DIMLUNIT', 70, 2))) {
      label = prefixSuffix.replaceAll('<>', '[核对标注]');
    } else {
      const round = setting(45, '$DIMRND', 40, 0);
      let value = (round > 0 ? Math.round(measured / round) * round : measured).toFixed(decimalPlaces);
      if (suppression & 8 && value.includes('.')) value = value.replace(/\.?0+$/, '');
      if (suppression & 4) value = value.replace(/^(-?)0\./, '$1.');
      const separator = setting(278, '$DIMDSEP', 70, 46);
      label = prefixSuffix.replaceAll('<>', value.replace('.', String.fromCharCode(separator || 46)));
    }
  }
  const scale = setting(40, '$DIMSCALE', 40, 1) || 1;
  const configuredHeight = setting(140, '$DIMTXT', 40, 0) * scale;
  const height = configuredHeight > 0 ? configuredHeight : span / 24;
  const center = [(a[0] + b[0]) / 2 + normal[0] * height * 0.45, (a[1] + b[1]) / 2 + normal[1] * height * 0.45];
  const shapes = [line(first, a), line(second, b), line(a, b)];
  const arrowLength = Math.min(span / 4, Math.max(height / 2, setting(41, '$DIMASZ', 40, height) * scale));
  const arrow = (tip, toward) => {
    const x = tip[0] + (toward[0] - tip[0]) * arrowLength / span;
    const y = tip[1] + (toward[1] - tip[1]) * arrowLength / span;
    const wing = arrowLength / 6;
    return { kind: 'fill', vertices: [tip, [x + normal[0] * wing, y + normal[1] * wing], [x - normal[0] * wing, y - normal[1] * wing]] };
  };
  shapes.push(arrow(a, b), arrow(b, a));
  if (label.trim()) shapes.push({ kind: 'text', content: words(label.replaceAll('\\X', '\n')), origin: point(entity, 11) ?? center,
    height, angle: (Math.cos(angle) < -1e-9 ? angle + Math.PI : angle) + number(entity, 53, 0) * radians, anchor: 'middle', vertical: 'middle' });
  return shapes;
}

export function buildScene(document, { entityLimit = 30000, geometryLimit = 180000, textLimit = 300000 } = {}) {
  const layers = new Map();
  const issues = new Map();
  const items = [];
  let visits = 0;
  let segmentCount = 0;
  let textCount = 0;
  const report = message => issues.set(message, (issues.get(message) ?? 0) + 1);
  document.warnings.forEach(report);
  const blockByHandle = new Map();
  let textStyleNames;
  for (const [id, block] of document.blocks) {
    const handle = name(block.record, 330);
    if (handle) blockByHandle.set(key(handle), { id, block });
  }

  function layerFor(layerName, record) {
    const id = key(layerName);
    if (!layers.has(id)) {
      if (layers.size >= 4000) throw new Error('图层数量超过本版预览容量。');
      const aci = number(record, 62, 7);
      layers.set(id, { id, name: layerName, color: trueColor(record) ?? aciColor(Math.abs(Math.trunc(aci))),
        visible: aci >= 0 && !(number(record, 70, 0) & 1), linetype: name(record, 6, 'CONTINUOUS'), count: 0 });
    }
    return layers.get(id);
  }

  for (const record of document.tables.get('LAYER')?.values() ?? []) layerFor(name(record, 2), record);

  function emit(shape, context, size = 1) {
    if (items.length >= entityLimit || segmentCount + size > geometryLimit) throw new Error('展开后的图纸超过本版预览容量。请拆分图纸后再试。');
    if (shape.kind === 'text') {
      if (shape.content.length > 16384 || textCount + shape.content.length > textLimit) throw new Error('图纸文字数量超过本版预览容量。');
      textCount += shape.content.length;
    }
    segmentCount += size;
    items.push({ ...shape, matrix: context.matrix, layerIds: context.layerIds, color: context.color, dash: context.dash });
    layers.get(context.layerId).count++;
  }

  function renderMLeader(entity, context, stack, layerColor) {
    const decoded = readMLeaderContext(entity);
    if (!decoded) return report('有多重引线缺少有效的上下文。');
    const { context: annotation, properties } = decoded;
    const style = document.mleaderStyles?.get(key(name(properties, 340)));
    const type = number(properties, 170, number(style, 173, 1));
    const arrowSize = number(annotation, 140, number(properties, 42, number(style, 44, 0)));
    const arrowHandle = name(properties, 342, name(style, 341));
    const dogleg = number(properties, 290, number(style, 290, 1)) && number(properties, 291, number(style, 291, 1));
    const leaderColor = packedColor(number(properties, 91, number(style, 91)), context.color, layerColor);
    for (const branch of annotation.branches) {
      const elbow = number(branch, 290, 1) ? point(branch) : null;
      const direction = point(branch, 11);
      let visible = false;
      for (const entry of branch.lines) {
        const flags = number(entry, 93, 0);
        const lineType = flags & 1 ? number(entry, 170, type) : type;
        if (!lineType) continue;
        const vertices = verticesFor(entry);
        if (!vertices.length || vertices.some(([xy]) => !xy.every(Number.isFinite))) continue;
        if (elbow && vertices.at(-1)[0].some((value, axis) => value !== elbow[axis])) vertices.push([elbow, 0]);
        if (vertices.length < 2) continue;
        visible = true;
        if (lineType === 2) report('样条多重引线按顶点折线显示。');
        if (entry.groups.some(([code]) => code === 11) || branch.groups.some(([code]) => code === 12)) {
          report('多重引线的断口暂按连续线显示。');
        }
        const color = flags & 2 ? packedColor(number(entry, 92), leaderColor, layerColor) : leaderColor;
        const paint = { ...context, color };
        const tip = vertices[0][0];
        const next = vertices.find(([xy]) => Math.hypot(xy[0] - tip[0], xy[1] - tip[1]) > 1e-9)?.[0];
        const size = flags & 16 ? number(entry, 40, arrowSize) : arrowSize;
        const id = flags & 32 ? name(entry, 341) : arrowHandle;
        const length = next ? Math.hypot(next[0] - tip[0], next[1] - tip[1]) : 0;
        // The default arrow is suppressed when the first segment is shorter than two arrow sizes.
        if (size > 0 && length >= 2 * size) {
          const dx = (next[0] - tip[0]) / length, dy = (next[1] - tip[1]) / length;
          const picture = blockByHandle.get(key(id));
          if (picture?.block.entities.length && !stack.includes(picture.id) && stack.length < 24) {
            const matrix = blockPlacement(context.matrix, picture.block, tip, Math.atan2(dy, dx) + Math.PI, size);
            for (const child of picture.block.entities) render(child, { ...paint, matrix }, [...stack, picture.id]);
          } else {
            if (id && id !== '0') report('多重引线的箭头块不可用，已使用普通实心箭头。');
            const base = [tip[0] + size * dx, tip[1] + size * dy];
            const wing = size / 6;
            emit({ kind: 'fill', vertices: [[base[0] + dy * wing, base[1] - dx * wing], tip,
              [base[0] - dy * wing, base[1] + dx * wing]] }, paint);
            if (next === vertices[1][0]) vertices[0] = [base, 0];
          }
        }
        emit({ kind: 'path', path: polylinePath(vertices, false) }, paint, vertices.length - 1);
      }
      if (visible && dogleg && elbow && direction && number(branch, 291, 1)) {
        const length = number(branch, 40, 0);
        if (length > 0) emit(line(elbow, elbow.map((value, i) => value + direction[i] * length)), { ...context, color: leaderColor });
      }
    }
    if (number(annotation, 296, 0)) report('暂未显示多重引线的块内容。');
    if (!number(annotation, 290, 0)) return;
    const textStyle = key(name(annotation, 340, name(properties, 343, name(style, 342))));
    textStyleNames ??= new Map([...(document.tables.get('STYLE') ?? [])].map(([nameKey, record]) => [key(name(record, 5)), nameKey]));
    const groups = [[1, raw(annotation, 304) ?? ''], [7, textStyleNames.get(textStyle) ?? 'STANDARD'],
      [40, String(number(annotation, 41, 0))], [71, String(number(annotation, 171, 1))]];
    for (const [target, source] of [[10, 12], [20, 22], [11, 13], [21, 23], [41, 43], [44, 45]]) {
      const value = raw(annotation, source);
      if (value !== undefined) groups.push([target, value]);
    }
    const shape = textShape({ type: 'MTEXT', groups }, document, report);
    if (shape) emit(shape, { ...context, color: packedColor(number(annotation, 90), context.color, layerColor) });
  }

  function render(entity, parent, stack, inDimension = false) {
    if (++visits > entityLimit * 2) throw new Error('展开后的图元数量过多。请拆分图纸后再试。');
    if (number(entity, 60, 0) === 1) return;
    const originalLayer = name(entity, 8, '0');
    if (inDimension && entity.type === 'POINT' && key(originalLayer) === 'DEFPOINTS') return;
    const layer = layerFor(originalLayer === '0' && parent.layer ? parent.layer : originalLayer);
    const layerIds = parent.layerIds.includes(layer.id) ? parent.layerIds : [...parent.layerIds, layer.id];
    const aci = Math.abs(Math.trunc(number(entity, 62, 256)));
    const color = trueColor(entity) ?? (aci === 256 ? layer.color : aci === 0 ? parent.color : aciColor(aci));
    const linetype = key(name(entity, 6, 'BYLAYER'));
    const resolvedType = linetype === 'BYLAYER' ? key(layer.linetype) : linetype === 'BYBLOCK' ? parent.linetype : linetype;
    const pattern = document.tables.get('LTYPE')?.get(resolvedType);
    const hasGaps = pattern?.groups.some(([code, value]) => code === 49 && Number(value) < 0);
    const dash = hasGaps || /DASH|HIDDEN|CENTER|PHANTOM|DOT/.test(resolvedType);
    let matrix = parent.matrix;
    const nz = number(entity, 230, 1);
    // Planar DWG inserts can carry residual X/Y values from a floating point transform.
    const normalTolerance = entity.type === 'INSERT' ? Math.abs(nz) * 1e-12 : 0;
    const tilted = Math.abs(number(entity, 210, 0)) > normalTolerance ||
      Math.abs(number(entity, 220, 0)) > normalTolerance || !nz;
    const isDimension = entity.type === 'DIMENSION' || entity.type === 'LARGE_RADIAL_DIMENSION' || entity.type === 'ARC_DIMENSION';
    const inWcs = isDimension || ['LINE', 'POINT', '3DFACE', 'ELLIPSE', 'MTEXT', 'LEADER', 'MULTILEADER', 'WIPEOUT'].includes(entity.type);
    if (tilted || (nz < 0 && (isDimension || entity.type === 'MTEXT'))) {
      report(`暂未显示非标准平面的 ${entity.type}。`);
      return;
    }
    if (!inWcs && nz < 0) matrix = multiply(matrix, [-1, 0, 0, 1, 0, 0]);
    const context = { matrix, layer: layer.name, layerId: layer.id, layerIds, color, linetype: resolvedType, dash };
    const start = point(entity);
    const end = point(entity, 11);

    switch (entity.type) {
      case 'MULTILEADER':
        return renderMLeader(entity, context, stack, layer.color);
      case 'LINE':
        if (start && end) return emit(line(start, end), context);
        break;
      case 'CIRCLE':
      case 'ARC': {
        const radius = number(entity, 40, 0);
        if (!start || radius <= 0) break;
        if (entity.type === 'CIRCLE') return emit({ kind: 'circle', center: start, radius }, context);
        const from = number(entity, 50, 0);
        const to = number(entity, 51, 0);
        const sweep = ((to - from) % 360 + 360) % 360;
        if (!sweep && to !== from) return emit({ kind: 'circle', center: start, radius }, context);
        if (!sweep) break;
        const at = angle => [start[0] + radius * Math.cos(angle * radians), start[1] + radius * Math.sin(angle * radians)];
        return emit({ kind: 'path', path: `M ${at(from).join(' ')} ${arcCommand(radius, sweep > 180, true, at(to))}`,
          arc: { center: start, radius, start: from * radians, sweep: sweep * radians } }, context);
      }
      case 'ELLIPSE': {
        const ratio = number(entity, 40, 0);
        if (!start || !end || ratio <= 0 || ratio > 1 || (!end[0] && !end[1])) break;
        const radius = Math.hypot(...end);
        const minor = radius * ratio;
        const angle = Math.atan2(end[1], end[0]);
        const from = number(entity, 41, 0);
        const to = number(entity, 42, Math.PI * 2);
        const local = { ...context, matrix: multiply(multiply(matrix, translate(start)), rotate(angle)) };
        if (Math.abs(to - from) >= 2 * Math.PI - 1e-9) return emit({ kind: 'ellipse', radius, minor }, local);
        const sweep = ((to - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        if (!sweep) break;
        const at = parameter => `${radius * Math.cos(parameter)} ${minor * Math.sin(parameter)}`;
        return emit({ kind: 'path', path: `M ${at(from)} A ${radius} ${minor} 0 ${Number(sweep > Math.PI)} 1 ${at(to)}` }, local);
      }
      case 'POLYLINE':
      case 'LWPOLYLINE': {
        const flags = number(entity, 70, 0);
        if (entity.type === 'POLYLINE' && flags & (2 | 4 | 8 | 16 | 64)) {
          report('暂未显示曲线拟合或三维 POLYLINE。');
          return;
        }
        const vertices = verticesFor(entity);
        if (vertices.length < 2 || vertices.some(([xy]) => !xy?.every(Number.isFinite))) break;
        if (vertices.length > geometryLimit - segmentCount) throw new Error('多段线顶点数量超过本版预览容量。');
        const closed = Boolean(flags & 1);
        const path = polylinePath(vertices, closed);
        const polyline = { vertices, closed };
        const hasWidth = record => record.groups.some(([code, value]) => (code === 40 || code === 41) && Number(value));
        const hasVertexWidths = hasWidth(entity) || entity.children?.some(hasWidth);
        const width = entity.type === 'LWPOLYLINE' ? number(entity, 43, 0) : 0;
        if (width > 0 && !hasVertexWidths) return emit({ kind: 'widePath', path, width, polyline }, context, vertices.length);
        if (hasVertexWidths) report('带独立顶点宽度或旧式宽度的多段线按中心线显示。');
        return emit({ kind: 'path', path, polyline }, context, vertices.length);
      }
      case 'SPLINE': {
        const spline = splinePath(entity, geometryLimit - segmentCount);
        if (spline) return emit({ kind: 'path', path: spline.path }, context, spline.size);
        report('有样条曲线缺少有效控制点，或其阶数、权重暂不支持。');
        return;
      }
      case 'WIPEOUT': {
        const wipeout = wipeoutShape(entity, document.wipeoutFrame ?? 1);
        if (wipeout) emit(wipeout, context, wipeout.size);
        else if (number(entity, 70, 7) & 1) report('有遮罩缺少有效边界。');
        return;
      }
      case 'HATCH': {
        const hatch = hatchPath(entity, geometryLimit - segmentCount);
        if (!hatch) {
          report('有填充的边界暂无法显示。');
          return;
        }
        if (!hatch.solid) {
          report('图案或渐变填充暂按边界显示。');
          return emit({ kind: 'path', path: hatch.path }, context, hatch.size);
        }
        const transparency = number(entity, 440, 0);
        const opacity = (transparency >>> 24) === 2 ? (transparency & 255) / 255 : 1;
        return emit({ kind: 'filledPath', path: hatch.path, opacity }, context, hatch.size);
      }
      case 'SOLID':
      case 'TRACE':
      case '3DFACE': {
        const third = point(entity, 12);
        const fourth = point(entity, 13);
        if (!start || !end || !third) break;
        const vertices = entity.type === '3DFACE' ? [start, end, third, fourth ?? third] : [start, end, fourth ?? third, third];
        return emit({ kind: entity.type === '3DFACE' ? 'outline' : 'fill', vertices }, context);
      }
      case 'TEXT':
      case 'MTEXT':
      case 'ATTDEF':
      case 'ATTRIB': {
        if (entity.type === 'ATTDEF' && !(number(entity, 70, 0) & 2)) return;
        if ((entity.type === 'ATTDEF' || entity.type === 'ATTRIB') && number(entity, 70, 0) & 1) return;
        if (entity.type === 'MTEXT' && (number(entity, 90, 0) & 1)) report('多行文字的背景填充在网页中省略。');
        const shape = textShape(entity, document, report);
        if (shape) emit(shape, context);
        return;
      }
      case 'POINT':
        if (start) return emit({ kind: 'point', center: start }, context);
        break;
      case 'LEADER': {
        const vertices = verticesFor(entity);
        if (vertices.length < 2 || vertices.some(([xy]) => !xy.every(Number.isFinite))) break;
        if (vertices.length > geometryLimit - segmentCount) throw new Error('引线顶点数量超过本版预览容量。');
        const style = document.tables.get('DIMSTYLE')?.get(key(name(entity, 3, 'STANDARD')));
        const arrowSize = number(style, 41, number(document.header.get('$DIMASZ'), 40, 0))
          * (number(style, 40, number(document.header.get('$DIMSCALE'), 40, 1)) || 1);
        if (number(entity, 72, 0) === 1) report('样条引线按顶点折线显示。');
        if (number(entity, 75, 0)) {
          const direction = point(entity, 211) ?? [1, 0];
          const length = Math.hypot(...direction);
          const [x, y] = vertices.at(-1)[0];
          const [priorX, priorY] = vertices.at(-2)[0];
          const dx = x - priorX, dy = y - priorY;
          const hasHook = Math.hypot(dx, dy) > 0 && Math.abs(dx * direction[1] - dy * direction[0]) <= 1e-9 * length * Math.hypot(dx, dy);
          if (!hasHook && length && arrowSize > 0) {
            const offset = (number(entity, 74, 1) ? 1 : -1) * arrowSize / length;
            vertices.push([[x + direction[0] * offset, y + direction[1] * offset], 0]);
            report('引线的水平连接段按标注样式近似显示。');
          }
        }
        emit({ kind: 'path', path: polylinePath(vertices, false) }, context, vertices.length);
        if (!number(entity, 71, 1)) return;
        const [tip] = vertices[0];
        const next = vertices.find(([xy]) => Math.hypot(xy[0] - tip[0], xy[1] - tip[1]) > 1e-9)?.[0];
        if (!next) return;
        if (!(arrowSize > 0)) {
          report('引线缺少有效的箭头尺寸，已显示引线路径。');
          return;
        }
        const angle = Math.atan2(next[1] - tip[1], next[0] - tip[0]);
        const arrowHandle = name(style, 341);
        const picture = blockByHandle.get(key(arrowHandle));
        if (picture?.block.entities.length && !stack.includes(picture.id) && stack.length < 24) {
          const arrow = { ...context, matrix: blockPlacement(matrix, picture.block, tip, angle + Math.PI, arrowSize) };
          for (const child of picture.block.entities) render(child, arrow, [...stack, picture.id], inDimension);
        } else {
          if (arrowHandle && arrowHandle !== '0') report('引线箭头块不可用，已使用普通实心箭头。');
          const direction = [Math.cos(angle), Math.sin(angle)];
          const base = tip.map((value, axis) => value + arrowSize * direction[axis]);
          const wing = arrowSize / 6;
          emit({ kind: 'fill', vertices: [tip, [base[0] - direction[1] * wing, base[1] + direction[0] * wing],
            [base[0] + direction[1] * wing, base[1] - direction[0] * wing]] }, context);
        }
        return;
      }
      case 'ACAD_TABLE': {
        if (!start) break;
        const angle = end ? Math.atan2(end[1], end[0]) : 0;
        const id = key(name(entity, 2));
        const block = document.blocks.get(id);
        if (block?.entities.length && !stack.includes(id) && stack.length < 24) {
          const table = { ...context, matrix: blockPlacement(matrix, block, start, angle) };
          for (const child of block.entities) render(child, table, [...stack, id], inDimension);
          return;
        }
        const layout = tableLayout(entity, report);
        if (!layout) {
          report('表格缺少可用的图形块或行列尺寸，无法显示。');
          return;
        }
        report('表格缺少原始图形块，已简化显示网格和文字。');
        const table = { ...context, matrix: multiply(multiply(matrix, translate(start)), rotate(angle)) };
        emit({ kind: 'path', path: layout.grid }, table, layout.size);
        for (const label of layout.labels) emit(label, table);
        return;
      }
      case 'INSERT':
      case 'LARGE_RADIAL_DIMENSION':
      case 'ARC_DIMENSION':
      case 'DIMENSION': {
        const blockName = name(entity, 2);
        const id = key(blockName);
        const block = document.blocks.get(id);
        if (stack.includes(id) || stack.length >= 24) {
          report('检测到块循环引用或嵌套过深，已跳过。');
          return;
        }
        if (isDimension) {
          if (block?.entities.length) {
            for (const child of block.entities) render(child, context, [...stack, id], true);
          } else {
            const shapes = fallbackDimension(entity, document);
            if (shapes) {
              report('有尺寸缺少原始标注块，已按定义点近似重建，请核对。');
              for (const shape of shapes) emit(shape, context);
            } else {
              report('有尺寸缺少原始标注块，无法重建。');
            }
          }
          return;
        }
        if (!block || number(block.record, 70, 0) & 12) {
          report(`块或外部参照不可用：${blockName || '未命名'}`);
        } else if (start) {
          const [baseX, baseY] = point(block.record) ?? [0, 0];
          const sx = number(entity, 41, 1);
          const sy = number(entity, 42, 1);
          const rotation = rotate(number(entity, 50, 0) * radians);
          const rows = Math.max(1, Math.trunc(number(entity, 71, 1)));
          const columns = Math.max(1, Math.trunc(number(entity, 70, 1)));
          if (rows * columns > 4096) throw new Error('阵列块数量超过本版预览容量。');
          const rowSpacing = number(entity, 45, 0);
          const columnSpacing = number(entity, 44, 0);
          const placement = multiply(multiply(matrix, translate(start)), rotation);
          for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
              const insertMatrix = multiply(placement, [sx, 0, 0, sy, column * columnSpacing - sx * baseX, row * rowSpacing - sy * baseY]);
              if (insertMatrix.some(value => !Number.isFinite(value) || Math.abs(value) > 1e15)) {
                report('有块的坐标变换超出预览范围。');
                continue;
              }
              for (const child of block.entities) render(child, { ...context, matrix: insertMatrix }, [...stack, id], inDimension);
            }
          }
          if ((rows > 1 || columns > 1) && entity.children.length) report('阵列块的属性文字仅显示首组。');
        }
        for (const attribute of entity.children) render(attribute, context, stack, inDimension);
        return;
      }
      default:
        report(`暂未显示 ${entity.type} 图元。`);
        return;
    }
    report(`有 ${entity.type} 图元缺少有效几何。`);
  }

  const root = { matrix: identity, layerIds: [], color: palette[7], linetype: 'CONTINUOUS' };
  for (const entity of document.entities) {
    if (number(entity, 67, 0) || key(name(entity, 410, 'MODEL')) !== 'MODEL') {
      report('首版仅显示模型空间，已跳过图纸布局中的图元。');
      continue;
    }
    render(entity, root, []);
  }
  return { items, layers: [...layers.values()], issues: [...issues], encoding: document.encoding,
    units: number(document.header.get('$INSUNITS'), 70, 0),
    version: name(document.header.get('$ACADVER'), 1, '未知版本') };
}
