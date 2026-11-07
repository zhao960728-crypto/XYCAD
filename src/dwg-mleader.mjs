import { coordinates, legacyMtext } from './dwg-ac1032-entities.mjs';

function count(data, limit = 8192) {
  const value = data.bl();
  if (value > limit) throw new Error('多重引线的对象数量超限。');
  return value;
}

function writer({ data, refs, handle }) {
  const groups = [];
  const put = (code, value) => groups.push([code, value]);
  const read = (code, method) => put(code, data[method]());
  const point = code => groups.push(...coordinates(code, data.xyz()));
  const ref = code => {
    const id = refs.handle(handle);
    if (id) put(code, id.toString(16).toUpperCase());
    return id;
  };
  const color = code => {
    data.bs();
    put(code, data.bl() | 0);
    const flags = data.rc();
    if (flags & 1) data.text();
    if (flags & 2) data.text();
  };
  return { groups, put, read, point, ref, color };
}

function readBranches(data, { put, read, point }) {
  const roots = count(data);
  let budget = 100000;
  const points = (length, ...codes) => {
    budget -= length * codes.length;
    if (budget < 0) throw new Error('多重引线的顶点数量超限。');
    for (let i = 0; i < length; i++) for (const code of codes) point(code);
  };
  for (let root = 0; root < roots; root++) {
    put(302, 'LEADER{');
    read(290, 'b'); read(291, 'b'); point(10); point(11);
    points(count(data), 12, 13);
    read(90, 'bl'); read(40, 'bd');
    const lines = count(data);
    for (let line = 0; line < lines; line++) {
      put(304, 'LEADER_LINE{');
      points(count(data), 10);
      const breaks = count(data);
      for (let index = 0; index < breaks; index++) {
        read(90, 'bl');
        points(count(data), 11, 12);
      }
      read(91, 'bl');
      put(305, '}');
    }
    put(271, 0); put(303, '}');
  }
}

// AC1018 stores the older inline annotation context and the handle references separately.
export function readAc1018MLeader(object) {
  const { data, refs } = object;
  const out = writer(object);
  const { groups, put, read, point, ref, color } = out;
  const branches = writer(object);
  readBranches(data, branches);
  put(270, 2);
  put(300, 'CONTEXT_DATA{');
  read(40, 'bd'); point(10); read(41, 'bd'); read(140, 'bd'); read(145, 'bd');
  for (const code of [174, 175, 176, 177]) read(code, 'bs');
  const hasText = data.b();
  put(290, hasText);
  if (hasText) {
    put(304, legacyMtext(data.text())); point(11); ref(340); point(12); point(13);
    for (const code of [42, 43, 44, 45]) read(code, 'bd');
    read(170, 'bs'); color(90); read(171, 'bs'); read(172, 'bs'); color(91);
    read(141, 'bd'); read(92, 'bl'); read(291, 'b'); read(292, 'b');
    read(173, 'bs'); read(293, 'b'); read(142, 'bd'); read(143, 'bd'); read(294, 'b');
    const columns = count(data);
    for (let index = 0; index < columns; index++) read(144, 'bd');
    read(295, 'b'); data.b();
  } else if (data.b()) throw new Error('暂不支持带图块内容的 DWG 多重引线。');
  put(296, 0);
  point(110); point(111); point(112); read(297, 'b');
  for (const group of branches.groups) groups.push(group);
  put(272, 9); put(273, 9); put(301, '}');
  const mleaderStyle = ref(340);
  read(90, 'bl'); read(170, 'bs'); color(91); ref(341); put(171, data.bl() | 0);
  read(290, 'b'); read(291, 'b'); read(41, 'bd');
  const block = ref(342);
  read(42, 'bd'); read(172, 'bs'); ref(343);
  for (const code of [173, 95, 174, 175]) read(code, 'bs');
  color(92); read(292, 'b'); ref(344); color(93); point(10);
  read(43, 'bd'); read(176, 'bs'); read(293, 'b');
  const arrows = count(data);
  const arrowBlocks = [];
  for (let index = 0; index < arrows; index++) {
    read(94, 'b'); arrowBlocks.push(ref(345));
  }
  if (count(data)) throw new Error('暂不支持带块属性的 DWG 多重引线。');
  read(294, 'b'); read(178, 'bs'); read(179, 'bs'); read(45, 'bd');
  put(271, 0); put(272, 9); put(273, 9); put(295, 0);
  if (data.pos !== data.end || refs.end - refs.pos >= 8) throw new Error('DWG 多重引线字段未对齐。');
  return { groups, mleaderStyle, block, arrowBlocks };
}

export function readAc1018MLeaderStyle(object) {
  const { data, refs, handle } = object;
  const reactors = count(data);
  const noDictionary = data.b();
  for (let index = 0; index < 1 + reactors + !noDictionary; index++) refs.handle(handle);
  const dataStart = data.pos, refsStart = refs.pos;
  function readStyle(newFormat) {
    const { groups, put, read, ref, color } = writer(object);
    put(179, 2);
    for (const code of [170, 171, 172]) read(code, 'bs');
    read(90, 'bl'); read(40, 'bd'); read(41, 'bd'); read(173, 'bs');
    color(91); ref(340); put(92, data.bl() | 0);
    read(290, 'b'); read(42, 'bd'); read(291, 'b'); read(43, 'bd');
    const name = data.text();
    put(3, name); const arrow = ref(341); read(44, 'bd');
    put(300, legacyMtext(data.text())); ref(342); read(174, 'bs'); read(178, 'bs');
    put(175, newFormat ? data.bs() : 1); read(176, 'bs'); color(93); read(45, 'bd');
    read(292, 'b'); put(297, newFormat ? data.b() : 0); read(46, 'bd');
    ref(343); color(94);
    for (const code of [47, 49, 140]) read(code, 'bd');
    read(293, 'b'); read(141, 'bd'); read(294, 'b'); read(177, 'bs'); read(142, 'bd');
    read(295, 'b'); read(296, 'b'); read(143, 'bd');
    put(271, 0); put(272, 9); put(273, 9); put(298, 0);
    if (data.pos !== data.end || refs.end - refs.pos >= 8 || groups.some(([, value]) => typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('DWG 多重引线样式字段未对齐。');
    }
    return { name, groups, arrow };
  }
  try {
    return readStyle(true);
  } catch {
    data.pos = dataStart;
    refs.pos = refsStart;
    return readStyle(false);
  }
}
