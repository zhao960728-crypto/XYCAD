const SVG_NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi;
const PATH_TOKEN = /[a-df-z]|[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi;
const fmt = value => {
  if (!Number.isFinite(value)) throw Error('图纸包含无效坐标。');
  return value.toFixed(7).replace(/\.?0+$/, '') || '0';
};
const numbers = values => values.map(fmt).join(' ');
const coordinate = (matrix, x, y) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f];
const coordinates = value => (value?.match(SVG_NUMBER) ?? []).map(Number);

// Convert each SVG ellipse segment to PDF cubic curves, splitting at 90°.
function arcCurves(x, y, rx, ry, rotation, large, sweep, endX, endY) {
  if (x === endX && y === endY) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return null;
  const angle = rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = (x - endX) / 2, dy = (y - endY) / 2;
  const u = cos * dx + sin * dy, v = -sin * dx + cos * dy;
  const stretch = Math.max(1, Math.hypot(u / rx, v / ry));
  rx *= stretch;
  ry *= stretch;
  const normalizedX = u / rx, normalizedY = v / ry;
  const norm = normalizedX ** 2 + normalizedY ** 2;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, 1 / norm - 1));
  const cx = factor * normalizedY, cy = -factor * normalizedX;
  let start = Math.atan2(normalizedY - cy, normalizedX - cx);
  let delta = Math.atan2(-normalizedY - cy, -normalizedX - cx) - start;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  const segments = Math.ceil(Math.abs(delta) / (Math.PI / 2));
  const step = delta / segments;
  const ellipse = (a, b) => [
    (x + endX) / 2 + cos * rx * (cx + a) - sin * ry * (cy + b),
    (y + endY) / 2 + sin * rx * (cx + a) + cos * ry * (cy + b),
  ];
  const curves = [];
  for (let i = 0; i < segments; i++) {
    const end = start + step;
    const tangent = 4 / 3 * Math.tan(step / 4);
    curves.push([
      ...ellipse(Math.cos(start) - tangent * Math.sin(start), Math.sin(start) + tangent * Math.cos(start)),
      ...ellipse(Math.cos(end) + tangent * Math.sin(end), Math.sin(end) - tangent * Math.cos(end)),
      ...(i === segments - 1 ? [endX, endY] : ellipse(Math.cos(end), Math.sin(end))),
    ]);
    start = end;
  }
  return curves;
}

export function pdfPath(path, matrix) {
  const tokens = path.match(PATH_TOKEN) ?? [];
  const sizes = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
  const commands = [];
  const point = (x, y) => numbers(coordinate(matrix, x, y));
  const cubic = ([a,b,c,d,e,f]) => commands.push(point(a,b) + ' ' + point(c,d) + ' ' + point(e,f) + ' c');
  let cursor = 0, command, previous, x = 0, y = 0, startX = 0, startY = 0, controlX = 0, controlY = 0;
  while (cursor < tokens.length) {
    if (/^[a-z]$/i.test(tokens[cursor])) command = tokens[cursor++];
    const kind = command?.toUpperCase();
    if (kind === 'Z') {
      commands.push('h');
      x = startX;
      y = startY;
      previous = kind;
      command = undefined;
      continue;
    }
    const size = sizes[kind];
    const args = tokens.slice(cursor, cursor + size).map(Number);
    if (!size || args.length !== size || args.some(value => !Number.isFinite(value))) {
      throw Error('图纸包含无法转换的矢量路径。');
    }
    cursor += size;
    const relative = command !== kind;
    const X = value => value + (relative ? x : 0);
    const Y = value => value + (relative ? y : 0);
    let endX = X(args.at(-2)), endY = Y(args.at(-1));
    if (kind === 'M') {
      startX = endX;
      startY = endY;
      commands.push(point(endX,endY) + ' m');
      command = relative ? 'l' : 'L';
    } else if ('LHV'.includes(kind)) {
      if (kind === 'H') { endX = X(args[0]); endY = y; }
      if (kind === 'V') { endX = x; endY = Y(args[0]); }
      commands.push(point(endX,endY) + ' l');
    } else if (kind === 'C' || kind === 'S') {
      const smooth = previous === 'C' || previous === 'S';
      const first = kind === 'C' ? [X(args[0]),Y(args[1])] : smooth ? [2*x-controlX,2*y-controlY] : [x,y];
      [controlX, controlY] = [X(args.at(-4)),Y(args.at(-3))];
      cubic([...first,controlX,controlY,endX,endY]);
    } else if (kind === 'Q' || kind === 'T') {
      const smooth = previous === 'Q' || previous === 'T';
      [controlX,controlY] = kind === 'Q' ? [X(args[0]),Y(args[1])] : smooth ? [2*x-controlX,2*y-controlY] : [x,y];
      cubic([x+2*(controlX-x)/3,y+2*(controlY-y)/3,endX+2*(controlX-endX)/3,endY+2*(controlY-endY)/3,endX,endY]);
    } else {
      const arcs = arcCurves(x,y,...args.slice(0,5),endX,endY);
      if (arcs) arcs.forEach(cubic);
      else commands.push(point(endX,endY) + ' l');
    }
    x = endX;
    y = endY;
    previous = kind;
  }
  return commands.join('\n');
}

