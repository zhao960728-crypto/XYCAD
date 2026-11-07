import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { meshLabel, hasArea } from './mesh-scene.mjs';
import { projectionTriangleLimit } from '../public/cad-limits.mjs';

const axes = [0, 1, 2];
const low = () => [Infinity, Infinity, Infinity];
const high = () => [-Infinity, -Infinity, -Infinity];
const maxPartFaces = 1_000_000;
const maxUniqueFaces = 5_000_000;

function include(min, max, a, b = a) {
  for (const i of axes) {
    min[i] = Math.min(min[i], a[i]);
    max[i] = Math.max(max[i], b[i]);
  }
}

function collect(geometry, available) {
  let vertices = new Float64Array(9 * 256), count = 0, visited = 0;
  const min = low(), max = high();
  for (const triangle of geometry()) {
    if (++visited > maxPartFaces) throw new Error('单个零件超过网格容量。');
    if (!triangle.every(value => Math.abs(value) <= 1e100)) throw new Error('零件包含无效坐标。');
    if (!hasArea(triangle)) continue;
    if (count >= available) throw new Error('不同零件的累计网格超过预览容量。');
    if (count * 9 === vertices.length) {
      const next = new Float64Array(Math.min(vertices.length * 2, maxPartFaces * 9));
      next.set(vertices);
      vertices = next;
    }
    vertices.set(triangle, count++ * 9);
    for (const i of axes) {
      min[i] = Math.min(min[i], triangle[i], triangle[i + 3], triangle[i + 6]);
      max[i] = Math.max(max[i], triangle[i], triangle[i + 3], triangle[i + 6]);
    }
  }
  if (!count) throw new Error('零件没有可用的三角面。');
  const size = max.map((value, i) => value - min[i]);
  const origin = min.map((value, i) => value + size[i] / 2);
  const span = Math.max(...size);
  const positions = Buffer.allocUnsafe(count * 36);
  for (let i = 0; i < count * 9; i++) positions.writeFloatLE((vertices[i] - origin[i % 3]) / span, i * 4);
  return { origin, span, size, count, positions };
}

function overview(positions, count) {
  if (count <= 1_200) return null;
  // Collapse nearby vertices to representative source vertices. Try a finer grid
  // first so a thin or sparse part keeps more of its shape.
  for (const divisions of [24, 12]) {
    const vertices = new Map(), faces = new Set(), indices = [];
    for (let i = 0; i < positions.length; i += 36) {
      const triangle = [];
      for (let p = i; p < i + 36; p += 12) {
        const cell = axes.reduce((id, axis) => id * (divisions + 1) +
          Math.floor((positions.readFloatLE(p + axis * 4) + 0.5) * divisions), 0);
        if (!vertices.has(cell)) vertices.set(cell, p);
        triangle.push(vertices.get(cell));
      }
      const [a, b, c] = triangle;
      if (a === b || b === c || c === a) continue;
      const key = [...triangle].sort((a, b) => a - b).join(',');
      if (faces.has(key)) continue;
      faces.add(key);
      indices.push(a, b, c);
    }
    if (indices.length && indices.length < count * 1.8) {
      const result = Buffer.allocUnsafe(indices.length * 12);
      indices.forEach((source, i) => positions.copy(result, i * 12, source, source + 12));
      return result;
    }
  }
  return null;
}

export function assemblyMeshPath(directory, id, coarse = false) {
  return join(directory, id + (coarse ? '.coarse' : '.mesh'));
}

