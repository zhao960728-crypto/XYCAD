import { axes, cross, faceTriangles, requireBrep, sub } from './brep-mesh.mjs';

export function* polygonTriangles(points) {
  if (points.length === 3) { yield points.flat(); return; }
  requireBrep(points.length >= 3 && points.length <= 16_384, '多边形面的顶点数量无效。');
  const origin = points[0];
  const directions = points.slice(1).map(p => sub(p, origin));
  let scale = 0, axis;
  for (const direction of directions) {
    const length = Math.hypot(...direction);
    if (length > scale) { scale = length; axis = direction; }
  }
  requireBrep(scale > 0, '多边形面顶点重合。');
  const reference = axis.map(value => value / scale);
  let normal, area = 0;
  for (const direction of directions) {
    const n = cross(reference, direction);
    const size = Math.hypot(...n);
    if (size > area) { area = size; normal = n; }
  }
  requireBrep(area > scale * 1e-12, '多边形面的顶点共线。');
  yield* faceTriangles({ frame: axes(origin, normal, reference) }, [points], scale * 1e-6);
}
