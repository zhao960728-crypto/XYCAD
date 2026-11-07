import { meshLimits } from './cad-budget.mjs';
import { buildMeshScene, decimalPattern } from './mesh-scene.mjs';
import { polygonTriangles } from './polygon-mesh.mjs';

const decimal = new RegExp('^' + decimalPattern + '$');
const integer = /^\+?[0-9]+$/;

function check(valid, reason = 'OFF 网格的记录无效或文件不完整。') {
  if (!valid) throw new Error(reason);
}

function textReader(source, start) {
  const tokens = /#[^\r\n]*|[^\s#]+/g;
  const faceTail = /[^#\r\n]*/y;
  tokens.lastIndex = start;
  function next() {
    let match;
    while ((match = tokens.exec(source))) {
      if (!match[0].startsWith('#')) return match[0];
    }
  }
  function read(pattern) {
    const token = next();
    check(token !== undefined && pattern.test(token));
    return Number(token);
  }
  return {
    int: () => read(integer),
    float: () => read(decimal),
    colors() {
      faceTail.lastIndex = tokens.lastIndex;
      const tail = faceTail.exec(source)[0].trim();
      tokens.lastIndex = faceTail.lastIndex;
      if (!tail) return 0;
      const fields = tail.split(/\s+/);
      check((fields.length === 1 ? integer.test(fields[0]) : fields.length === 3 || fields.length === 4) &&
        fields.every(value => decimal.test(value) && Number.isFinite(Number(value))), 'OFF 面颜色记录无效。');
      return fields.length;
    },
    end: () => next() === undefined,
  };
}

function binaryReader(data, start) {
  let offset = start;
  function read(method) {
    check(offset + 4 <= data.length);
    const value = data[method](offset);
    offset += 4;
    return value;
  }
  return {
    int: () => read('readUInt32BE'),
    float: () => read('readFloatBE'),
    colors() {
      const count = read('readUInt32BE');
      check(count <= 4, 'OFF 二进制面颜色记录无效。');
      for (let i = 0; i < count; i++) check(Number.isFinite(read('readFloatBE')));
      return count;
    },
    end: () => offset === data.length,
  };
}

export function readOffPreview(bytes, expected = false) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prefix = data.toString('latin1', 0, 8192);
  const bom = prefix.startsWith('\xef\xbb\xbf') ? 3 : 0;
  const first = Array.from(prefix.slice(bom).matchAll(/#[^\r\n]*|[^\s#]+/g)).find(match => !match[0].startsWith('#'));
  const header = first?.[0] === 'OFF';
  if (!header && !expected) return null;
  const start = header ? bom + first.index + 3 : bom;
  const binary = header && /^[ \t]+BINARY[ \t]*(?:#[^\r\n]*)?\r?\n/.exec(prefix.slice(start));
  const reader = binary ? binaryReader(data, start + binary[0].length) : textReader(data.toString('latin1'), start);
  const vertexCount = reader.int(), faceCount = reader.int(), edgeCount = reader.int();
  check(vertexCount >= 3 && vertexCount <= meshLimits.vertices && faceCount >= 1 &&
    faceCount <= meshLimits.triangles && Number.isSafeInteger(edgeCount), 'OFF 网格的顶点数或面数超出读取范围。');
  const vertices = Array.from({ length: vertexCount }, () => {
    const point = [reader.float(), reader.float(), reader.float()];
    check(point.every(value => Math.abs(value) <= 1e100), 'OFF 包含无效坐标。');
    return point;
  });
  const issues = [];
  function* triangles() {
    let total = 0, colored = 0;
    for (let i = 0; i < faceCount; i++) {
      const count = reader.int();
      check(count >= 3 && count <= 16_384 && (total += count - 2) <= meshLimits.triangles, 'OFF 多边形超过读取容量。');
      const polygon = Array.from({ length: count }, () => {
        const vertex = reader.int();
        check(vertex < vertexCount, 'OFF 的面引用了不存在的顶点。');
        return vertices[vertex];
      });
      if (reader.colors()) colored++;
      yield* polygonTriangles(polygon);
    }
    check(reader.end(), 'OFF 文件末尾存在额外数据。');
    if (colored) issues.push(['OFF 面颜色未用于预览。', colored]);
  }
  return buildMeshScene(binary ? 'OFF（二进制）' : 'OFF（文本）', null, triangles(), issues);
}
