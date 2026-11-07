export function validateSavedPart(mesh, metadata) {
  if (mesh.instances !== metadata.solidCount || mesh.unavailable) {
    throw new Error('所选配置有实体无法完整显示，请查看其他配置或补充中性格式。');
  }
  if (!metadata.savedBounds) return;
  // Cached boxes and sampled curved meshes can differ slightly. This detects
  // gross missing/stale geometry; it is not a dimensional acceptance tolerance.
  const tolerance = Math.max(0.05, Math.max(...mesh.size) * 0.0001);
  const actual = [-1, 1].flatMap(sign => mesh.origin.map((value, axis) => value + sign * mesh.size[axis] / 2));
  if (actual.some((value, index) => Math.abs(value - metadata.savedBounds[index]) > tolerance)) {
    throw new Error('所选配置的实体与原件保存的外形范围不一致，可能含未重放修改或过期缓存，暂不提供此配置预览。可选择其他配置。');
  }
}
