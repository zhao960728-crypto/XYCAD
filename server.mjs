import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { finished, pipeline } from 'node:stream/promises';
import { MiB, formatHints, meshExtensions, uploadHint } from './public/cad-limits.mjs';
import { projectionSettings } from './src/projection-layout.mjs';
import { PreviewJobs } from './src/preview-jobs.mjs';
import { savedPartImage, savedPartScene, savedPartThumbnail } from './src/sldprt-preview.mjs';

const types = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/style.css', 'text/css; charset=utf-8'],
  ['/viewer.mjs', 'text/javascript; charset=utf-8'],
  ['/drawing-pdf.mjs', 'text/javascript; charset=utf-8'],
  ['/drawing-buffer.mjs', 'text/javascript; charset=utf-8'],
  ['/mesh-viewer.mjs', 'text/javascript; charset=utf-8'],
  ['/assembly-viewer.mjs', 'text/javascript; charset=utf-8'],
  ['/cad-measure.mjs', 'text/javascript; charset=utf-8'],
  ['/measure-tools.mjs', 'text/javascript; charset=utf-8'],
  ['/weight-tools.mjs', 'text/javascript; charset=utf-8'],
  ['/cad-limits.mjs', 'text/javascript; charset=utf-8'],
  ['/sample.dxf', 'application/dxf'],
]);

const host = process.env.XYCAD_HOST || '127.0.0.1';
const port = Number(process.env.XYCAD_PORT ?? 4173);
const sldprtParser = process.env.XYCAD_SLDPRT_PARSER_DIR;
if (sldprtParser && !isAbsolute(sldprtParser)) throw new Error('XYCAD_SLDPRT_PARSER_DIR 必须是离线解析器目录的绝对路径。');
const sldprtPython = process.env.XYCAD_SLDPRT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const sldprtScript = fileURLToPath(new URL('./scripts/sldprt-offline.py', import.meta.url));
const run = promisify(execFile);
const sldprtMaxBytes = 64 * MiB;
const workerEnvironment = { ...process.env };
const slots = Math.min(4, Math.max(1, availableParallelism() - 1));
const largeDrawingThreshold = 4 * MiB;
let active = 0;
let largeDrawingActive = false;
const assemblyAssets = new Map();
const assemblyTtl = 30 * 60 * 1000;
const partPattern = /^(?:0|[1-9][0-9]{0,5})(?:\.(?:0|[1-9][0-9]{0,5})){0,48}$/;
const standaloneScope = 'standalone';
const previewJobs = new PreviewJobs();
setInterval(()=>previewJobs.expire(),60_000).unref();

function releaseAssembly(id, asset) {
  assemblyAssets.delete(id);
  if (!asset.directory) return;
  const directory = resolve(asset.directory);
  if (dirname(directory) !== resolve(tmpdir()) || !/^xycad-assembly-[A-Za-z0-9]+$/.test(basename(directory))) {
    throw new Error('无效的装配临时目录。');
  }
  return rm(directory, { recursive: true, force: true, maxRetries: 3 })
    .catch(error => console.error('无法清理装配临时目录。', error.code));
}

async function expireAssemblies() {
  const now = Date.now();
  await Promise.all([...assemblyAssets].filter(([, asset]) => asset.users === 0 && asset.expires <= now)
    .map(([id, asset]) => releaseAssembly(id, asset)));
}
setInterval(expireAssemblies, 60_000).unref();

function json(response, status, data) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

const downloads = {
  D: ['application/dxf', 'xycad.dxf'],
  P: ['application/pdf', 'xycad.pdf'],
};

