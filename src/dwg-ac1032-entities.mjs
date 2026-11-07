const degrees = 180 / Math.PI;

export const entityTypes = new Map([
  [1, 'TEXT'], [2, 'ATTRIB'], [3, 'ATTDEF'], [7, 'INSERT'], [8, 'INSERT'], [17, 'ARC'], [18, 'CIRCLE'], [19, 'LINE'],
  [10, 'VERTEX'], [15, 'POLYLINE'],
  [20, 'DIMENSION'], [21, 'DIMENSION'], [22, 'DIMENSION'], [23, 'DIMENSION'],
  [24, 'DIMENSION'], [25, 'DIMENSION'], [26, 'DIMENSION'], [27, 'POINT'],
  [31, 'SOLID'], [32, 'TRACE'], [35, 'ELLIPSE'], [36, 'SPLINE'], [44, 'MTEXT'], [45, 'LEADER'], [77, 'LWPOLYLINE'], [78, 'HATCH'],
]);

function count(value, limit = 100000) {
  if (!Number.isInteger(value) || value < 0 || value > limit) throw new Error('DWG 对象元素数量超限。');
  return value;
}

export function coordinates(code, values) {
  return values.map((value, index) => [code + index * 10, value]);
}

function colorData(data, strings) {
  const index = data.bs();
  const encoded = data.bl();
  const flags = data.rc();
  if (flags & 1) strings?.text();
  if (flags & 2) strings?.text();
  const method = encoded >>> 24;
  const aci = method === 0xc0 ? 256 : method === 0xc1 ? 0 : method === 0xc3 ? encoded & 255 : index;
  return { index: aci, rgb: method === 0xc2 ? encoded & 0xffffff : undefined };
}

function tableEntry(object) {
  const { data, refs, handle, strings, legacy, version } = object;
  const reactors = count(data.bl(), 8192);
  const noDictionary = legacy ? false : data.b();
  if (!legacy && version >= 1027) data.b();
  refs.handle(handle);
  for (let index = 0; index < reactors; index++) refs.handle(handle);
  if (!noDictionary) refs.handle(handle);
  const name = strings?.text() || '';
  if (legacy || version === 1018) { data.b(); data.bs(); data.b(); }
  else data.skip(2); // AC1032 symbol-table reference flags.
  return name;
}

