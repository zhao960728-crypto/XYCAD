import {addProjectionFrame} from './projection-frame.mjs';
import {addProjectionDimensions} from './projection-dimensions.mjs';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { hasDxfHeader, key, name, parseDxf } from './dxf-parser.mjs';
import { projectionHiddenLayers } from '../public/cad-limits.mjs';
import { buildScene } from './dxf-scene.mjs';
import { dxfExportBytes, sceneLimits } from './cad-budget.mjs';
import { dwgVersion, readDwgPreview } from './dwg-preview.mjs';
import { convertAc1015, convertAc1018, convertAc102x, convertAc1032 } from './dwg-ac1032-dxf.mjs';
import { openExb, readExbPreview } from './exb-preview.mjs';
import { readExbVector } from './exb-vector.mjs';
import { readDwfxPreview } from './dwfx-preview.mjs';
import { openCadPackage } from './dwfx-zip.mjs';
import { read3mfPreview } from './3mf-preview.mjs';
import { readStlPreview } from './stl-preview.mjs';
import { readStepPreview } from './step-preview.mjs';
import { readXtPreview } from './xt-preview.mjs';
import { readObjPreview } from './obj-preview.mjs';
import { readPlyPreview } from './ply-preview.mjs';
import { readOffPreview } from './off-preview.mjs';
import { readSolidWorksSheets } from './slddrw-preview.mjs';
import { readSolidWorksVector, SolidWorksVectorUnavailable } from './slddrw-vector.mjs';
import { writeVectorDxf } from './dxf-write.mjs';
import { buildOrthographic } from './mesh-projection.mjs';
import { writeProjectionPdf } from './projection-pdf.mjs';

const nativeConverters = new Map([
  ['AC1015', convertAc1015], ['AC1018', convertAc1018], ['AC1021', (bytes, options) => convertAc102x(bytes, 'AC1021', options)],
  ['AC1024', (bytes, options) => convertAc102x(bytes, 'AC1024', options)],
  ['AC1027', (bytes, options) => convertAc102x(bytes, 'AC1027', options)], ['AC1032', convertAc1032],
]);

function drawingScene(document, block) {
  const blockViews = [];
  let selected;
  for (const entry of document.blocks.values()) {
    const handle = name(entry.record, 330);
    if (!/^[0-9a-f]{1,16}$/i.test(handle)) continue;
    const count = entry.entities.filter(entity => entity.type === 'MULTILEADER').length;
    if (!count) continue;
    const view = { handle: key(handle), name: name(entry.record, 2), count };
    blockViews.push(view);
    if (block && view.handle === key(block)) selected = { entry, view };
  }
  if (block && !selected) throw new Error('找不到含多重引线的图块。');
  const scene = buildScene(selected ? { ...document, entities: selected.entry.entities } : document, sceneLimits);
  if (blockViews.length) scene.blockViews = blockViews;
  if (selected) scene.blockView = selected.view;
  return scene;
}

function solidWorksPreview(bytes, expected) {
  let drawing;
  try { drawing = readSolidWorksVector(bytes, expected); }
  catch (error) {
    if (!(error instanceof SolidWorksVectorUnavailable)) throw error;
    const sheets = readSolidWorksSheets(bytes, true);
    return { format: 'SolidWorks SLDDRW', sheets: sheets.map(({ name }) => ({ name })),
      pdfAvailable: sheets.every(sheet => sheet.image), items: [], layers: [], issues: [[error.message, 1]] };
  }
  if (!drawing) return null;
  let pdfAvailable = false;
  try { pdfAvailable = readSolidWorksSheets(bytes, true).every(sheet => sheet.image); } catch {}
  const sheets = drawing.sheets.map(sheet => {
    const { items, layers, issues } = drawingScene(parseDxf(writeVectorDxf(sheet)), '');
    const faceLayers = new Set(layers.filter(layer => /^VIEW-\d+-FACES$/.test(layer.name)).map(layer => layer.id));
    for (const item of items) if (item.kind === 'fill' && item.layerIds.some(id => faceLayers.has(id))) item.solidFace = true;
    return { name: sheet.name, vector: true, items, layers, issues };
  });
  const warnings = [['标注使用独立文字与线条，字体外观可能与原 SolidWorks 工程图有差异。', 1]];
  const skipped = drawing.sheets.reduce((count, sheet) => count + sheet.skippedViews, 0);
  if (skipped) warnings.push(['有模型视图缺少可读取的矢量缓存，着色区域和部分符号请以原工程图为准。', skipped]);
  if (!drawing.completePages) warnings.push(['当前显示已读取的矢量记录。部分模型视图或其页面归属尚未验证，整套 DXF 导出暂不可用。', 1]);
  const { items, layers, issues, ...single } = sheets[0];
  return { format: 'SolidWorks SLDDRW', pdfAvailable, dxfAvailable: drawing.completePages, units: 4,
    ...(sheets.length === 1 ? { sheets: [single], items, layers, issues: [...warnings, ...issues] }
      : { sheets, items: [], layers: [], issues: warnings }) };
}

