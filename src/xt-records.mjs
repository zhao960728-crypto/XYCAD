import { checkXt as check, openXtWire } from './xt-wire.mjs';

// Only the record layouts needed to navigate supported XT bodies and skip
// their ancillary records. Unnamed fields participate in framing only.
const commonGeometry = 'd p p p p p sense:c';
const commonPart = 'd p p';
const baseLayouts = new Map([
  [10, commonPart + ' p p p p p f f p p p u p u instance:p'],
  [11, 'd p u part:p transform:p owner:p forward:p backward:p next:p p'],
  [12, commonPart + ' p p p p f f p p p u p u u p p p p p p p'],
  [13, 'd p body:p p p p p p p'],
  [14, 'd p f p p loop:p shell:p surface:p sense:c p p p p frontShell:p'],
  [15, 'd p fin:p face:p next:p'],
  [16, 'd p tolerance:f p p p curve:p p p p'],
  [17, 'p loop:p next:p previous:p vertex:p p edge:p curve:p p sense:c'],
  [18, 'd p p p p point:p tolerance:f p'],
  [19, 'd p p p p p c'],
  [29, 'd p p p p position:v'],
  [30, commonGeometry + ' v v'],
  [31, commonGeometry + ' position:v axis:v x:v major:f'],
  [32, commonGeometry + ' position:v axis:v x:v major:f minor:f'],
  [38, commonGeometry + ' surfaces:p2 chart:p limitStart:p limitEnd:p'],
  [40, 'firstParameter:f f count:d error:f f f2 samples:h*'],
  [41, 'kind:c samples:h*'],
  [43, 'p n d n p'],
  [44, 'l d f*'],
  [45, 'values:f*'],
  [46, commonGeometry + ' p p f'],
  [50, commonGeometry + ' position:v axis:v x:v'],
  [51, commonGeometry + ' position:v axis:v radius:f x:v'],
  [52, commonGeometry + ' position:v axis:v radius:f sine:f cosine:f x:v'],
  [53, commonGeometry + ' position:v radius:f axis:v x:v'],
  [54, commonGeometry + ' position:v axis:v major:f radius:f x:v'],
  [56, commonGeometry + ' blendKind:c supports:p2 spine:p offsets:f2 rates:f2 p2 p p'],
  [59, commonGeometry + ' side:n blend:p'],
  [60, commonGeometry + ' c l basis:p offsetDistance:f f'],
  [67, commonGeometry + ' basis:p axis:v f'],
  [68, commonGeometry + ' basis:p position:v axis:v v v f f x:v f'],
  [70, 'd p p p d d d d p p d l'],
  [74, 'count:d next:p parts:p*'],
  [79, 'c*'],
  [80, 'p p d u8 p l14 u*'],
  [81, 'd p p p p p p p*'],
  [82, 'd*'],
  [83, 'f*'],
  [84, 'c*'],
  [85, 'v*'],
  [86, 'v*'],
  [87, 'v*'],
  [88, 't*'],
  [89, 'v*'],
  [90, 'd p p p p u p'],
  [91, 'd p p p p p p'],
  [96, 'n*'],
  [97, 'b*'],
  [98, 'w*'],
  [99, 'p*'],
  [100, 'd p p p matrix:f9 offset:v scale:f flags:d v'],
  [101, 'p p p p p p p l p d d'],
  [102, 'c*'],
  [103, 'n d n c p*'],
  [104, 'n d d n n c p*'],
  [105, 'f c p p f f'],
  [109, 'c c i i'],
  [110, 'p p p d p p'],
  [111, 'p p d p p'],
  [112, 'p p p d p p'],
  [120, commonGeometry + ' c p p p*'],
  [121, 'd p p'],
  [122, 'p p p f*'],
  [123, 'i i c c c c'],
  [124, commonGeometry + ' nurbs:p p'],
  [125, 'i i i i u c c c c c c c c c c c c p p p p'],
  [126, 'uPeriodic:l vPeriodic:l uDegree:n vDegree:n uCount:d vCount:d u u d d rational:l l l u dimensions:n points:p uMultiples:p vMultiples:p uKnots:p vKnots:p'],
  [127, 'values:n*'],
  [128, 'values:f*'],
  [130, commonGeometry + ' c p p p*'],
  [132, commonGeometry + ' l p p'],
  [133, commonGeometry + ' basis:p start:v end:v t0:f t1:f'],
  [134, commonGeometry + ' nurbs:p p'],
  [135, 'u p'],
  [136, 'degree:n count:d dimensions:n knotCount:d u periodic:l l rational:l u points:p multiples:p knots:p'],
  [137, commonGeometry + ' surface:p parameterCurve:p p f'],
  [141, 'p p p p'],
  [150, 'position:v axis:v'],
  [151, 'position:v axis:v radius:f sense:c'],
  [152, 'position:v axis:v radius:f sine:f cosine:f sense:c'],
  [153, 'v f c'],
  [154, 'v v f f c'],
  [155, 'v c'],
  [156, 'v v c c'],
  [157, 'v v c'],
  [158, 'f f c c'],
  [184, 'v v v c i f f'],
]);
const legacy10004 = new Map([[17, 'loop:p next:p previous:p vertex:p p edge:p curve:p p sense:c'],
  [40, 'firstParameter:f f count:n error:f f f2 samples:h*'], [80, 'p p d u8 l13 u*'], [103, 'n n n c p*'], [104, 'n n n n n c p*']]);