function partDetails(stdout) {
  const data = JSON.parse(stdout);
  const list = data.configurations;
  if (!Array.isArray(list) || !list.length || list.length > 256 ||
      list.some(row => !row || typeof row.id !== 'string' || !/^(?:0|[1-9][0-9]{0,6})$/.test(row.id) ||
        typeof row.name !== 'string' || !row.name.length || row.name.length > 1024 ||
        typeof row.savedGeometry !== 'boolean') ||
      new Set(list.map(row => row.id)).size !== list.length ||
      !list.some(row => row.id === data.selectedConfiguration)) throw new Error('Invalid part configuration metadata');
  const bounds = data.savedBounds;
  if (bounds !== undefined && (!Array.isArray(bounds) || bounds.length !== 6 || !bounds.every(Number.isFinite) ||
      bounds.slice(0, 3).some((value, axis) => value > bounds[axis + 3]))) throw new Error('Invalid saved bounds');
  return { configurations: list, selectedConfiguration: data.selectedConfiguration, solidCount: data.solidCount,
    ...(data.previewOnly===true&&{previewOnly:true,approximationWarnings:Array.isArray(data.approximationWarnings)?data.approximationWarnings.filter(v=>typeof v==='string').slice(0,32).map(v=>v.slice(0,500)):[]}),
    ...(bounds && { savedBounds: bounds }) };
}

async function offlinePart(file, output, response, configuration, allowPreview=false) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once('close', cancel);
  try {
    if (response.destroyed) return false;
    const { stdout } = await run(sldprtPython, ['-I', '-S', '-B', sldprtScript, sldprtParser, file, output, configuration ?? '',allowPreview?'preview':''],
      { signal: controller.signal, timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true, env: workerEnvironment });
    const metadata = partDetails(stdout);
    if (!Number.isInteger(metadata.solidCount) || metadata.solidCount < 1 || metadata.solidCount > 256) {
      throw new Error('Invalid part solid count');
    }
    await writeFile(output + '.json', JSON.stringify(metadata), { flag: 'wx' });
    const thumbnail=savedPartThumbnail(await readFile(file));
    if(thumbnail)await writeFile(output+'.thumbnail.json',JSON.stringify(thumbnail),{flag:'wx'});
    return true;
  } catch (error) {
    if (controller.signal.aborted) return false;
    let thumbnail=savedPartThumbnail(await readFile(file));
    if(!thumbnail)thumbnail=await readFile(output+'.thumbnail').then(savedPartImage).catch(()=>null);
    if(thumbnail&&allowPreview){
      let details;try{details=partDetails(error.stdout);}catch{}
      json(response,200,{scene:savedPartScene(thumbnail,'此配置的实体几何尚未完整读取，已保留文件自带的显示内容。',details)});
      return false;
    }
    if (error.code === 'ENOENT' || error.code === 3) {
      json(response, 503, { error: 'SLDPRT 离线解析环境不可用，请检查本机 Python 和解析器配置。' });
    } else if (error.killed) {
      json(response, 422, { error: 'SLDPRT 离线解析超时。' });
    } else {
      let details;
      try { details = partDetails(error.stdout); } catch {}
      json(response, 422, { error: details
        ? '该配置的保存实体或曲面暂未完整适配。可选择其他配置。'
        : 'SLDPRT 文件损坏或超出离线读取范围，未找到可确认的保存配置。',
      ...details });
    }
    return false;
  } finally {
    response.removeListener('close', cancel);
  }
}

async function* limitPartUpload(chunks) {
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > sldprtMaxBytes) throw Object.assign(new Error('SLDPRT upload too large'), { code: 'SLDPRT_TOO_LARGE' });
    yield chunk;
  }
}