export function readSymbol(object) {
  const { data, refs, handle, strings, legacy, version } = object;
  const name = tableEntry(object);
  if (!name && object.type !== 53) throw new Error('DWG 符号表记录无名称。');
  switch (object.type) {
    case 49: {
      const flags = data.b() | data.b() << 1 | data.b() << 2 | data.b() << 3;
      data.b();
      if (!legacy && !(flags & 12)) data.bl();
      const base = data.xyz();
      let entityRange;
      if (legacy && !(flags & 12)) {
        refs.handle(handle); // Reserved handle.
        refs.handle(handle); // BLOCK entity.
        entityRange = [refs.handle(handle), refs.handle(handle)];
      }
      return { name, base, flags, entityRange };
    }
    case 51: {
      const flags = data.bs();
      const color = legacy ? { index: data.bs() } : colorData(data, strings);
      // Xref block, plot style and material precede the line type.
      refs.handle(handle);
      refs.handle(handle);
      if (!legacy && version >= 1021) refs.handle(handle);
      const linetype = refs.handle(handle);
      const aci = color.index >= 1 && color.index <= 255 ? color.index : 7;
      return { name, linetype, groups: [[70, (flags & 1) | (flags >>> 1 & 6)], [62, flags & 2 ? -aci : aci],
        ...(color.rgb === undefined ? [] : [[420, color.rgb]]), [290, Number(Boolean(flags & 16))]] };
    }
    case 53: {
      const vertical = data.b();
      const shape = data.b();
      const height = data.bd();
      const width = data.bd();
      const angle = data.bd();
      const generation = data.rc();
      const lastHeight = data.bd();
      const font = strings?.text() ?? '';
      const bigFont = strings?.text() ?? '';
      // Anonymous SHX descriptors are not named text styles.
      if (!name && (shape || /\.shx$/i.test(font))) return null;
      if (!name) throw new Error('DWG 文字样式无名称。');
      return { name, groups: [[70, (vertical << 2) | shape], [40, height], [41, width], [50, angle * degrees],
        [71, generation], [42, lastHeight], [3, font], [4, bigFont]] };
    }
    case 57: {
      const description = strings?.text() ?? '';
      const length = data.bd();
      const align = data.rc();
      const dashes = data.rc();
      const groups = [[70, 0], [3, description], [72, align], [73, dashes], [40, length]];
      let complex = false;
      for (let index = 0; index < dashes; index++) {
        groups.push([49, data.bd()], [74, 0]);
        data.bs();
        data.rd();
        data.rd();
        data.bd();
        data.bd();
        const shape = data.bs();
        if (shape & 6) complex = true;
      }
      return { name, groups, complex };
    }
    case 69: {
      const prefix = strings?.text() ?? '';
      const alternate = strings?.text() ?? '';
      const groups = [[70, 0], [3, prefix], [4, alternate]];
      const modernDimStyle = !legacy && version >= 1021;
      for (let code = 40; code <= (modernDimStyle ? 50 : 48); code++) groups.push([code, data.bd()]);
      if (modernDimStyle) { groups.push([69, data.bs()]); colorData(data, strings); }
      for (let code = 71; code <= 76; code++) groups.push([code, data.b()]);
      for (let code = 77; code <= 79; code++) groups.push([code, data.bs()]);
      if (modernDimStyle) groups.push([90, data.bs()]);
      for (let code = 140; code <= 148; code++) groups.push([code, data.bd()]);
      groups.push([170, data.b()], [171, data.bs()]);
      for (let code = 172; code <= 175; code++) groups.push([code, data.b()]);
      for (const code of [176, 177, 178]) {
        groups.push([code, legacy ? data.bs() : colorData(data, strings).index]);
      }
      let defaultTolerance = false;
      let followsLinearPrecision = false;
      for (const code of [179, 271, 272, 273, 274, 275, 276, 277, 278]) {
        const raw = data.bs();
        const value = raw > 32767 ? raw - 65536 : raw;
        if (version === 1018 && code === 179 && value === -1) {
          followsLinearPrecision = true;
          continue;
        }
        if (code === 271 && followsLinearPrecision) groups.push([179, value]);
        if (code === 272 && value === -1) defaultTolerance = true;
        else groups.push([code, value]);
      }
      refs.handle(handle); // External-reference block.
      const styleRefs = [];
      for (let code = 340; code <= (modernDimStyle ? 347 : 344) && refs.pos + 8 <= refs.end; code++) {
        styleRefs.push([code, refs.handle(handle)]);
      }
      return { name, groups, styleRefs, defaultTolerance };
    }
    default:
      throw new Error('不支持的 DWG 符号表。');
  }
}

function insertion(data) {
  const origin = data.xyz();
  const mode = data.bits(2);
  const x = mode === 0 || mode === 2 ? data.rd() : 1;
  const y = mode < 2 ? data.dd(x) : x;
  const z = mode < 2 ? data.dd(x) : x;
  const angle = data.bd();
  const normal = data.xyz();
  return [...coordinates(10, origin), [41, x], [42, y], [43, z], [50, angle * degrees], ...coordinates(210, normal)];
}

export function legacyMtext(value) {
  // The caret is part of the stacked-text syntax inside \S…; and literal elsewhere.
  return value.replace(/\\(?:\\|S[^;]*;)|\^/gi, token => token === '^' ? '^ ' : token);
}

function textChunks(value) {
  const text = value.replace(/\r\n|\r|\n/g, '\\P');
  const groups = [];
  let index = 0;
  while (text.length - index > 250) {
    const end = index + 250;
    const next = /[\ud800-\udbff]/.test(text[end - 1]) ? end - 1 : end;
    groups.push([3, text.slice(index, next)]);
    index = next;
  }
  groups.push([1, text.slice(index)]);
  return groups;
}