function shape(element) {
  const n = name => Number(element.getAttribute(name) ?? 0);
  switch (element.localName) {
    case 'line': return `M ${n('x1')} ${n('y1')} L ${n('x2')} ${n('y2')}`;
    case 'path': return element.getAttribute('d') ?? '';
    case 'polygon':
    case 'polyline': return 'M ' + element.getAttribute('points') + (element.localName === 'polygon' ? ' Z' : '');
    case 'rect': {
      const x=n('x'), y=n('y'), w=n('width'), h=n('height');
      return `M ${x} ${y} H ${x+w} V ${y+h} H ${x} Z`;
    }
    case 'circle':
    case 'ellipse': {
      const x=n('cx'), y=n('cy'), rx=n('r')||n('rx'), ry=n('r')||n('ry');
      return `M ${x-rx} ${y} A ${rx} ${ry} 0 0 1 ${x+rx} ${y} A ${rx} ${ry} 0 0 1 ${x-rx} ${y} Z`;
    }
    default: return null;
  }
}

async function pdfDocument(page, body, images, opacity) {
  const encoder = new TextEncoder(), chunks = [], offsets = [0];
  let length = 0;
  const append = value => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  };
  function object(dictionary, stream) {
    const id = offsets.length;
    offsets.push(length);
    append(id + ' 0 obj\n');
    if (stream) {
      append('<< ' + dictionary + ' /Length ' + stream.length + ' >>\nstream\n');
      append(stream);
      append('\nendstream');
    } else append('<< ' + dictionary + ' >>');
    append('\nendobj\n');
  }
  const imageResources = images.map((_,i) => '/Im'+i+' '+(10+i)+' 0 R').join(' ');
  const opacityResources = [...opacity.values()].map((_,i) => '/GS'+i+' '+(10+images.length+i)+' 0 R').join(' ');
  append('%PDF-1.4\n');
  object('/Type /Catalog /Pages 2 0 R');
  object('/Type /Pages /Count 1 /Kids [3 0 R]');
  object('/Type /Page /Parent 2 0 R /MediaBox [0 0 '+numbers(page)+'] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << '+imageResources+' >> /ExtGState << '+opacityResources+' >> >>');
  const content = encoder.encode(body);
  if (typeof CompressionStream === 'function') {
    const compressed = new Blob([content]).stream().pipeThrough(new CompressionStream('deflate'));
    object('/Filter /FlateDecode', new Uint8Array(await new Response(compressed).arrayBuffer()));
  } else object('', content);
  object('/Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding');
  object('/Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] /ToUnicode 9 0 R');
  object('/Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /FontDescriptor 8 0 R');
  object('/Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80');
  object('',encoder.encode('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /XYCAD-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end'));
  for (const image of images) object('/Type /XObject /Subtype /Image /Width '+image.width+' /Height '+image.height+' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',image.data);
  for (const [fill,stroke] of opacity.values()) object('/Type /ExtGState /ca '+fmt(fill)+' /CA '+fmt(stroke));
  const xref = length;
  append('xref\n0 '+offsets.length+'\n0000000000 65535 f \n');
  for (const offset of offsets.slice(1)) append(String(offset).padStart(10,'0')+' 00000 n \n');
  append('trailer\n<< /Root 1 0 R /Size '+offsets.length+' >>\nstartxref\n'+xref+'\n%%EOF\n');
  return new Blob(chunks,{type:'application/pdf'});
}