function previewInProcess(file, length, response, operation, largeDrawing, block, formatHint, part, hidden, front, cleanupUpload, asset, projectionOptions = {}) {
  return new Promise(resolve => {
    const parasolid = formatHint === 'x_t' || formatHint === 'x_b';
    const parseSeconds = operation === 'assembly' ? 180
      : largeDrawing ? Math.min(300, 60 + Math.floor(length / (16 * MiB))) : parasolid ? 60 : 30;
    const child = spawn(process.execPath, [`--max-old-space-size=${largeDrawing ? 2048 : 768}`,
      fileURLToPath(new URL('./src/dxf-job.mjs', import.meta.url)), file,
      operation, block, formatHint ?? '', part, hidden, front, asset?.directory ?? '', asset?.id ?? '',JSON.stringify(projectionOptions)],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: workerEnvironment });
    const stop=()=>{
      if(child.exitCode!==null||child.killed)return;
      if(process.platform==='win32'&&child.pid)execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{});
      else child.kill();
    };
    let failure;
    const timeout = setTimeout(() => {
      failure = `解析超过 ${parseSeconds} 秒，请尝试拆分图纸。`;
      stop();
    }, parseSeconds * 1000);
    const cancel = () => { if (!response.writableFinished) stop(); };
    response.once('close', cancel);
    const delivery = (async () => {
      const chunks = child.stdout[Symbol.asyncIterator]();
      try {
        const { value: chunk, done } = await chunks.next();
        if (done || response.destroyed || response.writableEnded) return;
        const kind = String.fromCharCode(chunk[0]);
        if (!downloads[kind] && kind !== 'E' && kind !== 'J') {
          failure = '大图解析返回了无效结果。';
          stop();
          return;
        }
        clearTimeout(timeout);
        await cleanupUpload();
        if (response.destroyed || response.writableEnded) return;
        response.setTimeout(60000, () => response.destroy());
        const download = downloads[kind];
        const headers = download
          ? { 'Content-Type': download[0], 'Content-Disposition': 'attachment; filename="' + download[1] + '"' }
          : { 'Content-Type': 'application/json; charset=utf-8' };
        response.writeHead(kind === 'E' ? 422 : 200, { ...headers, 'Cache-Control': 'no-store' });
        async function* body() {
          yield chunk.subarray(1);
          yield* chunks;
        }
        await pipeline(Readable.from(body()), response, { end: false });
      } catch {
        stop();
      }
    })();
    child.once('error', () => { failure ??= '无法启动大图解析进程。'; });
    child.once('close', async code => {
      clearTimeout(timeout);
      response.removeListener('close', cancel);
      await delivery;
      resolve({ code, failure });
    });
  });
}

