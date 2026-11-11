const millimeters = { 'µm': 0.001, mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const volumeWarnings = {
  open: '无法确认模型为闭合实体，暂不能计算重量。',
  orientation: '模型含方向相反的独立壳体，暂不能确认净体积。',
  limit: '模型超过闭合网格的重量计算容量。',
  incomplete: '模型几何未完整读取，暂不能计算重量。',
};
const positive = value => Number.isFinite(value) && value > 0;
const readable = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 6 });
const scientific = new Intl.NumberFormat('zh-CN', { notation: 'scientific', maximumSignificantDigits: 6 });
const format = value => (value >= 1e-4 && value < 1e12 ? readable : scientific).format(value);

export function weightKg(volumeMm3, density) {
  const kg = volumeMm3 / 1e6 * density;
  return positive(volumeMm3) && positive(density) && positive(kg) ? kg : undefined;
}

export function createWeightTools() {
  const field = name => document.getElementById('weight-' + name);
  const toggle = document.getElementById('toggle-weight');
  const panel = field('panel');
  const material = field('material'), density = field('density'), unit = field('unit');
  const area = field('area'), thickness = field('thickness');
  const result = field('result'), note = field('note');
  let scene, page;

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) update();
  }

  function update() {
    const mesh = scene?.mesh;
    const volume = mesh?.volume;
    const incomplete = scene?.previewOnly || scene?.projectionAvailable === false;
    const blocked = mesh && (incomplete || !positive(volume?.value));
    const needUnit = Boolean(mesh && !blocked && !mesh.unit);
    const custom = material.value === 'custom';
    const selectedDensity = custom ? density.valueAsNumber : Number(material.value);
    field('density-field').hidden = !custom;
    field('unit-field').hidden = !needUnit;
    field('area-field').hidden = field('thickness-field').hidden = Boolean(mesh);
    material.disabled = Boolean(blocked);
    density.disabled = Boolean(blocked);
    const basis = mesh
      ? (blocked ? '' : (volume.method === 'brep' ? '本机内核实体体积' : '闭合网格近似体积') + ' · 整个模型按同一材质估算')
      : '二维板件估算，净面积需换算为实际尺寸并扣除孔槽';
    note.textContent = basis && positive(selectedDensity) ? basis + ' · 密度 ' + format(selectedDensity) + ' g/cm³' : basis;

    if (blocked) {
      result.textContent = volumeWarnings[incomplete ? 'incomplete' : volume?.reason] ?? volumeWarnings.open;
      return;
    }
    if (needUnit && !unit.value) {
      result.textContent = '源文件未声明单位，请选择模型长度单位。';
      return;
    }
    if (!mesh && (!positive(area.valueAsNumber) || !positive(thickness.valueAsNumber))) {
      result.textContent = '请输入大于 0 的净面积和板厚。';
      return;
    }
    if (!positive(selectedDensity)) {
      result.textContent = custom ? '请输入大于 0 的密度。' : '请选择材质。';
      return;
    }
    const volumeMm3 = mesh ? volume.value * millimeters[mesh.unit || unit.value] ** 3
      : area.valueAsNumber * thickness.valueAsNumber;
    const kg = weightKg(volumeMm3, selectedDensity);
    result.textContent = kg === undefined ? '计算结果超出可显示范围。'
      : '估算重量 ' + (kg >= 1 ? format(kg) + ' kg' : format(kg * 1000) + ' g') + ' · 体积 ' + format(volumeMm3 / 1000) + ' cm³';
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  for (const input of [material, density, unit, area, thickness]) input.addEventListener('input', update);
  return {
    configure(next, available, nextPage) {
      toggle.hidden = !available;
      if (scene === next && page === nextPage) {
        if (!available) setOpen(false);
        return;
      }
      const keepOpen = !panel.hidden && Boolean(scene?.mesh) === Boolean(next.mesh);
      if (scene !== next) material.value = density.value = '';
      scene = next;
      page = nextPage;
      unit.value = area.value = thickness.value = '';
      setOpen(available && keepOpen);
    },
  };
}
