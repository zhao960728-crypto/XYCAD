import { Console } from 'node:console';
import { constants as bufferLimits } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildPreview, buildProjection, projectMesh } from './dxf-worker.mjs';
import { exportSolidWorksDrawing } from './slddrw-export.mjs';
import { buildAssemblyScene, readAssemblyProjection } from './assembly-scene.mjs';
import { readStepAssembly } from './step-preview.mjs';
import { readXtAssembly } from './xt-preview.mjs';
import { validateSavedPart } from './sldprt-validation.mjs';

// The first response byte is the HTTP result kind. The remaining bytes are
// ready to stream, so the service does not retain a second copy of the scene.
globalThis.console = new Console(process.stderr);

async function run() {
  const [file, operation, block, formatHint, part, hidden, front, directory, asset] = process.argv.slice(2);
  if (operation.startsWith('asset-projection')) {
    const scene = readAssemblyProjection(directory, part ? part.split('.').map(Number) : undefined);
    return projectMesh(scene, operation.slice(17), part, hidden, front);
  }
  const { size } = await stat(file);
  if (size > Math.min(bufferLimits.MAX_LENGTH, process.availableMemory())) return { error: '当前可用内存不足以读取此图纸。' };
  const bytes = await readFile(file);
  if (operation === 'assembly') {
    const sldprt = formatHint === 'sldprt';
    const step = sldprt || formatHint === 'step' || formatHint === 'stp';
    const { markers, scene } = step ? { markers: readStepAssembly(bytes) } : readXtAssembly(bytes, formatHint);
    const result = scene ?? buildAssemblyScene(markers, directory,
      sldprt ? 'SLDPRT · 离线解析' : step ? 'STEP' : 'Parasolid X_T', asset);
    if (sldprt) {
      const metadata = JSON.parse(await readFile(file + '.json', 'utf8'));
      validateSavedPart(result.mesh, metadata);
      result.configurations = metadata.configurations;
      result.selectedConfiguration = metadata.selectedConfiguration;
      result.issues = [
        ['预览来自所选配置保存的实体几何。模型特征历史及增量记录未重放。', 1],
        ...(result.issues ?? []),
      ];
    }
    return { scene: result };
  }
  if (operation === 'sheet-pdf' || operation === 'sheet-dxf') {
    const format = operation.slice(6);
    return { sheetChunks: exportSolidWorksDrawing(bytes, format), kind: format === 'pdf' ? 'P' : 'D' };
  }
  if (operation.startsWith('projection')) {
    return buildProjection(bytes, formatHint, operation.slice(11), part, hidden, front);
  }
  return buildPreview({ bytes, block, formatHint, download: operation === 'convert', streamExport: true });
}

let result;
try {
  result = await run();
} catch (error) {
  result = { error: error.message };
  if (process.argv[5] === 'sldprt') {
    try {
      const metadata = JSON.parse(await readFile(process.argv[2] + '.json', 'utf8'));
      result.configurations = metadata.configurations;
      result.selectedConfiguration = metadata.selectedConfiguration;
    } catch {}
  }
}
if (result.sheetChunks) {
  process.stdout.write(result.kind);
  await pipeline(Readable.from(result.sheetChunks), process.stdout);
} else if (result.dxfChunks) {
  process.stdout.write('D');
  await pipeline(Readable.from(result.dxfChunks), process.stdout);
} else if (result.dxf) {
  process.stdout.write('D');
  process.stdout.end(result.dxf);
} else {
  const body = JSON.stringify(result);
  process.stdout.write(result.error ? 'E' : 'J');
  process.stdout.end(body);
}