const legacy20000 = new Map([[12, baseLayouts.get(12) + ' d p p p'], [70, 'd u l p p p d d d p p'],
  [74, 'count:d d next:p parts:p*'], [101, 'p p p p p p p l p p d d d p p']]);
const legacy28002 = new Map([[12, baseLayouts.get(12) + ' p p p p p p p'], [19, baseLayouts.get(19) + ' p'],
  [70, legacy20000.get(70)], [74, legacy20000.get(74)], [176, 'count:d p p p parts:p*']]);
const legacy32001 = new Map([[12, 'd p p p p p p p p f f p p p u p u u p p p p p p p p p p p p p p p p'],
  [19, legacy28002.get(19)], [70, legacy20000.get(70)], [74, legacy20000.get(74)]]);
// This standalone schema points to the tail of the assembly's instance list.
const standalone10004 = new Map([...legacy10004, [11, 'd p u part:p transform:p p next:p p p p'], [135, 'u']]);
const standalone8008 = new Map([...standalone10004, [12, 'd p p p p p p f f p p p u p u p p p p p p p'],
  [70, 'd p p p d d d d p p d'], [137, commonGeometry + ' surface:p parameterCurve:p']]);
const embeddedText34101 = new Map([[163, 'v v f n f c f']]);
const legacyLayouts = new Map([['8008', standalone8008], ['10004', standalone10004], ['13006', new Map()], ['19008', legacy20000], ['20000', legacy20000],
  ['28002', legacy28002], ['32001', legacy32001]]);
const retained = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 29, 30, 31, 32, 38, 40, 41, 45, 50, 51, 52, 53, 54, 56, 59, 60, 67, 68, 74, 100,
  124, 126, 127, 128, 133, 134, 136, 137, 176]);
const fieldsUsed = new Set([...baseLayouts.values()].flatMap(description =>
  [...description.matchAll(/(?:^| )([A-Za-z][A-Za-z0-9]*):/g)].map(match => match[1])));