async function preview(request, response, operation, block, part, hidden, front, projectionOptions = {}) {
  const requestedFormat = request.headers['x-xycad-format'];
  const projection = operation.startsWith('projection');
  const hints = projection ? meshExtensions : operation === 'preview' && !block ? formatHints : [];
  const formatHint = hints.includes(requestedFormat) ? requestedFormat : undefined;
  const sldprt = formatHint === 'sldprt';
  const configuration = sldprt ? request.headers['x-xycad-configuration'] : undefined;
  if (operation === 'preview' && (sldprt || request.headers['x-xycad-assembly'] === '1' &&
      ['step', 'stp', 'x_t'].includes(formatHint))) operation = 'assembly';
  function rejectUpload(status, error) {
    response.setHeader('Connection', 'close');
    return json(response, status, { error });
  }
  if (configuration !== undefined && (typeof configuration !== 'string' || !/^(?:0|[1-9][0-9]{0,6})$/.test(configuration))) {
    return rejectUpload(400, '无效的零件配置编号。');
  }
  const emptyMessage = sldprt ? '请选择非空 SLDPRT 零件。' : operation === 'preview' ? `请选择非空图纸。支持 ${uploadHint}。`
    : projection ? '请选择非空三维模型。'
      : `请选择非空 ${operation === 'convert' ? 'DWG/DWT' : 'SLDDRW'} 图纸。`;
  if (request.headers['content-type'] !== 'application/octet-stream') {
    return rejectUpload(415, '请发送 CAD 图纸原始字节。');
  }
  if (request.headers['content-length'] === '0') return rejectUpload(400, emptyMessage);
  if (sldprt && !sldprtParser) return rejectUpload(503, '此服务尚未配置 SLDPRT 离线解析器。');
  if (sldprt && Number(request.headers['content-length']) > sldprtMaxBytes) {
    return rejectUpload(413, 'SLDPRT 文件超过离线解析的 64 MiB 上限。');
  }
  if (active >= slots) {
    return rejectUpload(503, '预览服务正在处理其他图纸，请稍后重试。');
  }
  active++;
  let directory, file, convertedFile, asset, ownsLargeSlot = false, background = false;
  async function cleanupUpload() {
    if(convertedFile)await Promise.all(['.thumbnail.json','.thumbnail'].map(suffix=>rm(convertedFile+suffix,{force:true}).catch(()=>{})));
    if (convertedFile) await rm(convertedFile + '.json', { force: true }).catch(error => console.error('无法清理配置临时文件。', error.code));
    if (convertedFile) await rm(convertedFile, { force: true }).catch(error => console.error('无法清理转换临时文件。', error.code));
    if (file) await rm(file, { force: true }).catch(error => console.error('无法清理图纸临时文件。', error.code));
    if (directory) await rmdir(directory).catch(error => console.error('无法清理图纸临时目录。', error.code));
    file = convertedFile = directory = undefined;
  }
  async function finalize(){
    await cleanupUpload();
    if(asset)await releaseAssembly(asset.id,asset);
    if(ownsLargeSlot)largeDrawingActive=false;
    active--;
  }
  try {
    directory = await mkdtemp(join(tmpdir(), 'xycad-upload-'));
    file = join(directory, 'input');
    const chunks = request.iterator({ destroyOnReturn: false });
    await pipeline(sldprt ? limitPartUpload(chunks) : chunks, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    request.setTimeout(0);
    let { size: length } = await stat(file);
    if (response.destroyed) return;
    const largeDrawing = length >= largeDrawingThreshold;
    if (!length || largeDrawing && largeDrawingActive) {
      await cleanupUpload();
      return !length ? rejectUpload(400, emptyMessage) : rejectUpload(503, '服务正在处理另一份大图，请稍后重试。');
    }
    if (largeDrawing) largeDrawingActive = ownsLargeSlot = true;
    async function execute(response,job){
    if(job)job.stage=sldprt?'read-configuration':'read-geometry';
    if(job&&sldprt){const image=savedPartThumbnail(await readFile(file));if(image)job.previewScene=savedPartScene(image,'正在后台读取实体，目前暂时显示文件保存缩略图。');}
    if (sldprt) {
      convertedFile = join(directory, 'model.step');
      if (!await offlinePart(file, convertedFile, response, configuration, operation==='assembly')) return;
      ({ size: length } = await stat(convertedFile));
    }
    if (operation === 'assembly') {
      await expireAssemblies();
      if (assemblyAssets.size >= 8) {
        const idle = [...assemblyAssets].find(([, entry]) => entry.users === 0);
        if (!idle) return json(response, 503, { error: '装配预览缓存正在使用，请稍后重试。' });
        void releaseAssembly(...idle);
      }
      asset = { id: randomUUID(), users: 1 };
      assemblyAssets.set(asset.id, asset);
      asset.directory = await mkdtemp(join(tmpdir(), 'xycad-assembly-'));
      if(job)job.progressDirectory=asset.directory;
    }
    const { code, failure } = await previewInProcess(convertedFile ?? file, length, response, operation,
      largeDrawing || length >= largeDrawingThreshold, block, sldprt && projection ? 'step' : formatHint, part, hidden, front,
      cleanupUpload, asset, projectionOptions);
    if (asset && code === 0 && !response.destroyed && response.statusCode === 200 &&
        await stat(join(asset.directory, 'scene.json')).catch(() => null)) {
      asset.expires = Date.now() + assemblyTtl;
      asset.users--;
      asset = undefined;
    }
    await cleanupUpload();
    if (!response.headersSent) json(response, 422, { error: failure || '大图解析未完成，请检查图纸或重试。' });
    else if (!response.writableEnded && !response.destroyed) {
      if (code === 0) response.end();
      else response.destroy();
    }
    await finished(response, { cleanup: true });
    }
    if(operation==='assembly'&&request.headers.prefer==='respond-async'){
      const job=previewJobs.create(standaloneScope,async(target,state)=>{
        try{await execute(target,state);}catch(error){if(!target.destroyed&&!target.headersSent)json(target,500,{error:'后台图纸载入未完成，请重试。'});}
      },finalize);
      background=true;
      return json(response,202,{job:{id:job.id,status:'loading',pollAfterMs:600}});
    }
    await execute(response);
  } catch (error) {
    await cleanupUpload();
    if (!response.headersSent) response.setHeader('Connection', 'close');
    if (error.code === 'SLDPRT_TOO_LARGE') json(response, 413, { error: 'SLDPRT 文件超过离线解析的 64 MiB 上限。' });
    else if (error.code === 'ENOSPC') json(response, 507, { error: '服务器临时磁盘空间不足。' });
    else json(response, request.complete ? 500 : 400, { error: request.complete ? '图纸临时文件读取失败。' : '图纸未完整接收。' });
  } finally {
    if(!background)await finalize();
  }
}

async function assemblyResource(request, response, id, resource, query) {
  if (request.method !== 'GET') return response.writeHead(405, { Allow: 'GET' }).end();
  const asset = assemblyAssets.get(id);
  if (!asset?.expires || asset.expires <= Date.now()) return json(response, 404, { error: '装配预览已过期，请重新打开原文件。' });
  const params = new URLSearchParams(query);
  asset.users++;
  asset.expires = Date.now() + assemblyTtl;
  try {
    if (resource === 'mesh') {
      const keys = params.get('parts')?.split(',') ?? [];
      if (!keys.length || keys.length > 16 || keys.some(key => !/^(?:0|[1-9][0-9]{0,5})(?:c)?$/.test(key))) {
        return json(response, 400, { error: '无效的装配网格编号。' });
      }
      const paths = keys.map(key => join(asset.directory, key.endsWith('c') ? key.slice(0, -1) + '.coarse' : key + '.mesh'));
      const files = await Promise.all(paths.map(path => stat(path).catch(() => null)));
      if (files.some(file => !file?.isFile())) return json(response, 404, { error: '找不到所请求的零件网格。' });
      const length = files.reduce((sum, file) => sum + file.size, 0);
      if (length > 40 * MiB) return json(response, 413, { error: '单批装配网格过大。' });
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': length, 'Cache-Control': 'private, no-store' });
      async function* chunks() {
        for (const path of paths) yield* createReadStream(path);
      }
      await pipeline(Readable.from(chunks()), response);
      return;
    }
    const part = params.get('part') ?? '';
    let settings;
    try {settings=projectionSettings(params);}catch(error){return json(response,400,{error:error.message});}
    const {front,...projectionOptions}=settings;
    const hidden = params.get('hidden') ?? '7', format = params.get('format') ?? '';
    if ((part && !partPattern.test(part)) || !/^[0-7]$/.test(hidden) ||
        !['', 'pdf', 'dxf'].includes(format)) return json(response, 400, { error: '无效的装配三视图参数。' });
    if (active >= slots) return json(response, 503, { error: '预览服务正在处理其他图纸，请稍后重试。' });
    active++;
    try {
      const { code, failure } = await previewInProcess('', 0, response, 'asset-projection-' + format, false, '', '', part, hidden, front,
        async () => {}, asset, projectionOptions);
      if (!response.headersSent) json(response, 422, { error: failure || '装配三视图未完成。' });
      else if (!response.writableEnded && !response.destroyed) {
        if (code === 0) response.end();
        else response.destroy();
      }
    } finally { active--; }
  } catch {
    if (!response.headersSent) json(response, 500, { error: '读取装配预览失败。' });
    else if (!response.writableEnded) response.destroy();
  } finally { asset.users--; }
}

const server = createServer({ requestTimeout: 0, headersTimeout: 10000, connectionsCheckingInterval: 1000 }, async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data: blob:; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  const [route, query] = request.url.split('?', 2);
  const previewJob=/^\/api\/preview-jobs\/([0-9a-f-]{36})$/.exec(route);
  if(previewJob){
    if(!['GET','DELETE'].includes(request.method))return json(response,405,{error:'只支持读取或取消载入。'});
    const job=previewJobs.get(previewJob[1],standaloneScope);
    if(!job)return json(response,404,{error:'找不到此载入记录，或已过期。'});
    if(request.method==='DELETE'){previewJobs.cancel(job.id,standaloneScope);return json(response,200,{status:'cancelled'});}
    if(job.status==='ready')return json(response,200,{status:'ready',...job.result});
    if(job.status!=='loading')return json(response,200,{status:job.status,...job.result});
    let progress;
    if(job.progressDirectory)progress=await readFile(join(job.progressDirectory,'kernel-progress.json'),'utf8').then(JSON.parse).catch(()=>null);
    return json(response,200,{status:'loading',stage:progress?.stage??job.stage,completed:progress?.completed,total:progress?.total,elapsedMs:Date.now()-job.started,
      ...(new URLSearchParams(query).get('preview')==='1'&&job.previewScene&&{previewScene:job.previewScene})});
  }
  const assembly = /^\/api\/assembly\/([0-9a-f-]{36})\/(mesh|projection)$/.exec(route);
  if (assembly) return assemblyResource(request, response, assembly[1], assembly[2], query);
  const partProjection = route === '/api/projection/part';
  if (route === '/api/preview' || route === '/api/convert' || route === '/api/export' || route === '/api/projection' || partProjection) {
    if (request.method === 'POST') {
      const params = new URLSearchParams(query);
      let operation = route === '/api/convert' ? 'convert' : 'preview';
      let hidden = '7';
      let front = 'ny';
      let projectionOptions = {};
      if (route === '/api/export') {
        const format = params.get('format');
        if (format !== 'pdf' && format !== 'dxf') return json(response, 400, { error: '请选择 PDF 或 DXF 工程图导出格式。' });
        operation = 'sheet-' + format;
      }
      if (route === '/api/projection' || partProjection) {
        const format = params.get('format');
        if (format !== null && format !== 'dxf' && format !== 'pdf') return json(response, 400, { error: '请选择 PDF 或 DXF 三视图导出格式。' });
        hidden = params.get('hidden') ?? '7';
        if (!/^[0-7]$/.test(hidden)) return json(response, 400, { error: '无效的遮挡线设置。' });
        try {const settings=projectionSettings(params);({front,...projectionOptions}=settings);}
        catch(error){return json(response,400,{error:error.message});}
        operation = format ? 'projection-' + format : 'projection';
      }
      const block = route === '/api/preview' ? params.get('block') ?? '' : '';
      if (block && !/^[0-9a-f]{1,16}$/i.test(block)) return json(response, 400, { error: '无效的图块句柄。' });
      const part = partProjection ? params.get('part') ?? '' : '';
      if (partProjection && !partPattern.test(part)) {
        return json(response, 400, { error: '无效的装配节点路径。' });
      }
      request.setTimeout(120000, () => request.destroy());
      return preview(request, response, operation, block, part, hidden, front, projectionOptions);
    }
    response.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const asset = route === '/' ? '/index.html' : route;
  if (!types.has(asset)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(new URL(`./public${asset}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': types.get(asset), 'Content-Length': data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
});

server.listen(port, host, () => {
  const address = host.includes(':') ? `[${host}]` : host;
  console.log(`XYCAD  http://${address}:${server.address().port}/`);
});