function hatch(object) {
  const { data, strings, refs, handle, legacy, version } = object;
  if (!legacy) {
    const gradient = data.bl();
    data.bl(); data.bd(); data.bd(); data.bl(); data.bd();
    const colors = count(data.bl(), 256);
    for (let index = 0; index < colors; index++) {
      data.bd(); data.bs(); data.bl(); data.rc();
    }
    strings?.text(); // Gradient name is absent for ordinary fills.
    if (gradient) throw new Error('渐变填充暂不支持。');
  }
  const groups = [[10, 0], [20, 0], [30, data.bd()], ...coordinates(210, data.xyz()), [2, strings?.text() || 'SOLID']];
  const put = (code, value) => groups.push([code, value]);
  const xy = code => groups.push(...coordinates(code, [data.rd(), data.rd()]));
  const solid = data.b();
  put(70, solid);
  put(71, data.b());
  const loops = count(data.bl(), 4096);
  put(91, loops);
  let hasDerived = false;
  let total = 0;
  for (let loop = 0; loop < loops; loop++) {
    const flags = data.bl();
    put(92, flags);
    if (flags & 4) hasDerived = true;
    const polyline = flags & 2;
    const bulges = polyline && data.b();
    if (polyline) { put(72, Number(bulges)); put(73, data.b()); }
    const edges = count(data.bl());
    total += edges;
    count(total, 80000);
    put(93, edges);
    for (let edge = 0; edge < edges; edge++) {
      if (polyline) {
        xy(10);
        if (bulges) put(42, data.bd());
        continue;
      }
      const type = data.rc();
      put(72, type);
      if (type === 1) { xy(10); xy(11); }
      else if (type === 2 || type === 3) {
        xy(10);
        if (type === 3) xy(11);
        const radiusOrRatio = data.bd();
        const angle = () => {
          const parameter = data.bd();
          if (type === 2) return parameter * degrees;
          // DXF stores polar angles for an ellipse, while DWG stores its parameters.
          const polar = Math.atan2(radiusOrRatio * Math.sin(parameter), Math.cos(parameter));
          const turn = 2 * Math.PI;
          return (polar + turn * Math.round((parameter - polar) / turn)) * degrees;
        };
        put(40, radiusOrRatio); put(50, angle()); put(51, angle()); put(73, data.b());
      } else if (type === 4 && (legacy || version <= 1027)) {
        put(94, count(data.bl(), 25));
        const rational = data.b();
        put(73, rational); put(74, data.b());
        const knots = count(data.bl());
        const controls = count(data.bl());
        total += knots + controls;
        count(total, 80000);
        put(95, knots); put(96, controls);
        for (let i = 0; i < knots; i++) put(40, data.bd());
        for (let i = 0; i < controls; i++) {
          xy(10);
          if (rational) put(42, data.bd());
        }
        const fits = legacy || version <= 1021 ? 0 : count(data.bl());
        total += fits;
        count(total, 80000);
        put(97, fits);
        for (let i = 0; i < fits; i++) xy(11);
        if (fits) { xy(12); xy(13); }
      } else {
        throw new Error('样条填充边界暂不支持。');
      }
    }
    const associations = count(data.bl(), 8192);
    put(97, associations);
    for (let index = 0; index < associations; index++) put(330, refs.handle(handle).toString(16).toUpperCase());
  }
  put(75, data.bs()); put(76, data.bs());
  if (!solid) {
    put(52, data.bd() * degrees); put(41, data.bd()); put(77, data.b());
    const lines = count(data.bs(), 1024);
    put(78, lines);
    for (let line = 0; line < lines; line++) {
      put(53, data.bd() * degrees);
      for (const code of [43, 44, 45, 46]) put(code, data.bd());
      const dashes = count(data.bs(), 4096);
      put(79, dashes);
      for (let dash = 0; dash < dashes; dash++) put(49, data.bd());
    }
  }
  if (hasDerived) put(47, data.bd());
  const seeds = count(data.bl());
  put(98, seeds);
  for (let index = 0; index < seeds; index++) xy(10);
  return { groups };
}