async function readImage(element) {
  const source = element.getAttribute('href') ?? '';
  if (!/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(source)) throw Error('无法转换图纸中的内嵌图片。');
  const image = new Image();
  image.src = source;
  await image.decode();
  const scale = Math.min(1,8192/Math.max(image.width,image.height),Math.sqrt(24_000_000/(image.width*image.height)));
  const canvas = Object.assign(document.createElement('canvas'),{width:Math.max(1,Math.round(image.width*scale)),height:Math.max(1,Math.round(image.height*scale))});
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(image,0,0,canvas.width,canvas.height);
  const jpeg = await new Promise(resolve => canvas.toBlob(resolve,'image/jpeg',.98));
  if (!jpeg) throw Error('无法转换图纸中的内嵌图片。');
  return {width:canvas.width,height:canvas.height,data:new Uint8Array(await jpeg.arrayBuffer())};
}

function pdfText(node, matrix) {
  const content = node.textContent;
  const fontSize = Number(node.closest('text').getAttribute('font-size'));
  if (!fontSize) return '';
  const characters = Array.from(content);
  const commands = ['0 g','BT'];
  const units = numbers([matrix.a,matrix.b,-matrix.c,-matrix.d]);
  for (let i=0;i<Math.min(characters.length,node.getNumberOfChars());i++) {
    const position=node.getStartPositionOfChar(i);
    const value=characters[i]==='⌀'?'Ø':characters[i];
    const code=value.codePointAt(0);
    if (code<32) continue;
    const latin=code<=255;
    const hex=(code>65535?0xfffd:code).toString(16).padStart(latin?2:4,'0');
    commands.push('/F'+(latin?'1':'2')+' '+fmt(fontSize)+' Tf '+units+' '+numbers(coordinate(matrix,position.x,position.y))+' Tm <'+hex+'> Tj');
  }
  commands.push('ET');
  return commands.join('\n');
}