const geometryKeys = new Map([['halfedge', 'fin'], ['forward', 'next'], ['backward', 'previous'],
  ['pvec', 'position'], ['centre', 'position'], ['normal', 'axis'], ['x_axis', 'x'],
  ['sub_instance', 'instance'], ['next_of_part', 'next'], ['front_shell', 'frontShell'],
  ['entries', 'parts'], ['n_entries', 'count'], ['next_block', 'next'], ['rotation_matrix', 'matrix'],
  ['translation_vector', 'offset'], ['flag', 'flags'], ['major_radius', 'major'], ['minor_radius', 'minor'],
  ['sin_half_angle', 'sine'], ['cos_half_angle', 'cosine'], ['basis_curve', 'basis'], ['point_1', 'start'], ['point_2', 'end'],
  ['parm_1', 't0'], ['parm_2', 't1'], ['surface', 'surface'], ['b_curve', 'parameterCurve'],
  ['n_vertices', 'count'], ['vertex_dim', 'dimensions'], ['n_knots', 'knotCount'], ['bspline_vertices', 'points'],
  ['knot_mult', 'multiples'], ['mult', 'values'], ['hvec', 'samples'], ['chordal_error', 'error'], ['chart_count', 'count'],
  ['u_degree', 'uDegree'], ['v_degree', 'vDegree'], ['n_u_vertices', 'uCount'], ['n_v_vertices', 'vCount'],
  ['u_periodic', 'uPeriodic'], ['v_periodic', 'vPeriodic'],
  ['u_knot_mult', 'uMultiples'], ['v_knot_mult', 'vMultiples'], ['u_knots', 'uKnots'], ['v_knots', 'vKnots']]);

function layout(description) {
  return description.split(' ').map(token => {
    const [name, format] = token.includes(':') ? token.split(':') : [null, token];
    return { name, type: format[0], size: format.endsWith('*') ? -1 : Number(format.slice(1)) || 1, stored: true };
  });
}

export function verifiedXtAssemblyLinks(nodes) {
  const owned = new Map();
  for (const [id, instance] of nodes) if (instance.type === 11) {
    if (nodes.get(instance.owner)?.type !== 10) return null;
    if (!owned.has(instance.owner)) owned.set(instance.owner, new Set());
    owned.get(instance.owner).add(id);
  }
  if (!owned.size) return null;
  const links = new Map();
  for (const [id, assembly] of nodes) if (assembly.type === 10) {
    const unseen = owned.get(id) ?? new Set();
    const chain = [];
    let previous = 0;
    for (let current = assembly.instance; current;) {
      const instance = nodes.get(current);
      if (!unseen.delete(current) || instance.backward !== previous ||
          ![10, 12, 74, 176].includes(nodes.get(instance.part)?.type)) return null;
      chain.push([current, instance]);
      previous = current;
      current = instance.forward;
    }
    if (unseen.size) return null;
    links.set(id, chain);
  }
  return links;
}