function dimension(object, kind = 'DIMENSION') {
  const { data, refs, strings, handle, type, legacy, version: dwgVersion } = object;
  const version = legacy || dwgVersion <= 1021 ? 0 : data.rc();
  const normal = data.xyz();
  const center = [data.rd(), data.rd(), data.bd()];
  const flags = data.rc();
  const sourceText = strings?.text() || '';
  const text = legacy || dwgVersion === 1018 ? legacyMtext(sourceText) : sourceText;
  const textAngle = data.bd();
  const horizontal = data.bd();
  data.xyz(); // Scale of the saved drawing block.
  data.bd(); // Rotation of the saved drawing block.
  const attachment = data.bs();
  const spacing = data.bs();
  const factor = data.bd();
  const measurement = data.bd();
  const arrowFlags = legacy || dwgVersion === 1018 ? [] : [[73, data.b()], [74, data.b()], [75, data.b()]];
  const clone = [data.rd(), data.rd(), center[2]];
  const arc = kind === 'ARC_DIMENSION';
  const large = kind === 'LARGE_RADIAL_DIMENSION';
  const subtype = arc ? 5 : large ? 9 : [6, 0, 1, 5, 2, 4, 3][type - 20];
  let dimFlags = subtype | (flags & 2 ? 32 : 0) | (flags & 1 ? 0 : 128);
  const groups = [[280, version], ...coordinates(11, center), [1, text], [53, textAngle * degrees],
    [51, horizontal * degrees], [71, attachment], [72, spacing], [41, factor], [42, measurement],
    ...arrowFlags,
    ...coordinates(12, clone), ...coordinates(210, normal)];
  const point = code => groups.push(...coordinates(code, data.xyz()));
  let subclass;
  let specific;
  let obliqueInBlock = false;
  if (arc) {
    point(10);
    specific = [];
    for (const code of [13, 14, 15]) specific.push(...coordinates(code, data.xyz()));
    specific.push([70, data.b()], [40, data.bd()], [41, data.bd()], [71, data.b()]);
    for (const code of [16, 17]) specific.push(...coordinates(code, data.xyz()));
    subclass = 'AcDbArcDimension';
  } else if (large) {
    point(10); point(15);
    groups.push([40, data.bd()]);
    point(13); point(14);
    subclass = 'AcDbRadialDimensionLarge';
  } else if (type === 20) {
    for (const code of [10, 13, 14]) point(code);
    if (data.rc() & 1) dimFlags |= 64;
    subclass = 'AcDbOrdinateDimension';
  } else if (type === 21 || type === 22) {
    for (const code of [13, 14, 10]) point(code);
    const oblique = data.bd() * degrees;
    if (dwgVersion === 1018) {
      // Newer DXF readers can reject the optional field on legacy rotated dimensions.
      obliqueInBlock = Math.abs(oblique) > 1e-9 && Math.abs(Math.abs(oblique % 180) - 90) > 1e-9;
    } else groups.push([52, oblique]);
    if (type === 21) groups.push([50, data.bd() * degrees]);
    subclass = type === 21 ? 'AcDbRotatedDimension' : 'AcDbAlignedDimension';
  } else if (type === 23 || type === 24) {
    if (type === 24) groups.push(...coordinates(16, [data.rd(), data.rd(), center[2]]));
    for (const code of type === 23 ? [10, 13, 14, 15] : [13, 14, 15, 10]) point(code);
    subclass = type === 23 ? 'AcDb3PointAngularDimension' : 'AcDb2LineAngularDimension';
  } else {
    for (const code of type === 25 ? [10, 15] : [15, 10]) point(code);
    groups.push([40, data.bd()]);
    subclass = type === 25 ? 'AcDbRadialDimension' : 'AcDbDiametricDimension';
  }
  groups.push([70, dimFlags]);
  return { groups, specific, subclass, obliqueInBlock, dimstyle: refs.handle(handle), block: refs.handle(handle) };
}

