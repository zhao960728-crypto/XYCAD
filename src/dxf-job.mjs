import { Console } from 'node:console';
import { constants as bufferLimits } from 'node:buffer';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildPreview, buildProjection, projectMesh } from './dxf-worker.mjs';
import { exportSolidWorksDrawing } from './slddrw-export.mjs';
import { buildAssemblyScene, readAssemblyProjection } from './assembly-scene.mjs';
import { readStepAssembly } from './step-preview.mjs';
import { readXtAssembly } from './xt-preview.mjs';
import { validateSavedPart } from './sldprt-validation.mjs';
import { kernelEnabled, needsKernel, kernelPreview, kernelProjection, kernelVolume } from './cad-kernel.mjs';
import { savedPartScene } from './sldprt-preview.mjs';

// The first response byte is the HTTP result kind. The remaining bytes are
// ready to stream, so the service does not retain a second copy of the scene.
globalThis.console = new Console(process.stderr);

async function run() {
  const [file, operation, block, formatHint, part, hidden, front, directory, asset, projectionJSON] = process.argv.slice(2);
  const projectionOptions=projectionJSON?JSON.parse(projectionJSON):{};
  if (operation.startsWith('asset-projection')) {
    if(existsSync(join(directory,'kernel.json')))return kernelProjection(directory,operation.slice(17),part,hidden,front,projectionOptions);
    const scene = readAssemblyProjection(directory, part ? part.split('.').map(Number) : undefined);
    return projectMesh(scene, operation.slice(17), part, hidden, front, projectionOptions);
  }
  const { size } = await stat(file);
  if (size > Math.min(bufferLimits.MAX_LENGTH, process.availableMemory())) return { error: '当前可用内存不足以读取此图纸。' };
  const bytes = await readFile(file);
  if (operation === 'assembly') {
    const sldprt = formatHint === 'sldprt';
    const step = sldprt || formatHint === 'step' || formatHint === 'stp';
    let result;
    const format=sldprt?'SLDPRT · 离线解析':step?'STEP':'Parasolid X_T';
    if(kernelEnabled()&&step)await import('node:fs/promises').then(({writeFile})=>writeFile(join(directory,'kernel-progress.json'),JSON.stringify({stage:'read-geometry'})));
    // Keep the self-developed reader as the default. Complex STEP surfaces and
    // incomplete/failed transfers can use an explicitly configured offline kernel.
    if(step&&kernelEnabled()&&needsKernel(bytes)){
      await import('node:fs/promises').then(({writeFile})=>writeFile(join(directory,'kernel-progress.json'),JSON.stringify({stage:'kernel-read'})));
      try{result=(await kernelPreview(file,directory,asset,format,'复杂曲面')).scene;}catch{}
    }
    if(!result){
      try{
        const {markers,scene}=step?{markers:readStepAssembly(bytes)}:readXtAssembly(bytes,formatHint);
        result=scene??buildAssemblyScene(markers,directory,format,asset);
      }catch(error){
        if(!step||!kernelEnabled())throw error;
        result=(await kernelPreview(file,directory,asset,format,error.message)).scene;
      }
      if(step&&result.projectionAvailable===false&&kernelEnabled()){
        try{
          const fallback=await kernelPreview(file,directory,asset,format,'原读取器未完整读取');
          result=fallback.scene;
        }catch(error){result.issues.push(['本机内核辅助读取未完成；当前保留原读取器的可用几何。'+error.message,1]);}
      }
    }
    if (sldprt) {
      const metadata = JSON.parse(await readFile(file + '.json', 'utf8'));
      let discrepancy;
      try{validateSavedPart(result.mesh, metadata);}catch(error){if(!metadata.previewOnly)throw error;discrepancy=error.message;}
      result.configurations = metadata.configurations;
      result.selectedConfiguration = metadata.selectedConfiguration;
      result.issues = [
        ['预览来自所选配置保存的实体几何。模型特征历史及增量记录未重放。', 1],
        ...(result.issues ?? []),
      ];
      if(metadata.previewOnly){
        result.previewOnly=true;result.measurementAvailable=false;result.projectionAvailable=false;
        result.mesh.volume = { reason: 'incomplete' };
        result.format+=' · 辅助近似预览';
        result.geometrySource={...result.geometrySource,method:'saved-geometry-approximation',complete:false,approximationWarnings:metadata.approximationWarnings};
        const disable=nodes=>{for(const node of nodes){node.projectionAvailable=false;if(node.children)disable(node.children);}};disable(result.mesh.tree);
        result.issues.unshift(['部分保存曲线或圆角采用辅助近似，只供旋转查看；测量、三视图与几何导出不可用。',1],...(discrepancy?[[discrepancy,1]]:[]));
      }
    }
    if (step && kernelEnabled() && size <= 128 * 1024 * 1024 && result.projectionAvailable !== false &&
        !result.mesh.kernelProjection && !result.mesh.volume?.value) {
      const volume = await kernelVolume(file, directory).catch(() => undefined);
      if (volume) result.mesh.volume = volume;
    }
    if (sldprt || result.mesh.volume?.method === 'brep' && !result.mesh.kernelProjection) {
      await import('node:fs/promises').then(({writeFile})=>writeFile(join(directory,'scene.json'),JSON.stringify(result)));
    }
    return { scene: result };
  }
  if (operation === 'sheet-pdf' || operation === 'sheet-dxf') {
    const format = operation.slice(6);
    return { sheetChunks: exportSolidWorksDrawing(bytes, format), kind: format === 'pdf' ? 'P' : 'D' };
  }
  if (operation.startsWith('projection')) {
    if(kernelEnabled()&&['step','stp'].includes(formatHint)&&needsKernel(bytes)){
      const temporary=await mkdtemp(join(tmpdir(),'xycad-kernel-'));
      try{await kernelPreview(file,temporary,'','STEP','复杂曲面');return await kernelProjection(temporary,operation.slice(11),part,hidden,front,projectionOptions);}
      finally{await rm(temporary,{recursive:true,force:true});}
    }
    return buildProjection(bytes, formatHint, operation.slice(11), part, hidden, front, projectionOptions);
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
      const image=await readFile(process.argv[2]+'.thumbnail.json','utf8').then(JSON.parse).catch(()=>null);
      if(image)result={scene:savedPartScene(image,error.message,metadata)};
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