export async function buildProjection(bytes, formatHint, output, part, hidden = '7', front = 'ny', options = {}) {
  const partPath = part ? part.split('.').map(Number) : undefined;
  const { scene, error } = await buildPreview({ bytes, formatHint, partPath });
  if (!scene?.mesh) return { error: error || '请先打开可预览的三维模型。' };
  if (scene.projectionAvailable === false) return { error: '此节点的装配几何未完整读取，暂不能生成三视图。' };
  if (part && !scene.partLabel) return { error: '此模型没有可选的零件或装配节点。' };
  return projectMesh(scene, output, part, hidden, front, options);
}

export function projectMesh(scene, output, part, hidden, front, options = {}) {
  const drawing = buildOrthographic(scene.mesh, front, options);
  return renderProjection(scene,drawing,output,part,hidden,front);
}

export function renderProjection(scene,drawing,output,part,hidden,front,geometry) {
  addProjectionDimensions(drawing,scene);
  addProjectionFrame(drawing,scene,part);
  if (hidden !== '7') {
    const excluded = new Set(projectionHiddenLayers.filter((_, index) => !(Number(hidden) & (1 << index))));
    drawing.entities = drawing.entities.filter(entity => !excluded.has(entity.layer));
  }
  if (output === 'pdf') return { sheetChunks: writeProjectionPdf(drawing), kind: 'P' };
  const dxf = writeVectorDxf(drawing);
  if (output === 'dxf') return { dxf };
  const preview = drawingScene(parseDxf(dxf), '');
  const issues = [
    [part ? '三视图只包含所选节点，投影沿用模型 XYZ 轴和该节点的装配姿态。' : '三视图取自完整装配位置。', 1],
    ['自动尺寸为原生 CAD 标注；孔径按可识别的圆形内轮廓生成，同心圆只标最内圈。曲线与测量受模型采样精度影响，未识别的孔槽、工艺及公差待核。', 1],
    ...(drawing.layout.dimensions.views.some(v=>v.holes>24)?[['孔位较密，已保留孔径与外形尺寸，完整孔距链待核。',1]]:[]),
    ...(geometry?.nativeHiddenLine?[['复杂曲面使用本机 CAD 内核的原始 BREP 计算可见轮廓与隐藏线，显示网格不参与遮挡判断。',1]]:[]),
    ...(drawing.diagnostics.sourcePlanarFaces?[['平面轮廓与孔采用原模型边界。',1]]:[]),
    ...(drawing.diagnostics.analyticRevolutionFaces?[['圆柱面与圆锥面使用原曲面计算遮挡及轮廓；其他曲面仍按网格近似。',1]]:[]),
    ...(!drawing.units ? [['源模型未声明长度单位。DXF 保留原坐标单位。', 1]] : []),
    ...scene.issues, ...preview.issues,
  ];
  return { scene: { ...preview, issues, projection: true, projectionFront: front,
    projectionOptions:drawing.layout.requested,projectionLayout:drawing.layout,
    projectionGeometry:geometry??{method:'hybrid-boundary-mesh',sourcePlanarFaces:drawing.diagnostics.sourcePlanarFaces,
      analyticRevolutionFaces:drawing.diagnostics.analyticRevolutionFaces,meshCurvedFaces:drawing.diagnostics.meshCurvedFaces,
      boundaryChordTargetMm:drawing.diagnostics.boundaryChordTargetMm,
      meshOnly:!drawing.diagnostics.sourcePlanarFaces&&!drawing.diagnostics.analyticRevolutionFaces},
    format: '三视图 · 第一角法 · 1:1',
    ...(part && { projectionPart: { path: part, label: scene.partLabel } }) } };
}

