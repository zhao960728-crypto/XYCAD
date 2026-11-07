import { Buffer } from 'node:buffer';
import { deflateSync, inflateSync } from 'node:zlib';
import { readSolidWorksSheets } from './slddrw-preview.mjs';
import { readSolidWorksVector } from './slddrw-vector.mjs';

import { writeVectorDxf } from './dxf-write.mjs';
import { createPdf } from './pdf-write.mjs';

function paeth(left, up, diagonal) {
  const p = left + up - diagonal;
  const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - diagonal);
  return a <= b && a <= c ? left : b <= c ? up : diagonal;
}

function pdfImage({ width, height, channels, idat }) {
  const packed = Buffer.concat(idat);
  const stride = width * channels + 1;
  const expected = height * stride;
  let source;
  try { source = inflateSync(packed, { maxOutputLength: expected }); }
  catch { throw new Error('SolidWorks 图纸画面像素数据损坏。'); }
  if (source.length !== expected) throw new Error('SolidWorks 图纸画面像素数据长度不符。');
  const predictors = [
    () => 0, left => left, (_left, up) => up, (left, up) => (left + up) >>> 1, paeth,
  ];
  for (let start = 0; start < expected; start += stride) {
    if (source[start] >= predictors.length) throw new Error('SolidWorks 图纸画面使用无效的 PNG 滤波方式。');
  }
  if (channels === 3) return packed;
  const rgbStride = width * 3 + 1;
  const rgb = Buffer.alloc(height * rgbStride);
  for (let y = 0; y < height; y++) {
    const start = y * stride;
    const predict = predictors[source[start]];
    for (let j = 1; j < stride; j++) {
      const left = j > channels ? source[start + j - channels] : 0;
      const up = y ? source[start - stride + j] : 0;
      const diagonal = y && j > channels ? source[start - stride + j - channels] : 0;
      source[start + j] += predict(left, up, diagonal);
    }
    for (let x = 0; x < width; x++) {
      const p = start + 1 + x * channels, target = y * rgbStride + 1 + x * 3;
      const alpha = source[p + 3];
      for (let i = 0; i < 3; i++) rgb[target + i] = Math.round((source[p + i] * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return deflateSync(rgb);
}

function sheetPdf(sheets) {
  const { object, finish } = createPdf();
  object('<< /Type /Catalog /Pages 2 0 R >>');
  const pageRefs = sheets.map((_, i) => (3 + i * 3) + ' 0 R');
  object('<< /Type /Pages /Count ' + sheets.length + ' /Kids [' + pageRefs.join(' ') + '] >>');
  for (const [index, { image }] of sheets.entries()) {
    const { width, height } = image;
    const w = width * 0.75, h = height * 0.75;
    const page = 3 + index * 3;
    object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Sheet ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    object('', Buffer.from(`q\n${w} 0 0 ${h} 0 0 cm\n/Sheet Do\nQ\n`));
    object(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8` +
      ` /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns ${width} /Colors 3 /BitsPerComponent 8 >>`, pdfImage(image));
  }
  return finish();
}

export function exportSolidWorksDrawing(bytes, format) {
  if (format === 'dxf') {
    const drawing = readSolidWorksVector(bytes, true);
    if (!drawing.completePages) throw new Error('部分模型视图或其页面归属尚未验证，当前无法导出整套可编辑 DXF。');
    if (drawing.sheets.length === 1) return [writeVectorDxf(drawing)];
    const entities = [];
    let offset = 0;
    for (const [i, sheet] of drawing.sheets.entries()) {
      let left = 0, right = sheet.width;
      for (const entity of sheet.entities) {
        for (const [x] of entity.vertices ?? [entity.a, ...(entity.b ? [entity.b] : [])]) {
          left = Math.min(left, x - (entity.radius ?? 0));
          right = Math.max(right, x + (entity.radius ?? 0));
        }
      }
      const move = ([x, y]) => [x + offset - left, y];
      const prefix = 'P' + String(i + 1).padStart(2, '0') + '-';
      for (const { a, b, vertices, ...entity } of sheet.entities) {
        entities.push({ ...entity, layer: prefix + entity.layer,
          ...(a && { a: move(a) }), ...(b && { b: move(b) }), ...(vertices && { vertices: vertices.map(move) }) });
      }
      offset += right - left + 20;
    }
    return [writeVectorDxf({ entities, hiddenDash: drawing.sheets.some(sheet => sheet.hiddenDash) ? 1 : undefined })];
  }
  const sheets = readSolidWorksSheets(bytes, true);
  if (sheets.some(sheet => !sheet.image)) throw new Error('图纸缺少部分页面画面，无法导出完整工程图。');
  return sheetPdf(sheets);
}
