import { buildMeshScene, decimalPattern, meshLabel } from './mesh-scene.mjs';
import { meshLimits } from './cad-budget.mjs';

const core = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const startPart = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const units = new Map([['micron', 'µm'], ['millimeter', 'mm'], ['centimeter', 'cm'],
  ['inch', 'in'], ['foot', 'ft'], ['meter', 'm']]);
const decimal = new RegExp(`^${decimalPattern}$`);
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function check(valid, message = '3MF 的模型 XML 或引用无效。') {
  if (!valid) throw new Error(message);
}

function decodeAttribute(value) {
  if (!value.includes('&')) return value;
  return value.replace(/&([^;\s&]{1,16});|&/g, (_, key) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, key)) return named[key];
    const code = /^#x[0-9a-f]+$/i.test(key) ? parseInt(key.slice(2), 16)
      : /^#\d+$/.test(key) ? Number(key.slice(1)) : 0;
    check(code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff));
    return String.fromCodePoint(code);
  });
}

// Visit opening tags without storing the XML tree. DTDs and processing
// instructions are outside the supported 3MF model and OPC relationship syntax.
function walkXml(bytes, maxElements, visit) {
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const tags = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y;
  const attribute = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  const stack = [];
  let offset = 0, count = 0;
  while (offset < text.length) {
    const start = text.indexOf('<', offset);
    if (stack.at(-1)?.kind !== 'text') check(!text.slice(offset, start < 0 ? text.length : start).trim());
    if (start < 0) break;
    const marker = text.startsWith('<!--', start) ? '-->'
      : !count && /^<\?xml\s/.test(text.slice(start, start + 7)) ? '?>'
        : stack.at(-1)?.kind === 'text' && text.startsWith('<![CDATA[', start) ? ']]>' : null;
    if (marker) {
      const end = text.indexOf(marker, start + (marker === '-->' ? 4 : marker === '?>' ? 6 : 9));
      check(end >= 0);
      offset = end + marker.length;
      continue;
    }
    tags.lastIndex = start;
    const token = tags.exec(text);
    check(token && token[0].length <= 16_384);
    offset = tags.lastIndex;
    const [, close, name, body] = token;
    if (close) {
      check(!body.trim() && stack.pop()?.name === name);
      continue;
    }
    check((stack.length || !count) && stack.length < 48 && ++count <= maxElements,
      '3MF 的 XML 结构超出读取容量或有多个根元素。');
    const empty = body.endsWith('/');
    const attributes = (empty ? body.slice(0, -1) : body).trimEnd();
    const props = Object.create(null);
    const parent = stack.at(-1);
    let namespaces = parent?.namespaces ?? null;
    let localNamespaces = false;
    attribute.lastIndex = 0;
    while (attribute.lastIndex < attributes.length) {
      const match = attribute.exec(attributes);
      check(match && !Object.hasOwn(props, match[1]));
      const key = match[1], value = decodeAttribute(match[2] ?? match[3]);
      props[key] = value;
      if (key === 'xmlns' || key.startsWith('xmlns:')) {
        if (!localNamespaces) namespaces = Object.create(namespaces);
        localNamespaces = true;
        namespaces[key === 'xmlns' ? '' : key.slice(6)] = value;
      }
    }
    const separator = name.indexOf(':');
    const ns = namespaces?.[separator < 0 ? '' : name.slice(0, separator)];
    const tag = name.slice(separator + 1);
    const frame = visit({ tag, ns, props }, parent) ?? { kind: 'text' };
    if (!empty) stack.push({ ...frame, name, namespaces });
  }
  check(count && !stack.length);
}