export async function buildPreview({ bytes, download, block = '', streamExport = false, formatHint, partPath }) {
  if (!download && !block) {
    if (formatHint === 'slddrw') return { scene: solidWorksPreview(bytes, true) };
    if (formatHint === 'stl') return { scene: readStlPreview(bytes, true) };
    if (formatHint === '3mf') return { scene: read3mfPreview(openCadPackage(bytes), true, partPath) };
    if (formatHint === 'stp' || formatHint === 'step') return { scene: readStepPreview(bytes, true, partPath) };
    if (formatHint === 'x_t' || formatHint === 'x_b') return { scene: readXtPreview(bytes, formatHint, partPath) };
    if (formatHint === 'obj') return { scene: readObjPreview(bytes, partPath) };
    if (formatHint === 'ply') return { scene: readPlyPreview(bytes, true) };
    if (formatHint === 'off') return { scene: readOffPreview(bytes, true) };
  }
  const version = dwgVersion(bytes);
  if (!version) {
    if (download) return { error: '此接口接收 DWG 或 DWG 格式的 DWT 原文件。' };
    const exb = openExb(bytes);
    if (exb) {
      if (block) return { error: '此格式没有多重引线图块视图。' };
      let reason = '此文件没有可显示的 EXB 模型图元。';
      try {
        const scene = readExbVector(exb);
        if (scene) return { scene };
      } catch (error) {
        reason = error.message.includes('超过') ? error.message : '此文件的 EXB 模型数据暂无法读取。';
      }
      const image = readExbPreview(bytes, exb);
      return { scene: { format: 'CAXA EXB', image, layers: [], items: [],
        issues: [[reason + ' 当前显示文件自带的缩略图。', 1]] } };
    }
    if (!hasDxfHeader(bytes)) {
      const drawing = solidWorksPreview(bytes);
      if (drawing) return block ? { error: '此格式没有多重引线图块视图。' } : { scene: drawing };
      const mesh = readStepPreview(bytes, false, partPath) ?? readXtPreview(bytes, undefined, partPath) ??
        readPlyPreview(bytes) ?? readOffPreview(bytes) ?? readStlPreview(bytes);
      const zip = mesh ? null : openCadPackage(bytes);
      const scene = mesh ?? (zip && (readDwfxPreview(bytes, zip) ?? read3mfPreview(zip, false, partPath)));
      if (scene) return block ? { error: '此格式没有多重引线图块视图。' } : { scene };
    }
    return { scene: drawingScene(parseDxf(bytes), block) };
  }
  let reason = '';
  const native = nativeConverters.get(version);
  if (native) {
    try {
      const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const result = native(source, { preview: !download, keepChunks: download && streamExport });
      if (download) return streamExport ? { dxfChunks: result.dxfChunks } : { dxf: result.dxf };
      const { dxf, warnings, modelOnly, emptyModel } = result;
      if (!(dxf instanceof Uint8Array) || !dxf.length || dxf.length > dxfExportBytes) {
        throw new Error('转换结果超出本版 DXF 容量。');
      }
      const document = parseDxf(dxf);
      if (!document.entities.length && !emptyModel) throw new Error('转换结果没有模型空间图元。');
      if (download) return { dxf };
      const scene = drawingScene(document, block);
      if (!scene.items.length && !emptyModel) throw new Error('转换结果没有可预览的二维图元。');
      const modeNotice = modelOnly ? [['此大图按模型空间和引用块生成矢量预览。下载 DXF 时会转换完整块定义。', 1]] : [];
      return { scene: { ...scene, issues: [...modeNotice, ...warnings, ...scene.issues], dwgVersion: version,
        ...(modelOnly ? { previewMode: 'model' } : {}) } };
    } catch (error) {
      reason = error.message;
    }
  }
  if (download) return { error: reason || `内置转换当前支持 DWG ${[...nativeConverters.keys()].join('、')}。` };
  if (block) return { error: reason || '此 DWG 没有可预览的多重引线图块。' };

  const image = readDwgPreview(bytes);
  if (!image) {
    return { error: reason + '文件中没有可读取的内嵌预览。请提供 DXF 文件。' };
  }
  const detail = reason ? reason + '已显示 DWG 内嵌图。' : '此图是 DWG 上次保存时写入的内嵌预览。';
  return { scene: { dwgVersion: version, image, layers: [], items: [],
    issues: [[detail + ' 可缩放和平移。图层、标注细节和实际尺寸请查看矢量图纸。', 1]] } };
}

if (!isMainThread) {
  try {
    parentPort.postMessage(await buildPreview(workerData));
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}
