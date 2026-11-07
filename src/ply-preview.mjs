import { meshLimits } from './cad-budget.mjs';
import { buildMeshScene, decimalPattern } from './mesh-scene.mjs';
import { polygonTriangles } from './polygon-mesh.mjs';

const types = new Map([
  ['char', ['getInt8', 1, -128, 127]], ['uchar', ['getUint8', 1, 0, 255]],
  ['short', ['getInt16', 2, -32768, 32767]], ['ushort', ['getUint16', 2, 0, 65535]],
  ['int', ['getInt32', 4, -2147483648, 2147483647]], ['uint', ['getUint32', 4, 0, 4294967295]],
  ['float', ['getFloat32', 4]], ['double', ['getFloat64', 8]],
]);
for (const [alias, base] of Object.entries({
  int8: 'char', uint8: 'uchar', int16: 'short', uint16: 'ushort', int32: 'int', uint32: 'uint', float32: 'float', float64: 'double',
})) types.set(alias, types.get(base));

function check(valid, message = 'PLY 的头部或数据记录无效。') {
  if (!valid) throw new Error(message);
}

function header(prefix) {
  const end = /(?:\r\n|\n|\r)end_header[ \t]*(?:\r\n|\n|\r)/.exec(prefix);
  check(end, 'PLY 缺少完整头部。');
  const lines = prefix.slice(0, end.index).split(/\r\n|\n|\r/);
  const [, declaration, ...definitions] = lines;
  const mode = /^format\s+(ascii|binary_little_endian|binary_big_endian)\s+1\.0\s*$/.exec(declaration)?.[1];
  check(mode);
  const elements = new Map();
  let current;
  for (const line of definitions) {
    const [kind, ...args] = line.trim().split(/\s+/);
    if (!kind || kind === 'comment' || kind === 'obj_info') continue;
    if (kind === 'element') {
      const [name, count] = args;
      check(args.length === 2 && /^\d+$/.test(count) && Number(count) <= meshLimits.vertices &&
        !elements.has(name) && elements.size < 64);
      current = { name, count: Number(count), props: new Map() };
      elements.set(name, current);
    } else if (kind === 'property') {
      const list = args[0] === 'list';
      const type = types.get(args[list ? 2 : 0]), countType = list ? types.get(args[1]) : null;
      const name = args.at(-1);
      check(current && args.length === (list ? 4 : 2) && type && (!list || countType?.length === 4) &&
        !current.props.has(name) && current.props.size < 128);
      current.props.set(name, { type, countType });
    } else check(false);
  }
  const vertices = elements.get('vertex'), faces = elements.get('face');
  const indices = faces?.props.has('vertex_indices') ? 'vertex_indices' : 'vertex_index';
  check(vertices?.count && faces?.count && faces.count <= meshLimits.triangles &&
    ['x', 'y', 'z'].every(axis => vertices.props.has(axis) && !vertices.props.get(axis).countType) &&
    faces.props.get(indices)?.countType && faces.props.get(indices).type.length === 4, 'PLY 没有可读取的顶点和多边形索引。');
  return { mode, elements, indices, start: end.index + end[0].length };
}

function bodyReader(data, mode, start) {
  let offset = start;
  if (mode === 'ascii') {
    const source = data.toString('latin1');
    const numeric = new RegExp('\\s*(' + decimalPattern + ')(?=\\s|$)', 'y');
    return {
      read([, , min, max]) {
        numeric.lastIndex = offset;
        const token = numeric.exec(source);
        check(token);
        offset = numeric.lastIndex;
        const value = Number(token[1]);
        check(Number.isFinite(value) && (min === undefined || Number.isInteger(value) && value >= min && value <= max));
        return value;
      },
      end: () => !source.slice(offset).trim(),
    };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    read([method, size]) {
      check(offset + size <= view.byteLength, 'PLY 二进制记录被截断。');
      const value = view[method](offset, mode === 'binary_little_endian');
      offset += size;
      return value;
    },
    end: () => offset === view.byteLength,
  };
}

export function readPlyPreview(bytes, expected = false) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const prefix = data.toString('latin1', 0, 128 * 1024);
  if (!/^ply(?:\r\n|\n|\r)/.test(prefix)) {
    if (expected) throw new Error('文件缺少 PLY 标识。');
    return null;
  }
  const { mode, elements, indices, start } = header(prefix);
  const reader = bodyReader(data, mode, start);
  const vertices = [], polygons = [];
  let triangleCount = 0;
  for (const { name, count, props } of elements.values()) {
    for (let i = 0; i < count; i++) {
      const point = {};
      for (const [property, { type, countType }] of props) {
        if (!countType) {
          const value = reader.read(type);
          if (name === 'vertex' && ['x', 'y', 'z'].includes(property)) point[property] = value;
          continue;
        }
        const size = reader.read(countType);
        check(Number.isInteger(size) && size >= 0 && size <= 16_384, 'PLY 列表超过读取容量。');
        if (name === 'face' && property === indices) {
          check(size >= 3 && (triangleCount += size - 2) <= meshLimits.triangles, 'PLY 多边形超过预览容量。');
          polygons.push(Array.from({ length: size }, () => reader.read(type)));
        } else for (let j = 0; j < size; j++) reader.read(type);
      }
      if (name === 'vertex') {
        const xyz = [point.x, point.y, point.z];
        check(xyz.every(n => Math.abs(n) <= 1e100));
        vertices.push(xyz);
      }
    }
  }
  check(reader.end(), 'PLY 末尾存在额外数据。');
  function* triangles() {
    for (const polygon of polygons) {
      check(polygon.every(i => i >= 0 && i < vertices.length), 'PLY 的面引用了不存在的顶点。');
      yield* polygonTriangles(polygon.map(i => vertices[i]));
    }
  }
  return buildMeshScene('PLY', null, triangles());
}