function modelPart(zip) {
  if (!zip?.has('_rels/.rels') || !zip.has('[Content_Types].xml')) return null;
  let target;
  walkXml(zip.read('_rels/.rels'), 4096, ({ tag, ns, props }, parent) => {
    if (!parent) {
      // Some existing DWFx packages omit the default namespace.
      check(tag === 'Relationships' && (!ns || ns === relationships));
      return { kind: 'rels' };
    }
    if (parent.kind !== 'rels' || tag !== 'Relationship' || ns !== relationships || props.Type !== startPart) return;
    check(target === undefined && (props.TargetMode === undefined || props.TargetMode === 'Internal'),
      '3MF 的起始模型引用无效。');
    const path = props.Target?.replace(/^\//, '');
    check(path && path.length <= 1024 && !/[\\:#?\0]/.test(path) &&
      path.split('/').every(segment => segment && segment !== '.' && segment !== '..'),
    '3MF 的起始模型路径无效。');
    target = path;
  });
  return target;
}

function number(value) {
  check(value !== undefined && decimal.test(value) && Math.abs(Number(value)) <= 1e100);
  return Number(value);
}

function index(value, min, max) {
  const result = Number(value);
  check(value !== undefined && /^\+?\d+$/.test(value) && result >= min && result < max);
  return result;
}

function reference(props) {
  check(!Object.keys(props).some(key => key.endsWith(':path')),
    '此 3MF 引用其他模型部件，当前支持单模型部件的 3MF Core。');
  const transform = props.transform === undefined ? identity : props.transform.trim().split(/\s+/).map(number);
  check(transform.length === 12);
  return { id: index(props.objectid, 1, 0x80000000), transform };
}

function readModel(bytes) {
  const objects = new Map(), items = [];
  let unit, resources = false, build = false, vertexCount = 0, triangleCount = 0, components = 0;
  walkXml(bytes, meshLimits.vertices + meshLimits.triangles + meshLimits.instances * 2, ({ tag, ns, props }, parent) => {
    if (!parent) {
      check(tag === 'model' && ns === core);
      check(!props.requiredextensions?.trim(), '此 3MF 要求当前未支持的扩展。');
      unit = units.get(props.unit ?? 'millimeter');
      check(unit, '3MF 声明了未知的长度单位。');
      return { kind: 'model' };
    }
    if (ns !== core) return;
    const object = parent.object;
    switch (`${parent.kind}/${tag}`) {
      case 'model/resources':
        check(!resources);
        resources = true;
        return { kind: 'resources' };
      case 'model/build':
        check(!build);
        build = true;
        return { kind: 'build' };
      case 'resources/object': {
        const id = index(props.id, 1, 0x80000000);
        check(!objects.has(id) && objects.size < meshLimits.instances);
        const model = { name: meshLabel(props.name) };
        objects.set(id, model);
        return { kind: 'object', object: model };
      }
      case 'object/mesh':
        check(!object.mesh && !object.components);
        object.mesh = {};
        return { kind: 'mesh', object };
      case 'mesh/vertices':
        check(!object.mesh.vertices);
        object.mesh.vertices = [];
        return { kind: 'vertices', object };
      case 'mesh/triangles':
        check(object.mesh.vertices && !object.mesh.triangles);
        object.mesh.triangles = [];
        return { kind: 'triangles', object };
      case 'vertices/vertex':
        check(++vertexCount <= meshLimits.vertices, '3MF 顶点数量超过 75 万。');
        object.mesh.vertices.push(number(props.x), number(props.y), number(props.z));
        break;
      case 'triangles/triangle': {
        check(++triangleCount <= meshLimits.triangles, '3MF 三角面数量超过 50 万。');
        const max = object.mesh.vertices.length / 3;
        object.mesh.triangles.push(index(props.v1, 0, max), index(props.v2, 0, max), index(props.v3, 0, max));
        break;
      }
      case 'object/components':
        check(!object.mesh && !object.components);
        object.components = [];
        return { kind: 'components', object };
      case 'components/component':
        check(++components <= meshLimits.instances);
        object.components.push(reference(props));
        break;
      case 'build/item':
        check(items.length < meshLimits.instances);
        items.push(reference(props));
        break;
    }
  });
  check(build && resources && items.length, '3MF 未保存可预览的构建对象。');
  return { objects, items, unit };
}

function transformCoordinate(matrix, x, y, z, axis) {
  return x * matrix[axis] + y * matrix[3 + axis] + z * matrix[6 + axis] + matrix[9 + axis];
}

function compose(local, parent) {
  if (parent === identity) return local;
  if (local === identity) return parent;
  const result = new Array(12);
  for (let row = 0; row < 12; row += 3) {
    for (let axis = 0; axis < 3; axis++) {
      result[row + axis] = local[row] * parent[axis] + local[row + 1] * parent[3 + axis] +
        local[row + 2] * parent[6 + axis] + (row === 9 ? parent[9 + axis] : 0);
    }
  }
  return result;
}

function* modelTriangles({ objects, items }) {
  const active = new Set();
  let instances = 0;
  function* expandRefs(refs, parent) {
    const repeated = new Set();
    const seen = new Map();
    for (const { id } of refs) {
      if (seen.has(id)) repeated.add(id);
      else seen.set(id, 0);
    }
    for (const ref of refs) {
      const number = seen.get(ref.id) + 1;
      seen.set(ref.id, number);
      yield* expand(ref, parent, repeated.has(ref.id) ? ' · 实例 ' + number : '');
    }
  }
  function* expand(ref, parent, suffix) {
    check(!active.has(ref.id) && active.size < 48 && ++instances <= meshLimits.instances,
      '3MF 组件引用循环或展开数量超出容量。');
    const object = objects.get(ref.id);
    check(object, '3MF 引用了不存在的对象。');
    const matrix = compose(ref.transform, parent);
    if (object.components?.length) {
      yield { label: (object.name || '装配体 ' + ref.id) + suffix };
      active.add(ref.id);
      yield* expandRefs(object.components, matrix);
      active.delete(ref.id);
      yield null;
      return;
    }
    const { vertices, triangles } = object.mesh ?? {};
    check(triangles?.length, '3MF 构建对象缺少三角网格。');
    yield { label: (object.name || '零件 ' + ref.id) + suffix, key: ref.id };
    const triangle = new Array(9);
    for (let i = 0; i < triangles.length; i += 3) {
      for (let v = 0; v < 3; v++) {
        const start = triangles[i + v] * 3;
        for (let axis = 0; axis < 3; axis++) {
          triangle[v * 3 + axis] = transformCoordinate(matrix, vertices[start], vertices[start + 1], vertices[start + 2], axis);
        }
      }
      yield triangle;
    }
    yield null;
  }
  yield* expandRefs(items, identity);
}

export function read3mfPreview(zip, expected = false, partPath) {
  const part = modelPart(zip);
  if (!part) {
    if (expected) throw new Error('此压缩包缺少 3MF 起始模型关系。');
    return null;
  }
  check(zip.has(part), '3MF 压缩包缺少起始模型部件。');
  const model = readModel(zip.read(part));
  return buildMeshScene('3MF', model.unit, modelTriangles(model),
    [['3MF 以组件区分颜色，纹理和打印设置不参与预览。', 1]], partPath);
}