export function readXtRecords(bytes, encoding) {
  const wire = openXtWire(bytes, encoding);
  const { schema } = wire;
  const natural = (read, max) => {
    const n = read();
    check(n !== null && n >= 0 && n <= max);
    return n;
  };
  const shortString = () => {
    const value = wire.string();
    check(value.length <= 255);
    return value;
  };
  check(/^: TRANSMIT FILE created by modeller version \d+$/.test(wire.modeler), '当前 Parasolid XT 文件类型超出适配范围。');
  const version = /^SCH_\d+_(\d+)(?:_(\d+))?$/.exec(schema);
  const embedded = version?.[2] === '13006';
  const legacy = !version?.[2] && legacyLayouts.has(version?.[1]);
  check(embedded || legacy, '当前未适配 Parasolid X_T schema ' + schema + '。');
  const maxType = embedded ? natural(wire.short, 4096) : 185;
  check(natural(wire.integer, 65535) === 0, '当前 X_T 文件包含暂未适配的用户字段。');
  function field(recordType) {
    const key = shortString();
    const name = recordType === 11 && (key === 'forward' || key === 'backward') ? key : geometryKeys.get(key) ?? key;
    const pointer = natural(wire.short, 65535);
    const count = natural(wire.pointer, 65535);
    const type = pointer ? 'p' : shortString();
    check(/^[cpldunwftvihb]$/.test(type));
    return { name: fieldsUsed.has(name) ? name : null, type, size: count === 1 ? -1 : count || 1, stored: count !== 1 || wire.logic() };
  }
  function embeddedLayout(type, base) {
    const fields = natural(wire.byte, 255);
    if (fields === 255 && base) return base;
    if (!base) {
      check(type > 185, '当前未适配 Parasolid X_T 节点 ' + type + '。');
      shortString();
      shortString();
      return Array.from({ length: fields }, () => field(type));
    }
    const result = [];
    let index = 0;
    for (let i = 0; i <= 512; i++) {
      const op = wire.char();
      if (op === 'Z') {
        check(result.length === fields, 'Parasolid X_T 嵌入布局与基础布局不符。');
        return result;
      }
      if (op === 'C' || op === 'D') {
        check(index < base.length);
        const previous = base[index++];
        if (op === 'C') result.push(previous);
      } else {
        check(op === 'I' || op === 'A');
        result.push(field(type));
      }
    }
    throw new Error('Parasolid X_T 嵌入布局超过读取容量。');
  }
  function scalar(type) {
    if (type === 'c') return wire.char();
    if (type === 'l') return wire.logic();
    if (type === 'p') return wire.pointer();
    if (type === 'u') return wire.byte();
    if (type === 'n') return wire.signedShort();
    if (type === 'w') return wire.short();
    if (type === 'd' || type === 't') {
      const value = wire.integer();
      return value === -32764 && wire.binary ? null : value;
    }
    if (type === 'f') return wire.real();
    const dimensions = { i: 2, v: 3, h: 3, b: 6 }[type];
    const value = wire.real();
    if (value === null && !wire.binary) return null;
    const values = [value, ...Array.from({ length: dimensions - 1 }, () => wire.real())];
    return values.every(n => n === null) ? null : values;
  }
  const layouts = new Map(), nodes = new Map();
  let hasLinkedAssembly = false;
  while (true) {
    const type = natural(wire.short, maxType);
    if (type === 1) { check(natural(wire.pointer, 0) === 0 && wire.end()); break; }
    try {
      if (!layouts.has(type)) {
        const overrides = legacy ? legacyLayouts.get(version[1])
          : version[1] === '10004' ? legacy10004 : version[1] === '20000' ? legacy20000
            : version[1] === '34101' && !wire.binary ? embeddedText34101 : undefined;
        const description = overrides?.get(type) ?? baseLayouts.get(type);
        const base = description && layout(description);
        const fields = embedded ? embeddedLayout(type, base) : base;
        check(fields, '当前未适配 Parasolid X_T 节点 ' + type + '。');
        layouts.set(type, fields);
      }
      const fields = layouts.get(type);
      const variable = fields.at(-1)?.size === -1 ? natural(wire.integer, 1_000_000) : 0;
      const id = natural(wire.pointer, 16_000_000);
      check(id > 0 && !nodes.has(id) && nodes.size < 1_000_000);
      const node = retained.has(type) ? { type } : null;
      for (const { name, type, size, stored } of fields) {
        if (!stored) continue;
        const count = size === -1 ? variable : size;
        if (size === 1 || type === 'c') {
          const value = size === 1 ? scalar(type) : wire.characters(count);
          if (node && name) node[name] = value;
        } else if (node && name) node[name] = Array.from({ length: count }, () => scalar(type));
        else for (let i = 0; i < count; i++) scalar(type);
      }
      nodes.set(id, node ?? { type });
      if (type === 163 && embedded && version[1] === '34101' && !wire.binary) hasLinkedAssembly = true;
    } catch (error) {
      throw new Error(error.message + '（节点类型 ' + type + '）');
    }
  }
  if (hasLinkedAssembly) for (const [id, node] of nodes) {
    if (node.type !== 11 || !node.forward || nodes.get(node.owner)?.type !== 10) continue;
    const next = nodes.get(node.forward);
    if (next?.type === 11 && next.owner === node.owner && next.backward === id) node.next = node.forward;
  }
  return nodes;
}