function wipeout(object) {
  const { data, version } = object;
  const groups = [[90, data.bl()]];
  for (const code of [10, 11, 12]) groups.push(...coordinates(code, data.xyz()));
  groups.push(...coordinates(13, [data.rd(), data.rd()]), [340, '0'], [70, data.bs()], [280, data.b()],
    [281, data.rc()], [282, data.rc()], [283, data.rc()], [290, version >= 1024 ? data.b() : 0], [360, '0']);
  const boundary = data.bs();
  if (boundary !== 1 && boundary !== 2) throw new Error('遮罩的边界类型无效。');
  const vertices = boundary === 1 ? 2 : count(data.bl(), 8192);
  if (boundary === 2 && vertices < 3) throw new Error('遮罩的顶点数量无效。');
  const points = Array.from({ length: vertices }, () => [data.rd(), data.rd()]);
  if (boundary === 2 && points[0].some((value, axis) => value !== points.at(-1)[axis])) points.push(points[0]);
  groups.push([71, boundary], [91, points.length]);
  for (const point of points) groups.push(...coordinates(14, point));
  return { groups };
}

function nonEntityHeader(object) {
  const { data, refs, handle, legacy, version } = object;
  const reactors = count(data.bl(), 8192);
  const noDictionary = !legacy && data.b();
  if (!legacy && version >= 1027) data.b();
  const dictionary = refs.handle(handle);
  for (let i = 0; i < reactors; i++) refs.handle(handle);
  if (!noDictionary) refs.handle(handle);
  return dictionary;
}

export function readSortOrder(object) {
  const { data, refs, handle } = object;
  nonEntityHeader(object);
  const entries = count(data.bl(), 200000);
  const block = refs.handle(handle);
  const order = new Map();
  for (let i = 0; i < entries; i++) {
    const sortHandle = data.handle(handle);
    order.set(refs.handle(handle), sortHandle);
  }
  return { block, order };
}

export function readWipeoutFrame(object) {
  nonEntityHeader(object);
  return count(object.data.bs(), 2);
}

