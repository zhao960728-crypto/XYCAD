import { spawn } from 'node:child_process';
import { copyFile, readFile, writeFile, rm, readdir, mkdtemp, rename, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssemblyScene } from './assembly-scene.mjs';
import { projectionLayout } from './projection-layout.mjs';
import { renderProjection } from './dxf-worker.mjs';

export const kernelEnabled = () => Boolean(process.env.XYCAD_CAD_PYTHON);
export const needsKernel = bytes => /\b(?:SPHERICAL_SURFACE|TOROIDAL_SURFACE|B_SPLINE_SURFACE(?:_WITH_KNOTS)?|SURFACE_OF_(?:REVOLUTION|LINEAR_EXTRUSION)|OFFSET_SURFACE)\s*\(/.test(bytes.toString('latin1'));

async function runKernel(directory, request) {
  const executable = process.env.XYCAD_CAD_PYTHON;
  if (!executable || !isAbsolute(executable)) throw Error('此服务尚未配置本机离线 CAD 内核。');
  const id = randomUUID(), input = join(directory, id + '.request.json'), errorFile = join(directory, id + '.error.json');
  const output = join(directory, id + '.result.json');
  await writeFile(input, JSON.stringify({ ...request, directory, output, error: errorFile }), { flag:'wx', mode:0o600 });
  const env = {};
  for (const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME','LANG','LD_LIBRARY_PATH','QT_PLUGIN_PATH'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { PYTHONUTF8:'1', PYTHONDONTWRITEBYTECODE:'1', QT_QPA_PLATFORM:'offscreen', OMP_NUM_THREADS:'2', OPENBLAS_NUM_THREADS:'1' });
  try {
    await new Promise((resolve,reject) => {
      const child = spawn(executable, ['-B', fileURLToPath(new URL('../scripts/cad-kernel.py', import.meta.url)), input],
        { windowsHide:true, stdio:'ignore', env });
      const stop = () => child.kill();
      const timer = setTimeout(() => { child.kill(); reject(Error('本机 CAD 辅助解析超时，原文件未改动。')); }, 60_000);
      const terminate = () => { child.kill(); process.exit(143); };
      process.once('exit',stop);process.once('SIGTERM',terminate);
      child.once('error',reject);
      child.once('close',code => { clearTimeout(timer);process.off('exit',stop);process.off('SIGTERM',terminate);
        code === 0 ? resolve() : reject(Error('本机 CAD 内核未能完整读取此几何。')); });
    });
    return request.operation === 'load' ? null : JSON.parse(await readFile(output,'utf8'));
  } catch (error) {
    const detail = await readFile(errorFile,'utf8').then(JSON.parse).catch(()=>null);
    throw Error(detail?.error || error.message);
  } finally {
    await Promise.all([input,errorFile,output].map(path=>rm(path,{force:true})));
  }
}

export async function kernelPreview(file, directory, asset, format='STEP', reason='复杂曲面') {
  const working=await mkdtemp(join(directory,'kernel-build-'));
  try{
    const result=await buildKernelPreview(file,working,asset,format,reason,directory);
    for(const name of await readdir(working))await copyFile(join(working,name),join(directory,name));
    return result;
  }finally{await rm(working,{recursive:true,force:true});}
}

export async function kernelVolume(file, directory) {
  const source = join(directory, 'volume-source.step');
  await copyFile(file, source);
  try {
    const { volume } = await runKernel(directory, { operation: 'volume', source });
    if (Number.isFinite(volume) && volume > 0) return { method: 'brep', value: volume };
  } finally {
    await rm(source, { force: true });
  }
}

async function buildKernelPreview(file, directory, asset, format, reason, progressDirectory) {
  const copy = join(directory,'kernel-source.step');
  await copyFile(file,copy);
  try { await runKernel(directory,{operation:'load',source:copy,progressDirectory}); }
  finally { await rm(copy,{force:true}); }
  const metadata = JSON.parse(await readFile(join(directory,'kernel.json'),'utf8'));
  if (metadata.schema !== 1 || !metadata.parts?.length || metadata.parts.length > 4096) throw Error('辅助解析没有返回可显示的实体。');
  const markers = [{label:'辅助载入 · 保存实体'}], definitions = new Map();
  for (const [i,part] of metadata.parts.entries()) {
    if (!/^kernel-\d+\.raw$/.test(part.file) || !Number.isInteger(part.count) || part.count <= 0 || part.count > 1_000_000) throw Error('辅助网格信息无效。');
    const path=join(directory,part.file), bytes=readFileSync(path);
    if (bytes.length !== part.count*72) throw Error('辅助网格长度不符。');
    const digest=createHash('sha256').update(bytes).digest('hex');
    const geometry = function*(){for(let o=0;o<bytes.length;o+=72)yield Array.from({length:9},(_,j)=>bytes.readDoubleLE(o+j*8));};
    if (!definitions.has(digest)) definitions.set(digest,geometry);
    const matrix=part.placement,center=part.center;
    if(!Array.isArray(matrix)||matrix.length!==16||!matrix.every(Number.isFinite)||!Array.isArray(center)||center.length!==3||!center.every(Number.isFinite))throw Error('辅助实例变换无效。');
    const placement=p=>[0,1,2].map(i=>matrix[4*i+3]+center.reduce((s,v,j)=>s+matrix[4*i+j]*(v+p[j]),0));
    markers.push({label:'实体 '+(i+1),definition:digest,placement,geometry:definitions.get(digest)},null);
  }
  markers.push(null);
  const scene=buildAssemblyScene(markers,directory,format+' · 本机内核辅助',asset,false);
  scene.mesh.volume = Number.isFinite(metadata.solidVolume) && metadata.solidVolume > 0
    ? { method: 'brep', value: metadata.solidVolume } : { reason: metadata.valid ? 'open' : 'incomplete' };
  // Keep displayed sizes and instance placement in the original BREP frame,
  // independently of the overview mesh's chordal approximation.
  const oldOrigin=scene.mesh.origin,oldSpan=Math.max(...scene.mesh.size),size=metadata.bounds.slice(3).map((v,i)=>v-metadata.bounds[i]);
  const origin=size.map((v,i)=>metadata.bounds[i]+v/2),span=Math.max(...size),ratio=oldSpan/span;
  function rebase(nodes){for(const node of nodes){
    if(node.center)node.center=node.center.map((v,i)=>(oldOrigin[i]+v*oldSpan-origin[i])/span);
    if(node.half)node.half=node.half.map(v=>v*ratio);
    if(node.span)node.span*=ratio;
    if(node.translation)node.translation=node.translation.map((v,i)=>(oldOrigin[i]+v*oldSpan-origin[i])/span);
    if(node.basis)node.basis=node.basis.map(v=>v*ratio);
    if(node.children)rebase(node.children);
  }}rebase(scene.mesh.tree);Object.assign(scene.mesh,{size,origin});
  scene.geometrySource={method:metadata.method,kernel:metadata.kernel,occ:metadata.occ,valid:metadata.valid,faces:metadata.faces,solids:metadata.solids,reason};
  scene.mesh.kernelProjection=true;
  if (!metadata.valid) scene.projectionAvailable=false;
  for(const [i,node] of scene.mesh.tree[0].children.entries())if(!metadata.parts[i].valid)node.projectionAvailable=false;
  scene.issues.push(['使用本机离线 CAD 内核辅助载入；按保存实体组织，原软件的特征树和装配名称未重建。',1]);
  if(!metadata.valid)scene.issues.push(['曲面拓扑检查存在错误，已提供显示网格，精确出图暂不可用。',1]);
  await writeFile(join(directory,'scene.json'),JSON.stringify(scene));
  // Raw exchange buffers are private scratch; retain only shared render meshes and BREP.
  await Promise.all(metadata.parts.map(part=>rm(join(directory,part.file),{force:true})));
  return {scene};
}

export async function kernelProjection(directory, output, part, hidden, front, options) {
  const [scene,metadata]=await Promise.all(['scene.json','kernel.json'].map(n=>readFile(join(directory,n),'utf8').then(JSON.parse)));
  if(scene.previewOnly)throw Error('此模型仅供辅助近似查看，暂不能生成三视图。');
  let selected=null;
  if(part){const path=part.split('.').map(Number);if(path.length===1&&path[0]===0)selected=null;
    else if(path.length===2&&path[0]===0&&metadata.parts[path[1]])selected=path[1];
    else throw Error('找不到辅助载入的指定实体。');}
  const data=selected===null?metadata:metadata.parts[selected];
  if(!data.valid)throw Error('此几何存在拓扑错误，可查看模型，暂不能生成精确三视图。');
  const size=data.bounds.slice(3).map((v,i)=>v-data.bounds[i]);
  const layout=projectionLayout(size,front,options);
  const key=createHash('sha256').update(JSON.stringify(['kernel-hlr-v1',selected,layout,metadata.kernel,metadata.occ])).digest('hex');
  const cache=join(directory,'hlr-'+key+'.json');
  let drawing=await readFile(cache,'utf8').then(JSON.parse).catch(()=>null);
  if(!drawing){
    drawing=await runKernel(directory,{operation:'project',layout,part:selected,seams:layout.requested.seams==='1'});
    const previous=await Promise.all((await readdir(directory)).filter(n=>/^hlr-[a-f0-9]{64}\.json$/.test(n)).map(async name=>({name,time:await stat(join(directory,name)).then(s=>s.mtimeMs).catch(()=>0)})));
    previous.sort((a,b)=>a.time-b.time);
    for(const entry of previous.slice(0,Math.max(0,previous.length-1)))await rm(join(directory,entry.name),{force:true});
    const temporary=cache+'.'+randomUUID()+'.new';await writeFile(temporary,JSON.stringify(drawing));
    try{await rename(temporary,cache);}finally{await rm(temporary,{force:true});}
  }
  for(const view of layout.views)drawing.entities.push({type:'TEXT',layer:'VIEW-LABELS',value:view.label,height:layout.labelHeight,angle:0,width:1,a:view.labelPosition});
  Object.assign(drawing,{layout,units:4,hiddenDash:Math.max(...size)*.008,
    diagnostics:{sourcePlanarFaces:0,analyticRevolutionFaces:0,meshCurvedFaces:0,boundaryChordTargetMm:drawing.chordMm}});
  const geometry={method:'local-kernel-brep',kernel:metadata.kernel,occ:metadata.occ,nativeHiddenLine:true,meshOnly:false,boundaryChordTargetMm:drawing.chordMm};
  const selectedScene={...scene,mesh:{...scene.mesh,size,unit:'mm'},...(selected!==null&&{partLabel:'实体 '+(selected+1)})};
  return renderProjection(selectedScene,drawing,output,part,hidden,front,geometry);
}