export async function drawingPdf(world, paper='a4', region=null) {
  await document.fonts.ready;
  const box = region ?? world.getBBox();
  const extent = Math.max(box.width,box.height);
  if (!Number.isFinite(extent) || extent<=0) throw Error('当前没有可导出的可见图纸。');
  const padding = region ? 0 : extent*.015;
  const width = Math.max(box.width+2*padding,extent*1e-6), height = Math.max(box.height+2*padding,extent*1e-6);
  const mm = paper==='a3' ? [420,297] : [297,210];
  if (width<height) mm.reverse();
  const page = mm.map(value => value*72/25.4);
  const scale = Math.min((page[0]-28)/width,(page[1]-28)/height);
  const left=(page[0]-width*scale)/2, bottom=(page[1]-height*scale)/2;
  const toPage = new DOMMatrix([scale,0,0,scale,left-(box.x-padding)*scale,bottom-(box.y-padding)*scale]);
  const fromScreen = world.getScreenCTM()?.inverse();
  if (!fromScreen) throw Error('图纸预览尚未就绪。');
  const commands = ['q',numbers([left,bottom,width*scale,height*scale])+' re W n'];
  const images = [], opacity = new Map(), pending = [];
  let painted = false;

  function paint(element, inheritedOpacity=1) {
    if (element.classList.contains('layer-off') || ['defs','clipPath'].includes(element.localName)) return;
    const screen = element.getScreenCTM?.();
    if (!screen) return;
    const matrix = toPage.multiply(fromScreen).multiply(screen);
    const alpha = inheritedOpacity * Number(element.getAttribute('opacity') ?? 1);
    const name = element.localName;
    if (region && name!=='g' && name!=='svg') {
      const bounds=element.getBBox();
      const corners=[
        coordinate(matrix,bounds.x,bounds.y),
        coordinate(matrix,bounds.x+bounds.width,bounds.y),
        coordinate(matrix,bounds.x,bounds.y+bounds.height),
        coordinate(matrix,bounds.x+bounds.width,bounds.y+bounds.height),
      ];
      const xs=corners.map(([x])=>x),ys=corners.map(([,y])=>y);
      const stroke=Number(element.getAttribute('stroke-width')??0);
      const margin=Math.max(1,stroke*Math.max(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d))*2);
      if (Math.max(...xs)+margin<left || Math.min(...xs)-margin>left+width*scale ||
          Math.max(...ys)+margin<bottom || Math.min(...ys)-margin>bottom+height*scale) return;
    }
    const clip = /^url\(#([^)]*)\)$/.exec(element.getAttribute('clip-path') ?? '');
    let clipped=false;
    if (clip) {
      const path = element.ownerDocument.getElementById(clip[1])?.querySelector('path');
      if (path) {
        commands.push('q',pdfPath(path.getAttribute('d'),matrix),path.getAttribute('clip-rule')==='evenodd'?'W* n':'W n');
        clipped=true;
      }
    }
    if (name==='svg' && element.getAttribute('overflow')==='hidden') {
      const view=element.viewBox.baseVal;
      const frame=`M ${view.x} ${view.y} H ${view.x+view.width} V ${view.y+view.height} H ${view.x} Z`;
      if (!clipped) commands.push('q');
      commands.push(pdfPath(frame,matrix),'W n');
      clipped=true;
    }
    if (name==='g'||name==='svg') {
      for (const child of element.children) paint(child,alpha);
    } else if (name==='text') {
      const rows = element.querySelectorAll('tspan');
      for (const row of rows.length ? rows : [element]) commands.push(pdfText(row,matrix));
      painted = true;
    } else if (name==='image') {
      const id=images.length;
      images.push(null);
      pending.push(readImage(element).then(image => { images[id]=image; }));
      const w=Number(element.getAttribute('width')),h=Number(element.getAttribute('height'));
      const x=Number(element.getAttribute('x')),y=Number(element.getAttribute('y'));
      const position=coordinate(matrix,x,y+h);
      commands.push('q',numbers([matrix.a*w,matrix.b*w,-matrix.c*h,-matrix.d*h,...position])+' cm /Im'+id+' Do','Q');
      painted = true;
    } else {
      const path=shape(element);
      if (path) {
        const fill=element.getAttribute('fill')!=='none' && name!=='line' && name!=='polyline';
        const stroke=element.hasAttribute('stroke') && element.getAttribute('stroke')!=='none';
        if (fill||stroke) {
          commands.push('q');
          const fillAlpha = alpha*Number(element.getAttribute('fill-opacity')??1);
          const strokeAlpha = alpha*Number(element.getAttribute('stroke-opacity')??1);
          if (fillAlpha!==1||strokeAlpha!==1) {
            const key=fmt(fillAlpha)+','+fmt(strokeAlpha);
            if (!opacity.has(key)) opacity.set(key,[fillAlpha,strokeAlpha]);
            commands.push('/GS'+[...opacity.keys()].indexOf(key)+' gs');
          }
          const white=element.classList.contains('wipeout-fill') || (name==='rect' && element.getAttribute('fill')==='#ffffff');
          const vectorEffect=element.getAttribute('vector-effect')==='non-scaling-stroke';
          const strokeScale = vectorEffect ? .55 : Math.sqrt(Math.abs(matrix.a*matrix.d-matrix.b*matrix.c));
          const strokeWidth = Math.max(.08,Number(element.getAttribute('stroke-width')??1)*strokeScale);
          const dash=coordinates(element.getAttribute('stroke-dasharray')).map(value=>value*strokeScale);
          const cap=['butt','round','square'].indexOf(element.getAttribute('stroke-linecap'));
          const join=['miter','round','bevel'].indexOf(element.getAttribute('stroke-linejoin'));
          const even=element.getAttribute('fill-rule')==='evenodd';
          commands.push(white?'1 g':'0 g','0 G',fmt(strokeWidth)+' w',Math.max(0,cap)+' J',Math.max(0,join)+' j',
            '['+numbers(dash)+'] '+fmt(Number(element.getAttribute('stroke-dashoffset')??0)*strokeScale)+' d',
            pdfPath(path,matrix),fill?(stroke?'B':'f')+(even?'*':''):'S','Q');
          painted = true;
        }
      }
    }
    if (clipped) commands.push('Q');
  }
  for (const element of world.children) paint(element);
  if (!painted) throw Error('当前没有可导出的可见图纸。');
  await Promise.all(pending);
  commands.push('Q');
  return pdfDocument(page,commands.join('\n'),images,opacity);
}