export function readDrawingEntity(object, name) {
  const { data, refs, handle, strings, type, legacy, version: dwgVersion } = object;
  const inlineText = legacy || dwgVersion === 1018;
  const groups = [];
  const put = (code, value) => groups.push([code, value]);
  const point = (code, values = data.xyz()) => groups.push(...coordinates(code, values));
  const thickness = () => put(39, data.thickness());
  const normal = () => point(210, data.extrusion());
  const realPoint = () => [data.rd(), data.rd()];
  switch (name) {
    case 'LINE': {
      const flat = data.b();
      const x = data.rd(), x2 = data.dd(x);
      const y = data.rd(), y2 = data.dd(y);
      const z = flat ? 0 : data.rd(), z2 = flat ? 0 : data.dd(z);
      point(10, [x, y, z]); point(11, [x2, y2, z2]);
      thickness(); normal();
      break;
    }
    case 'CIRCLE':
    case 'ARC':
      point(10); put(40, data.bd()); thickness(); normal();
      if (type === 17) { put(50, data.bd() * degrees); put(51, data.bd() * degrees); }
      break;
    case 'POINT':
      point(10); thickness(); normal();
      break;
    case 'ELLIPSE':
      point(10); point(11); point(210);
      put(40, data.bd()); put(41, data.bd()); put(42, data.bd());
      break;
    case 'SOLID':
    case 'TRACE': {
      thickness();
      const elevation = data.bd();
      for (const code of [10, 11, 12, 13]) point(code, [...realPoint(), elevation]);
      normal();
      break;
    }
    case 'POLYLINE': {
      const flags = data.bs();
      const curve = data.bs();
      const startWidth = data.bd();
      const endWidth = data.bd();
      const lineThickness = data.thickness();
      point(10, [0, 0, data.bd()]);
      put(70, flags);
      if (startWidth) put(40, startWidth);
      if (endWidth) put(41, endWidth);
      if (curve) put(75, curve);
      if (lineThickness) put(39, lineThickness);
      normal();
      const reference = () => refs.handle(handle);
      const vertexRange = legacy ? [reference(), reference()] : null;
      const vertexHandles = legacy ? null : Array.from({ length: count(data.bl()) }, reference);
      return { groups, vertexRange, vertexHandles, sequenceEnd: reference() };
    }
    case 'VERTEX': {
      const flags = data.rc();
      point(10);
      const width = data.bd();
      const start = Math.abs(width);
      const end = width < 0 ? start : data.bd();
      const bulge = data.bd();
      const identifier = dwgVersion >= 1024 && !legacy ? data.bl() : 0;
      const tangent = data.bd();
      if (start) put(40, start);
      if (end) put(41, end);
      if (bulge) put(42, bulge);
      put(70, flags);
      if (flags & 2) put(50, tangent * degrees);
      if (identifier) put(91, identifier);
      break;
    }
    case 'LWPOLYLINE': {
      const flags = data.bs();
      if (flags & 4) put(43, data.bd());
      if (flags & 8) put(38, data.bd());
      if (flags & 2) put(39, data.bd());
      if (flags & 1) point(210);
      const vertices = count(data.bl());
      const bulges = flags & 16 ? count(data.bl(), vertices) : 0;
      const ids = flags & 1024 ? count(data.bl(), vertices) : 0;
      const widths = flags & 32 ? count(data.bl(), vertices) : 0;
      put(90, vertices); put(70, (flags & 512 ? 1 : 0) | (flags & 256 ? 128 : 0));
      const values = [];
      if (vertices) values.push(realPoint());
      for (let index = 1; index < vertices; index++) values.push(values.at(-1).map(value => data.dd(value)));
      const arcs = Array.from({ length: bulges }, () => data.bd());
      for (let index = 0; index < ids; index++) data.bl();
      const vertexWidths = Array.from({ length: widths }, () => [data.bd(), data.bd()]);
      values.forEach((value, index) => {
        point(10, value);
        if (arcs[index]) put(42, arcs[index]);
        if (vertexWidths[index]) { put(40, vertexWidths[index][0]); put(41, vertexWidths[index][1]); }
      });
      break;
    }
    case 'SPLINE': {
      let scenario = data.bl();
      const modernSpline = !legacy && dwgVersion >= 1027;
      const flags = modernSpline ? data.bl() : 0;
      const knot = modernSpline ? data.bl() : 0;
      if ((flags & 9) === 9 && knot !== 15) scenario = 2; // Fit method with a non-custom knot parameter.
      const degree = count(data.bl(), 25);
      let splineFlags = flags & 4 ? 1 : 0;
      if (scenario === 2) {
        const tolerance = data.bd();
        const tangentIn = data.xyz(), tangentOut = data.xyz();
        const fits = count(data.bl());
        put(70, splineFlags); put(71, degree); put(72, 0); put(73, 0); put(74, fits); put(44, tolerance);
        point(12, tangentIn); point(13, tangentOut);
        for (let index = 0; index < fits; index++) point(11);
        break;
      }
      if (scenario !== 1) throw new Error('样条编码暂不支持。');
      if (data.b()) splineFlags |= 4;
      if (data.b()) splineFlags |= 1;
      if (data.b()) splineFlags |= 2;
      const knotTolerance = data.bd(), controlTolerance = data.bd();
      const knots = count(data.bl()), controls = count(data.bl());
      const weights = data.b();
      put(70, splineFlags); put(71, degree); put(72, knots); put(73, controls); put(74, 0);
      put(42, knotTolerance); put(43, controlTolerance);
      for (let index = 0; index < knots; index++) put(40, data.bd());
      for (let index = 0; index < controls; index++) {
        point(10);
        if (weights) put(41, data.bd());
      }
      break;
    }
    case 'TEXT':
    case 'ATTRIB':
    case 'ATTDEF': {
      const flags = data.rc();
      const elevation = flags & 1 ? 0 : data.rd();
      const first = realPoint();
      const second = flags & 2 ? first : first.map(value => data.dd(value));
      point(10, [...first, elevation]); point(11, [...second, elevation]);
      normal(); thickness();
      if (!(flags & 4)) put(51, data.rd() * degrees);
      if (!(flags & 8)) put(50, data.rd() * degrees);
      put(40, data.rd());
      if (!(flags & 16)) put(41, data.rd());
      if (inlineText) put(1, strings.text().replaceAll('^', '^ '));
      if (!(flags & 32)) put(71, data.bs());
      if (!(flags & 64)) put(72, data.bs());
      if (!(flags & 128)) put(name === 'TEXT' ? 73 : 74, data.bs());
      if (!inlineText) put(1, strings?.text() ?? '');
      const style = refs.handle(handle);
      if (name === 'TEXT') return { groups, style };
      const version = legacy || dwgVersion <= 1021 ? 0 : data.rc();
      if (!legacy && dwgVersion >= 1032 && data.rc() !== 1) throw new Error('多行块属性暂不支持。');
      const tag = strings?.text();
      if (!tag) throw new Error('块属性缺少标签。');
      const length = data.bs();
      const attributeFlags = data.rc();
      const locked = inlineText ? 0 : data.b();
      const attribute = [[280, version]];
      if (name === 'ATTDEF') {
        if (!legacy && dwgVersion >= 1024) data.rc();
        attribute.push([3, strings?.text() ?? '']);
      }
      attribute.push([2, tag], [70, attributeFlags]);
      if (length) attribute.push([73, length]);
      attribute.push(...groups.filter(([code]) => code === 74), [280, locked]);
      const aligned = groups.some(([code, value]) => (code === 72 || code === 74) && value);
      return { groups: groups.filter(([code]) => code !== 74 && (aligned || ![11, 21, 31].includes(code))), style, attribute };
    }
    case 'MTEXT': {
      point(10); point(210); point(11);
      put(41, data.bd());
      if (!inlineText) put(46, data.bd());
      put(40, data.bd());
      put(71, data.bs()); put(72, data.bs());
      data.bd(); data.bd();
      if (inlineText) groups.push(...textChunks(legacyMtext(strings.text())));
      put(73, data.bs()); put(44, data.bd());
      if (!inlineText) groups.push(...textChunks(strings?.text() ?? ''));
      if (dwgVersion === 1018) {
        data.b();
        const background = data.bl();
        if (background) put(90, background);
        if (background & 1) {
          const scale = data.bd();
          const color = colorData(data, strings);
          put(63, color.index > 0 && color.index < 256 ? color.index : 7);
          if (color.rgb !== undefined) put(421, color.rgb);
          put(45, scale);
          put(441, data.bl());
        }
      }
      return { groups, style: refs.handle(handle) };
    }
    case 'INSERT':
    case 'ACAD_TABLE': {
      groups.push(...insertion(data));
      const hasAttributes = data.b();
      const attributeCount = hasAttributes && !legacy ? count(data.bl(), 8192) : 0;
      if (type === 8) {
        put(70, data.bs()); put(71, data.bs()); put(44, data.bd()); put(45, data.bd());
      }
      const block = refs.handle(handle);
      if (legacy && hasAttributes) return { groups, block, attributeRange: [refs.handle(handle), refs.handle(handle)] };
      const attributes = Array.from({ length: attributeCount }, () => refs.handle(handle));
      return { groups, block, attributes };
    }
    case 'DIMENSION':
    case 'LARGE_RADIAL_DIMENSION':
    case 'ARC_DIMENSION':
      return dimension(object, name);
    case 'WIPEOUT':
      return wipeout(object);
    case 'HATCH':
      return hatch(object);
    case 'LEADER': {
      data.b();
      const creation = data.bs(), pathType = data.bs();
      put(73, creation); put(72, pathType);
      const vertices = count(data.bl(), 65535);
      put(76, vertices);
      let lastVertex;
      for (let index = 0; index < vertices; index++) {
        lastVertex = data.xyz();
        point(10, lastVertex);
      }
      data.xyz();
      point(210);
      const horizontal = data.xyz();
      point(211, horizontal); point(212); point(213);
      if (inlineText) { put(40, data.bd()); put(41, data.bd()); }
      const hookDirection = data.b();
      put(74, hookDirection); put(71, data.b());
      data.bs();
      data.skip(2);
      const annotation = refs.handle(handle);
      if (annotation) put(340, annotation.toString(16).toUpperCase());
      const hook = dwgVersion === 1018 && creation === 0 && pathType === 0 && annotation && vertices >= 2
        ? { vertices, lastVertex, horizontal, hookDirection } : undefined;
      return { groups, dimstyle: refs.handle(handle), hook };
    }
    default:
      throw new Error('不支持的 DWG 图元。');
  }
  return { groups };
}
