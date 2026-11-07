import { arcPoints, dot, faceTriangles, localPoint, mul, near, requireBrep, sub, worldPoint } from './brep-mesh.mjs';
import { buildMeshScene, MeshPartSelectionError } from './mesh-scene.mjs';
import { meshLimits } from './cad-budget.mjs';
import { readXtRecords, verifiedXtAssemblyLinks } from './xt-records.mjs';
import { xtEncoding } from './xt-wire.mjs';
import { xtCurveEvaluator, xtFrame, xtVector as vector } from './xt-curves.mjs';
import { parametricFace } from './parametric-face.mjs';
import { torusFace } from './toroidal-face.mjs';
import { xtSphericalFace } from './xt-surfaces.mjs';

const splineBudget = '单张 Parasolid 样条面超过求值预算。';
const planeBoundary = '平面边界超出几何容差。';
const splineBoundary = '样条面边界无法落在原曲面上。';
const emptyAssembly = 'Parasolid X_T 装配缺少可读取的实例。';
const assemblyBudget = '完整装配超过当前预览求值时间。';
const tolerantTrimLimit = 0.0025;
const resolutionLimits = new Set(['模型展开后超过 50 万个三角面。', '单个实体面的边界分段超过预览容量。',
  '单个实体面过于复杂。', splineBudget]);

function closeTolerantCylinder(surface, ring, gaps) {
  if (gaps.length !== 1) return;
  const { frame, radius } = surface, turn = 2 * Math.PI;
  const angle = point => {
    const [x, y] = localPoint(frame, point);
    return Math.atan2(y, x);
  };
  const initial = angle(ring[0]);
  let previous = initial;
  for (const point of [...ring.slice(1), ring[0]]) {
    const u = angle(point);
    previous = u + turn * Math.round((previous - u) / turn);
  }
  const winding = Math.round((previous - initial) / turn);
  if (Math.abs(winding) !== 1) return;
  const { index, from, to, vertex, tolerance } = gaps[0];
  const u0 = angle(from), u1 = angle(to);
  const z0 = localPoint(frame, from)[2], dz = localPoint(frame, to)[2] - z0;
  // A finite cylindrical face with one loop needs zero net winding. This
  // chooses the other arc at the sole tolerant junction.
  const sweep = u1 - u0 + turn * Math.round((u0 - u1) / turn) - turn * winding;
  const segments = Math.ceil(Math.abs(sweep) / (Math.PI / 48));
  const margin = Math.hypot(radius * sweep, dz) / (2 * segments);
  const samples = Array.from({ length: segments + 1 }, (_, i) => {
    const t = i / segments, u = u0 + t * sweep;
    return worldPoint(frame, radius * Math.cos(u), radius * Math.sin(u), z0 + t * dz);
  });
  if (margin < tolerance && samples.every(point => near(point, vertex, tolerance - margin))) {
    ring.splice(index + 1, 0, ...samples.slice(1, -1));
  }
}

