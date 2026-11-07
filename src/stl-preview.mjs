import { buildMeshScene, decimalPattern } from './mesh-scene.mjs';
import { meshLimits } from './cad-budget.mjs';

const numericTriple = `(${decimalPattern})\\s+(${decimalPattern})\\s+(${decimalPattern})`;
const facet = new RegExp(`facet\\s+normal\\s+${numericTriple}\\s+outer\\s+loop\\s+` +
  `vertex\\s+${numericTriple}\\s+vertex\\s+${numericTriple}\\s+vertex\\s+${numericTriple}\\s+endloop\\s+endfacet(?=\\s|$)`, 'iy');
const solid = /solid(?:[^\S\r\n]+[^\r\n]*)?(?:\r\n|\r|\n)/iy;
const endSolid = /endsolid(?:[^\S\r\n]+[^\r\n]*)?(?=\r|\n|$)/iy;
const space = /\s*/y;

function* binaryTriangles(view, count) {
  if (count > meshLimits.triangles) throw new Error('STL 超过 50 万个三角面。');
  const triangle = new Array(9);
  for (let face = 0; face < count; face++) {
    const start = 96 + 50 * face;
    for (let i = 0; i < 9; i++) triangle[i] = view.getFloat32(start + i * 4, true);
    yield triangle;
  }
}

function* textTriangles(text) {
  let offset = 0;
  function match(pattern) {
    space.lastIndex = offset;
    space.exec(text);
    offset = pattern.lastIndex = space.lastIndex;
    const result = pattern.exec(text);
    if (result) offset = pattern.lastIndex;
    return result;
  }
  while (match(solid)) {
    let face;
    while ((face = match(facet))) yield face.slice(4).map(Number);
    if (!match(endSolid)) throw new Error('STL 文本网格的三角面或结束记录无效。');
  }
  if (offset !== text.length) throw new Error('STL 文本网格包含无法读取的记录。');
}

export function readStlPreview(bytes, expected = false) {
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (bytes.length === 84 + count * 50) return buildMeshScene('STL（二进制）', null, binaryTriangles(view, count));
  }
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bom = source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf ? 3 : 0;
  const prefix = source.toString('latin1', bom, 4096);
  if (/^\s*solid(?=\s)/i.test(prefix)) {
    return buildMeshScene('STL（文本）', null, textTriangles(source.toString('latin1', bom)));
  }
  if (expected) throw new Error('STL 文件头或三角面记录长度无效。');
  return null;
}
