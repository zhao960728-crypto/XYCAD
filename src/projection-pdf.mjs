import { deflateSync } from 'node:zlib';
import { createPdf } from './pdf-write.mjs';

const pointsPerMm = 72 / 25.4;
const width = 297 * pointsPerMm;
const height = 210 * pointsPerMm;
const label = new Map([['正视图', 'Front'], ['俯视图', 'Top'], ['右视图', 'Right']]);
const number = value => String(Number(value.toFixed(4)));

export function writeProjectionPdf({ entities, units }) {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  const hidden = [], visible = [], labels = [];
  function bounds([x, y]) {
    left = Math.min(left, x);
    bottom = Math.min(bottom, y);
    right = Math.max(right, x);
    top = Math.max(top, y);
  }
  for (const entity of entities) {
    bounds(entity.a);
    if (entity.type === 'TEXT') {
      bounds([entity.a[0] + entity.height * 3, entity.a[1] + entity.height]);
      labels.push(entity);
    } else {
      bounds(entity.b);
      (entity.layer.endsWith('-HIDDEN') ? hidden : visible).push(entity);
    }
  }
  const spanX = right - left, spanY = top - bottom;
  const scale = Math.min((width - 72) / spanX, (height - 132) / spanY);
  const x = (width - spanX * scale) / 2, y = (height - spanY * scale) / 2 - 4;
  const point = ([u, v]) => number(x + (u - left) * scale) + ' ' + number(y + (v - bottom) * scale);
  const line = ({ a, b }) => `${point(a)} m ${point(b)} l S`;
  const text = (value, position, size) => `BT /F1 ${number(size)} Tf ${position} Td (${value}) Tj ET`;
  const ratio = scale / pointsPerMm;
  const printScale = ratio >= 1 ? Number(ratio.toPrecision(5)) + ':1' : '1:' + Number((1 / ratio).toPrecision(5));
  const notes = units ? `Print scale: ${printScale} at actual page size`
    : 'Source length unit unspecified';
  const body = [
    '0.15 g',
    text('XYCAD  |  Orthographic views', `30 ${number(height - 33)}`, 16),
    `0.75 G 0.45 w 30 ${number(height - 44)} m ${number(width - 30)} ${number(height - 44)} l S`,
    '1 J 1 j 0.36 G 0.36 w [3 2] 0 d',
    ...hidden.map(line),
    '0.08 G 0.68 w [] 0 d',
    ...visible.map(line),
    ...labels.map(entity => text(label.get(entity.value), point(entity.a), Math.min(11, entity.height * scale))),
    text('First-angle projection  |  A4 landscape  |  ' + notes, '30 24', 9),
  ];
  const { object, finish } = createPdf();
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);
  object('/Filter /FlateDecode', deflateSync(body.join('\n')));
  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  return finish();
}