function* triangles(nodes, resolution, { evaluationLimit, useSourcePlaneTolerance, usePeriodicSections,
  assemblyLinks, recoverTolerantTrims, deadline = Infinity, missingParts, partialLegacy, shared } = {}) {
  function node(id, type) {
    const value = nodes.get(id);
    requireBrep(value && (type === undefined || value.type === type), 'Parasolid X_T 拓扑引用缺失或类型不符。');
    return value;
  }
  const curves = xtCurveEvaluator(node, 8e-6 * resolution, evaluationLimit, usePeriodicSections);
  const arcStep = Math.PI * Math.sqrt(resolution) / 48;
  const faceChord = 1.5e-5 * resolution;
  const faces = new Map();
  for (const [id, face] of nodes) {
    if (face.type !== 14) continue;
    const shell = node(face.shell || face.frontShell, 13);
    node(shell.body, 12);
    if (!faces.has(shell.body)) faces.set(shell.body, []);
    faces.get(shell.body).push(id);
  }
  function* chain(id, type, close = false) {
    const head = id;
    const seen = new Set();
    while (id) {
      if (seen.has(id)) {
        requireBrep(close && id === head, 'Parasolid X_T 拓扑链存在无效循环。');
        return;
      }
      requireBrep(seen.size < 100_000);
      const item = node(id, type);
      seen.add(id);
      yield [id, item];
      id = item.next;
    }
    requireBrep(!close, 'Parasolid X_T 半边环未闭合。');
  }
  const point = id => vector(node(node(id, 18).point, 29).position);
  function curvePoints(geometry, basis, previous, fin, tolerance, anchorTolerances) {
    const trimmed = geometry.type === 133;
    if (![30, 31, 32, 38, 134, 137].includes(basis.type)) {
      throw new Error('Parasolid X_T 包含暂未适配的边曲线类型 ' + basis.type + '。');
    }
    requireBrep(['+', '-'].includes(fin.sense) && ['+', '-'].includes(geometry.sense));
    let direct = fin.sense === geometry.sense;
    let start = previous.vertex ? point(previous.vertex) : null, end = fin.vertex ? point(fin.vertex) : null;
    requireBrep(Boolean(start) === Boolean(end), 'Parasolid X_T 边的顶点不完整。');
    let forward = direct;
    if (trimmed) {
      const a = vector(geometry.start), b = vector(geometry.end);
      requireBrep(typeof geometry.t0 === 'number' && typeof geometry.t1 === 'number' && geometry.t0 !== geometry.t1);
      if (start) {
        const aligns = near(start, a, tolerance) && near(end, b, tolerance);
        const reversed = near(start, b, tolerance) && near(end, a, tolerance);
        requireBrep(aligns || reversed, 'Parasolid X_T 修剪边与顶点不符。');
        if (aligns !== reversed) direct = aligns;
        else if (anchorTolerances) {
          const distance = (p, q) => Math.hypot(...sub(p, q));
          direct = distance(start, a) + distance(end, b) <= distance(start, b) + distance(end, a);
        }
        if (anchorTolerances) {
          const savedStart = direct ? a : b, savedEnd = direct ? b : a;
          if (anchorTolerances[0] >= 2e-7 && near(start, savedStart, anchorTolerances[0])) start = savedStart;
          if (anchorTolerances[1] >= 2e-7 && near(end, savedEnd, anchorTolerances[1])) end = savedEnd;
        }
      } else [start, end] = direct ? [a, b] : [b, a];
      forward = direct === (geometry.t1 > geometry.t0);
    }
    if (basis.type === 30) { requireBrep(start && end); return [start, end]; }
    if (basis.type === 38) return curves.intersectionPoints(basis, start, end, forward, tolerance);
    if (basis.type === 134 || basis.type === 137) {
      const range = trimmed ? [Math.min(geometry.t0, geometry.t1), Math.max(geometry.t0, geometry.t1)] : undefined;
      return curves.splinePoints(basis, start, end, forward, tolerance, range);
    }
    const axes = xtFrame(basis), major = basis.major ?? basis.radius, minor = basis.type === 31 ? major : basis.minor;
    start ??= worldPoint(axes, major, 0, 0);
    end ??= start;
    return arcPoints(axes, major, minor, start, end, forward, tolerance, Boolean(previous.vertex) && previous.vertex === fin.vertex, arcStep);
  }
  function loopPoints(loopId, loop, budget) {
    const points = [], tolerances = [], gaps = [];
    let last, firstVertex, straight = true;
    function join(to, vertexId) {
      if (!last || near(last, to, 1e-9)) return;
      const vertex = point(vertexId), tolerance = Math.min(node(vertexId, 18).tolerance ?? 0, tolerantTrimLimit);
      requireBrep(near(last, vertex, tolerance) && near(to, vertex, tolerance), 'Parasolid 修剪接缝超过原始顶点容差。');
      gaps.push({ index: points.length, from: last, to, vertex, tolerance });
      points.push(last);
      tolerances.push(tolerance);
    }
    for (const [id, fin] of chain(loop.fin, 17, true)) {
      const previous = node(fin.previous, 17);
      requireBrep(fin.loop === loopId && previous.next === id);
      if (!fin.edge && !fin.curve && fin.vertex && fin.next === id && fin.previous === id && fin.sense === '?') {
        return { points: [point(fin.vertex)], tolerances: [budget.tolerance], gaps, straight: false };
      }
      const edge = node(fin.edge, 16);
      const curve = node(edge.curve || fin.curve);
      const basis = curve.type === 133 ? node(curve.basis) : curve;
      straight &&= basis.type === 30;
      const anchors = [previous.vertex, fin.vertex].map(vertex => vertex ? node(vertex, 18).tolerance ?? 0 : 0);
      const tolerance = Math.max(2e-8, edge.tolerance ?? 0, ...anchors);
      const pointTolerance = Math.min(tolerance, recoverTolerantTrims ? tolerantTrimLimit : budget.plane ? 0.001 : 0.0002);
      budget.tolerance = Math.max(budget.tolerance, pointTolerance);
      const sample = curvePoints(curve, basis, previous, fin, tolerance,
        recoverTolerantTrims ? anchors.map(value => Math.min(value, tolerantTrimLimit)) : undefined);
      if (budget.plane) requireBrep(sample.every(p => Math.abs(localPoint(budget.plane, p)[2]) <= Math.max(1e-7, pointTolerance)),
        planeBoundary);
      if (recoverTolerantTrims) {
        firstVertex ??= previous.vertex;
        join(sample[0], previous.vertex);
        last = sample.at(-1);
        for (let i = 1; i < sample.length; i++) tolerances.push(Math.max(1e-7, pointTolerance));
      }
      points.push(...sample.slice(0, -1));
      requireBrep(points.length <= 16_384, 'Parasolid X_T 单个环超过预览容量。');
    }
    if (recoverTolerantTrims && points.length) join(points[0], firstVertex);
    return { points, tolerances, gaps, straight };
  }
  function* body(id) {
    const bodyFaces = faces.get(id);
    requireBrep(bodyFaces?.length, 'Parasolid X_T 实体缺少可读取的面。');
    for (const faceId of bodyFaces) {
      requireBrep(performance.now() < deadline, assemblyBudget);
      const face = node(faceId, 14);
      const surface = node(face.surface);
      requireBrep([50, 51, 52, 53, 54, 56, 60, 67, 68, 124].includes(surface.type), 'Parasolid 包含暂未适配的曲面类型 ' + surface.type + '。');
      const properties = curves.surface(face.surface);
      const loops = [];
      const budget = { tolerance: 1e-7, plane: useSourcePlaneTolerance && surface.type === 50 ? properties.frame : null };
      for (const [id, loop] of chain(face.loop, 15)) {
        requireBrep(loop.face === faceId);
        loops.push(loopPoints(id, loop, budget));
      }
      const rings = loops.map(loop => loop.points);
      if (recoverTolerantTrims && rings.length === 1) {
        if (surface.type === 50 && loops[0].straight && rings[0].length === 2 &&
            rings[0].every(p => Math.abs(localPoint(properties.frame, p)[2]) <= budget.tolerance)) continue;
        if (surface.type === 51) closeTolerantCylinder(properties, rings[0], loops[0].gaps);
      }
      const reverse = face.sense !== surface.sense;
      if (properties.inverse) yield* parametricFace(properties, rings, budget.tolerance, faceChord, reverse,
        recoverTolerantTrims ? loops.map(loop => loop.tolerances) : undefined);
      else if (surface.type === 53) yield* xtSphericalFace(properties.frame.origin, properties.radius, rings, budget.tolerance, faceChord, reverse);
      else if (properties.kind === 54) yield* torusFace(properties.frame, properties.major, properties.radius, rings, budget.tolerance, faceChord, reverse);
      else yield* faceTriangles(properties, rings, budget.tolerance, reverse, recoverTolerantTrims);
    }
  }
  function transform(id, parent) {
    if (!id) return parent;
    const { matrix, offset, scale, flags } = node(id, 100);
    requireBrep(Number.isFinite(scale) && scale !== 0 && !(flags & ~31) && matrix?.length === 9);
    const rows = [vector(matrix.slice(0, 3)), vector(matrix.slice(3, 6)), vector(matrix.slice(6, 9))];
    const translation = vector(offset);
    return p => parent(rows.map((row, i) => (dot(row, p) + translation[i]) * scale));
  }
  const active = new Set();
  let instances = 0;
  function* expand(id, placement, instanceId) {
    requireBrep(performance.now() < deadline, assemblyBudget);
    requireBrep(!active.has(id) && active.size < 48 && ++instances <= 100_000, 'Parasolid X_T 装配存在循环或超过预览容量。');
    active.add(id);
    const part = node(id);
    const suffix = instanceId === undefined ? '' : ' · 实例 ' + instanceId;
    if (part.type === 10) {
      const saved = assemblyLinks?.get(id);
      const empty = saved?.length === 0 && instanceId !== undefined;
      yield { label: '装配体 ' + id + suffix + (empty ? '（空装配）' : ''), keepEmpty: Boolean(saved),
        projectionAvailable: !partialLegacy };
      let count = 0;
      for (const [childId, instance] of saved ?? chain(part.instance, 11)) {
        count++;
        yield* expand(instance.part, transform(instance.transform, placement), childId);
      }
      requireBrep(count || empty, emptyAssembly);
      yield null;
    } else if (part.type === 12) {
      const label = '零件 ' + id + suffix;
      const place = triangle => [0, 3, 6].flatMap(start => mul(placement(triangle.slice(start, start + 3)), 1000));
      if (shared) {
        yield { label, key: id, definition: id, geometry: function* () {
          for (const triangle of body(id)) yield triangle.map(value => value * 1000);
        }, placement: point => mul(placement(mul(point, 0.001)), 1000), keepEmpty: true };
      } else if (missingParts) {
        // Commit a body's geometry only once all its faces have been read.
        const buffer = [];
        try {
          for (const triangle of body(id)) {
            requireBrep(buffer.length < meshLimits.triangles, '单个零件超过预览网格容量。');
            buffer.push(triangle);
          }
        } catch (error) {
          if (error.message === assemblyBudget) throw error;
          missingParts.set(error.message, (missingParts.get(error.message) ?? 0) + 1);
          yield { label: label + '（几何未读取）', key: id, keepEmpty: true, projectionAvailable: false };
          yield null;
          active.delete(id);
          return;
        }
        yield { label, key: id, keepEmpty: true };
        for (const triangle of buffer) yield place(triangle);
      } else {
        yield { label, key: id, keepEmpty: Boolean(assemblyLinks), projectionAvailable: !partialLegacy };
        for (const triangle of body(id)) yield place(triangle);
      }
      yield null;
    } else if (part.type === 74) {
      yield { label: '零件集合 ' + id + suffix, keepEmpty: Boolean(assemblyLinks), projectionAvailable: !partialLegacy };
      for (const [, list] of chain(id, 74)) {
        requireBrep(Array.isArray(list.parts) && list.count > 0 && list.count <= list.parts.length);
        for (const child of list.parts.slice(0, list.count)) yield* expand(child, placement);
      }
      yield null;
    } else if (part.type === 176) {
      requireBrep(Array.isArray(part.parts) && part.count === part.parts.length && part.count > 0);
      yield { label: '零件集合 ' + id + suffix, keepEmpty: Boolean(assemblyLinks), projectionAvailable: !partialLegacy };
      for (const child of part.parts) yield* expand(child, placement);
      yield null;
    } else throw new Error('Parasolid X_T 根模型类型尚未适配。');
    active.delete(id);
  }
  yield* expand(1, p => p);
}

