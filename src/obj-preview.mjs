import { meshLimits } from './cad-budget.mjs';
import { buildMeshScene, decimalPattern, meshLabel } from './mesh-scene.mjs';
import { polygonTriangles } from './polygon-mesh.mjs';

const decimal = new RegExp('^' + decimalPattern + '$');
const vertexRef = /^(-?[0-9]+)(?:\/-?[0-9]+(?:\/-?[0-9]+)?|\/\/-?[0-9]+)?$/;

function check(valid, message = 'OBJ 顶点或面的记录无效。') {
  if (!valid) throw new Error(message);
}

export function readObjPreview(bytes, partPath) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const source = data.toString('latin1').replace(/^\xef\xbb\xbf/, '');
  const vertices = [], objects = [];
  let object = { name: '', groups: new Map() }, group = '';
  function label(value) {
    const utf8 = Buffer.from(value, 'latin1').toString('utf8');
    return meshLabel(utf8.includes('�') ? value : utf8);
  }
  const lines = /[^\r\n]+/g;
  let continuation = '', links = 0, style = false;
  for (const [physical] of source.matchAll(lines)) {
    const line = continuation + physical.split('#', 1)[0].trim();
    check(line.length <= 1024 * 1024, 'OBJ 单条记录超过读取容量。');
    if (line.endsWith('\\')) { continuation = line.slice(0, -1) + ' '; continue; }
    continuation = '';
    if (!line) continue;
    const [kind, ...fields] = line.split(/\s+/);
    if (kind === 'v') {
      check(vertices.length < meshLimits.vertices && fields.length >= 3);
      const numeric = fields.slice(0, fields.length === 4 ? 4 : 3);
      check(numeric.every(term => decimal.test(term)));
      const [x, y, z, w = 1] = numeric.map(Number);
      const point = [x / w, y / w, z / w];
      check(point.every(value => Math.abs(value) <= 1e100));
      vertices.push(point);
    } else if (kind === 'f') {
      check(fields.length >= 3 && fields.length <= 16_384);
      links += fields.length - 2;
      check(links <= meshLimits.triangles, 'OBJ 多边形超过预览容量。');
      if (!object.groups.size) objects.push(object);
      if (!object.groups.has(group)) object.groups.set(group, []);
      object.groups.get(group).push(fields.map(field => {
        const index = Number(vertexRef.exec(field)?.[1]);
        check(Number.isSafeInteger(index) && index !== 0);
        const id = index < 0 ? vertices.length + index : index - 1;
        check(id >= 0 && id < meshLimits.vertices);
        return id;
      }));
    } else if (kind === 'o') {
      object = { name: label(fields.join(' ')), groups: new Map() };
      group = '';
    } else if (kind === 'g') group = label(fields[0] ?? '');
    else if (['mtllib', 'usemtl', 'vt'].includes(kind)) style = true;
    else if (['surf', 'curv', 'curv2'].includes(kind)) throw new Error('OBJ 含自由曲线或曲面，请提供多边形网格。');
  }
  check(!continuation && links, 'OBJ 没有可预览的多边形面，或记录不完整。');
  function* triangles() {
    let sequence = 0;
    for (const { name, groups } of objects) {
      sequence++;
      const label = name || '对象 ' + sequence;
      const branch = groups.size > 1 || (name && !groups.has(''));
      if (branch) yield { label };
      for (const [group, polygons] of groups) {
        yield { label: group || (branch ? '默认组' : label), key: polygons };
        for (const polygon of polygons) {
          check(polygon.every(i => i < vertices.length), 'OBJ 的面引用了不存在的顶点。');
          yield* polygonTriangles(polygon.map(i => vertices[i]));
        }
        yield null;
      }
      if (branch) yield null;
    }
  }
  return buildMeshScene('OBJ', null, triangles(), style ? [['OBJ 按对象和分组着色。材质和纹理不参与预览。', 1]] : [], partPath);
}
