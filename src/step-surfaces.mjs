import { mul, requireBrep } from './brep-mesh.mjs';
import { parametricSurface } from './parametric-face.mjs';
import { splineAxis } from './spline-basis.mjs';

export function stepSplineSurface(surface, point) {
  const [uDegree, vDegree, controls] = surface.components?.get('B_SPLINE_SURFACE') ?? surface.args?.slice(1) ?? [];
  const [uMultiples, vMultiples, uKnots, vKnots] = surface.components?.get('B_SPLINE_SURFACE_WITH_KNOTS') ?? surface.args?.slice(8) ?? [];
  const rational = surface.components?.get('RATIONAL_B_SPLINE_SURFACE');
  const weights = rational?.[0];
  const uCount = controls?.length, vCount = controls?.[0]?.length;
  requireBrep(Array.isArray(controls) && vCount > 0 && uCount * vCount <= 16_384 &&
    controls.every(row => Array.isArray(row) && row.length === vCount), 'STEP 样条面控制点阵列无效。');
  requireBrep(!rational || Array.isArray(weights) && weights.length === uCount && weights.every(row =>
    Array.isArray(row) && row.length === vCount && row.every(w => Number.isFinite(w) && w > 0)), 'STEP 样条面权重无效。');
  const uAxis = splineAxis(uDegree, uCount, uKnots, uMultiples);
  const vAxis = splineAxis(vDegree, vCount, vKnots, vMultiples);
  const rows = controls.map((row, i) => row.map((id, j) => {
    const p = point(id);
    if (!rational) return p;
    const weight = weights[i][j];
    return [...mul(p, weight), weight];
  }));
  let operations = 0;
  const divisions = [uAxis, vAxis].map(axis => Math.min(64, Math.max(8, 2 * (axis.spans.length - 1))));
  return parametricSurface((u, v) => {
    operations += (uDegree + 1) * (vDegree + 1);
    requireBrep(operations <= 3_000_000, '单张 STEP 样条面超过求值预算。');
    const t = vAxis.low + (vAxis.high - vAxis.low) * v;
    const p = uAxis.evaluateWith(i => vAxis.evaluate(rows[i], t), uAxis.low + (uAxis.high - uAxis.low) * u);
    return rational ? mul(p.slice(0, 3), 1 / p[3]) : p;
  }, divisions);
}