export function readXtPreview(bytes, expected, partPath) {
  const encoding = expected ?? xtEncoding(bytes);
  if (!encoding) return null;
  return previewXtNodes(readXtRecords(bytes, encoding), encoding, partPath);
}

function previewXtNodes(nodes, encoding, partPath) {
  const hasRollingBlend = [...nodes.values()].some(node => node.type === 14 && nodes.get(node.surface)?.type === 56);
  const assemblyLinks = verifiedXtAssemblyLinks(nodes);
  const preview = (resolution, options) => buildMeshScene('Parasolid ' + encoding.toUpperCase(), 'mm',
    triangles(nodes, resolution, options), [
      ['Parasolid 实体曲面离散为三角网格，外包尺寸用于预览。', 1],
      ...(hasRollingBlend ? [['部分圆角按源支撑面与中心轨迹重建。', 1]] : []),
      ...(resolution > 1 ? [['复杂模型使用较低的曲面离散精度。', 1]] : []),
      ...(options.useSourcePlaneTolerance ? [['部分平面边界按源文件记录的容差投影。', 1]] : []),
      ...(options.recoverTolerantTrims ? [['部分退化边界和圆柱接缝按源文件顶点容差重建。', 1]] : []),
    ], partPath);
  function convert(options) {
    try {
      return preview(1, options);
    } catch (error) {
      if (error.message === planeBoundary) return preview(1, { ...options, useSourcePlaneTolerance: true });
      if (error.message === splineBoundary) return preview(1, { ...options, usePeriodicSections: true });
      if (error.message === '实体边界的几何或引用不一致。' &&
          [...nodes.values()].some(node => node.type === 18 && node.tolerance > 0.0002)) {
        return preview(1, { ...options, recoverTolerantTrims: true });
      }
      // Coarser sampling keeps the same topology checks and scene limits.
      if (!resolutionLimits.has(error.message)) throw error;
      for (const resolution of [2, error.message === splineBudget ? 16 : 4]) {
        try { return preview(resolution, { ...options, evaluationLimit: 24_000_000 }); }
        catch (retry) {
          if (retry instanceof MeshPartSelectionError || retry.message === assemblyBudget) throw retry;
        }
      }
      throw error;
    }
  }
  if (!assemblyLinks) return convert({});
  // Reserve most of the job timeout for the legacy preview if expansion stalls.
  const options = { assemblyLinks, deadline: performance.now() + 17_000 };
  try {
    return convert(options);
  } catch (error) {
    if (error instanceof MeshPartSelectionError) throw error;
    if (error.message !== assemblyBudget && !resolutionLimits.has(error.message)) {
      const missingParts = new Map();
      try {
        const scene = preview(1, { ...options, missingParts });
        for (const [reason, count] of missingParts) scene.issues.push(['零件几何未读取。' + reason, count]);
        return scene;
      } catch (partialError) {
        if (partialError instanceof MeshPartSelectionError) throw partialError;
      }
    }
    const scene = convert({ partialLegacy: true });
    scene.issues.push(['完整装配暂无法预览，当前显示可读取的实例子集。' + error.message, 1]);
    return scene;
  }
}

export function readXtAssembly(bytes, encoding) {
  const nodes = readXtRecords(bytes, encoding);
  if (nodes.get(1)?.type !== 10) return { scene: previewXtNodes(nodes, encoding) };
  const assemblyLinks = verifiedXtAssemblyLinks(nodes);
  if (!assemblyLinks) return { scene: previewXtNodes(nodes, encoding) };
  return { markers: triangles(nodes, 1, { shared: true, assemblyLinks, useSourcePlaneTolerance: true,
    usePeriodicSections: true, recoverTolerantTrims: true, evaluationLimit: 24_000_000 }) };
}