export function buildAssemblyScene(markers, directory, format, asset) {
  const definitions = new Map(), meshes = [], tree = [], stack = [], issues = new Map();
  let uniqueCount = 0, unavailable = 0, instances = 0;
  const min = low(), max = high();

  for (const marker of markers) {
    if (!marker) {
      const node = stack.pop();
      const parent = stack.at(-1);
      if (node.projectionAvailable === false && parent) parent.projectionAvailable = false;
      if (!node.count) continue;
      include(parent?.low ?? min, parent?.high ?? max, node.low, node.high);
      if (parent) parent.count += node.count;
      continue;
    }
    const parent = stack.at(-1);
    const node = { label: meshLabel(marker.label) || '零件', count: 0, low: low(), high: high() };
    (parent?.children ?? tree).push(node);
    stack.push(node);
    if (!marker.geometry) {
      node.children = [];
      continue;
    }
    instances++;
    if (!definitions.has(marker.definition)) {
      let data;
      try { data = collect(marker.geometry, maxUniqueFaces - uniqueCount); }
      catch (error) { definitions.set(marker.definition, { error: error.message }); }
      if (data) {
        const { positions, ...info } = data;
        const id = meshes.length;
        writeFileSync(assemblyMeshPath(directory, id), positions, { flag: 'wx' });
        const coarse = overview(positions, info.count);
        if (coarse) writeFileSync(assemblyMeshPath(directory, id, true), coarse, { flag: 'wx' });
        meshes.push({ count: info.count, coarseCount: coarse ? coarse.length / 36 : 0 });
        definitions.set(marker.definition, { ...info, id, oriented: new Map() });
        uniqueCount += info.count;
      }
    }
    const definition = definitions.get(marker.definition);
    if (definition.error) {
      node.label += '（几何未读取）';
      node.projectionAvailable = false;
      node.color = 0;
      unavailable++;
      issues.set(definition.error, (issues.get(definition.error) ?? 0) + 1);
      continue;
    }
    const { id, count, span, origin, size, oriented } = definition;
    const translate = marker.placement([0, 0, 0]);
    const basis = axes.flatMap(i => marker.placement(axes.map(axis => axis === i ? span : 0))
      .map((value, axis) => value - translate[axis]));
    const center = marker.placement(origin);
    if (![...basis, ...center].every(Number.isFinite)) throw new Error('装配包含无效的实例变换。');
    const orientation = basis.join(',');
    let bounds = oriented.get(orientation);
    if (!bounds) {
      const lower = low(), upper = high();
      // Axis-aligned transforms reach their extremes at the original mesh bounds.
      if (axes.every(row => axes.filter(col => basis[3 * col + row] !== 0).length <= 1)) {
        for (const row of axes) {
          upper[row] = axes.reduce((sum, col) => sum + Math.abs(basis[3 * col + row]) * size[col] / span / 2, 0);
          lower[row] = -upper[row];
        }
      } else {
        const positions = readFileSync(assemblyMeshPath(directory, id));
        for (let offset = 0; offset < positions.length; offset += 12) {
          const x = positions.readFloatLE(offset), y = positions.readFloatLE(offset + 4), z = positions.readFloatLE(offset + 8);
          for (const row of axes) {
            const value = x * basis[row] + y * basis[row + 3] + z * basis[row + 6];
            lower[row] = Math.min(lower[row], value);
            upper[row] = Math.max(upper[row], value);
          }
        }
      }
      bounds = [lower, upper];
      if (oriented.size < 32) oriented.set(orientation, bounds);
    }
    Object.assign(node, { meshId: id, color: id, count, basis, translation: center,
      low: bounds[0].map((value, i) => value + center[i]), high: bounds[1].map((value, i) => value + center[i]) });
  }

  const count = tree.reduce((sum, node) => sum + node.count, 0);
  if (!count) throw new Error(issues.keys().next().value || '装配没有可预览的零件。');
  const size = max.map((value, i) => value - min[i]);
  const origin = min.map((value, i) => value + size[i] / 2);
  const span = Math.max(...size);
  let start = 0;
  function normalize(nodes) {
    for (const node of nodes) {
      node.start = start;
      if (node.count) {
        node.half = node.high.map((value, i) => (value - node.low[i]) / span / 2);
        node.center = node.low.map((value, i) => (value - origin[i]) / span + node.half[i]);
        node.span = Math.max(...node.half) * 2;
      }
      delete node.low;
      delete node.high;
      if (node.children) normalize(node.children);
      else if (node.count) {
        node.basis = node.basis.map(value => value / span);
        node.translation = node.translation.map((value, i) => (value - origin[i]) / span);
        start += node.count;
      }
    }
  }
  normalize(tree);
  const scene = {
    format, mesh: { asset, tree, meshes, unit: 'mm', count, uniqueCount, instances, unavailable, size, origin },
    issues: [['按需加载的预览使用离散网格，测量使用零件的完整预览网格。', 1],
      ...Array.from(issues, ([reason, total]) => ['零件几何未读取。' + reason, total])],
    ...(unavailable && { projectionAvailable: false }),
  };
  writeFileSync(join(directory, 'scene.json'), JSON.stringify(scene), { flag: 'wx' });
  return scene;
}

export function readAssemblyProjection(directory, partPath) {
  const scene = JSON.parse(readFileSync(join(directory, 'scene.json'), 'utf8'));
  let selected = scene.mesh.tree, label;
  if (partPath) {
    let node;
    for (const index of partPath) {
      node = selected?.[index];
      selected = node?.children;
    }
    if (!node?.count || node.projectionAvailable === false) throw new Error('此节点的装配几何未完整读取，暂不能生成三视图。');
    selected = [node];
    label = node.label;
  } else if (scene.projectionAvailable === false) {
    throw new Error('装配几何未完整读取，暂不能生成整套三视图。');
  }
  const count = selected.reduce((sum, node) => sum + node.count, 0);
  if (count > projectionTriangleLimit) throw new Error('三视图目前支持 20 万个三角面以内的模型，请选择较小的装配节点。');
  const positions = new Float64Array(count * 9);
  const meshes = new Map(), min = low(), max = high();
  let next = 0;
  function fill(nodes) {
    for (const node of nodes) {
      if (!node.count) continue;
      if (node.children) { fill(node.children); continue; }
      const { meshId, basis, translation } = node;
      if (!meshes.has(meshId)) meshes.set(meshId, readFileSync(assemblyMeshPath(directory, meshId)));
      const data = meshes.get(meshId);
      for (let i = 0; i < data.length; i += 12) {
        const x = data.readFloatLE(i), y = data.readFloatLE(i + 4), z = data.readFloatLE(i + 8);
        for (const axis of axes) {
          const value = x * basis[axis] + y * basis[axis + 3] + z * basis[axis + 6] + translation[axis];
          positions[next++] = value;
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
    }
  }
  fill(selected);
  const size = max.map((value, axis) => value - min[axis]);
  const center = min.map((value, axis) => value + size[axis] / 2);
  const span = Math.max(...size);
  const bytes = Buffer.allocUnsafe(count * 36);
  for (let i = 0; i < positions.length; i++) bytes.writeFloatLE((positions[i] - center[i % 3]) / span, i * 4);
  return { mesh: { count, unit: scene.mesh.unit, size: size.map(value => value * Math.max(...scene.mesh.size)),
    positions: bytes.toString('base64') }, issues: [], partLabel: label };
}
