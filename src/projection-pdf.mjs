import { deflateSync } from 'node:zlib';
import { createPdf } from './pdf-write.mjs';

const pointsPerMm = 72 / 25.4;
const label = new Map([['正视图', 'Front'], ['俯视图', 'Top'], ['右视图', 'Right']]);
const number = value => String(Number(value.toFixed(4)));

export function writeProjectionPdf({ entities, units, layout, hiddenDash }) {
  const paper=layout?.paper??{width:297,height:210,name:'A4 landscape'};
  const width=paper.width*pointsPerMm,height=paper.height*pointsPerMm;
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  const hidden = [], visible = [], labels = [];
  function bounds([x, y]) {
    left = Math.min(left, x);
    bottom = Math.min(bottom, y);
    right = Math.max(right, x);
    top = Math.max(top, y);
  }
  for (const entity of entities.flatMap(e=>e.type==='DIMENSION'?e.graphics:e)) {
    if(entity.type==='LWPOLYLINE'){
      entity.vertices.forEach(bounds);(entity.layer.endsWith('-HIDDEN') ? hidden : visible).push(entity);continue;
    }
    bounds(entity.a);
    if (entity.type === 'TEXT') {
      bounds([entity.a[0] + entity.height * 3, entity.a[1] + entity.height]);
      labels.push(entity);
    } else {
      bounds(entity.b);
      (entity.layer.endsWith('-HIDDEN') ? hidden : visible).push(entity);
    }
  }
  if(layout?.bounds)({left,bottom,right,top}=layout.bounds);
  const spanX = right - left, spanY = top - bottom;
  const scale = Math.min((width - 12*pointsPerMm) / spanX, (height - 12*pointsPerMm) / spanY);
  const x = (width - spanX * scale) / 2, y = (height-spanY*scale)/2;
  const point = ([u, v]) => number(x + (u - left) * scale) + ' ' + number(y + (v - bottom) * scale);
  const line = entity => entity.type==='LWPOLYLINE'
    ? point(entity.vertices[0])+' m '+entity.vertices.slice(1).map(p=>point(p)+' l').join(' ')+(entity.closed?' h':'')+' S'
    : `${point(entity.a)} m ${point(entity.b)} l S`;
  const text = (value, position, size) => {
    value=String(value??'');
    const chinese=/[^\x20-\x7e]/.test(value);
    const encoded=chinese?'<'+Buffer.from(value,'utf16le').swap16().toString('hex')+'>':'('+value.replace(/[\\()]/g,c=>'\\'+c)+')';
    return `BT /${chinese?'F2':'F1'} ${number(size)} Tf ${position} Td ${encoded} Tj ET`;
  };
  const ratio = scale / pointsPerMm;
  const printScale = ratio >= 1 ? Number(ratio.toPrecision(5)) + ':1' : '1:' + Number((1 / ratio).toPrecision(5));
  const notes = units ? `Print scale: ${printScale} at actual page size`
    : 'Source length unit unspecified';
  const body = [
    '0.15 g',
    ...(layout?.frame?[]:[text('XYCAD  |  Orthographic views', `30 ${number(height - 33)}`, 16)]),
    ...(layout?.frame?[]:[`0.75 G 0.45 w 30 ${number(height - 44)} m ${number(width - 30)} ${number(height - 44)} l S`]),
    `1 J 1 j 0.36 G 0.36 w [${number(hiddenDash?hiddenDash*scale:3)} ${number(hiddenDash?hiddenDash*scale/2:2)}] 0 d`,
    ...hidden.map(line),
    '0.08 G 0.68 w [] 0 d',
    ...visible.map(line),
    ...labels.map(entity => text(entity.value, point(entity.a), entity.height * scale)),
    text('First-angle  |  '+paper.name+'  |  ' + notes, '18 8', 6),
  ];
  const { object, finish } = createPdf();
  object('<< /Type /Catalog /Pages 2 0 R >>');
  object('<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  object(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`);
  object('/Filter /FlateDecode', deflateSync(body.join('\n')));
  object('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  object('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] /ToUnicode 9 0 R >>');
  object('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /W [1 95 500] /FontDescriptor 8 0 R >>');
  object('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>');
  object('',Buffer.from('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /XYCAD-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end'));
  return finish();
}
