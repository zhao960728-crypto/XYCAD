import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { parseDxf } from './dxf-parser.mjs';
import { buildScene } from './dxf-scene.mjs';
import { readSolidWorksVector } from './slddrw-vector.mjs';
import { hasSolidWorksRecords } from './slddrw-preview.mjs';
import { dxfExportBytes, sceneLimits } from './cad-budget.mjs';

const run = promisify(execFile);
const signature = Buffer.from('d0cf11e0a1b11ae1', 'hex');

function sheetZip(sheets) {
  const chunks = [], entries = [];
  let offset = 0, directoryLength = 0;
  for (const { filename, bytes } of sheets) {
    const name = Buffer.from(filename);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4);
    entry.writeUInt32LE(offset, 42);
    entries.push(entry, name);
    directoryLength += entry.length + name.length;
    chunks.push(header, name, bytes);
    offset += header.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(sheets.length, 8);
  end.writeUInt16LE(sheets.length, 10);
  end.writeUInt32LE(directoryLength, 12);
  end.writeUInt32LE(offset, 16);
  return [...chunks, ...entries, end];
}

async function runSolidWorks(copy, directory, operation, firstPage, env) {
  const script = fileURLToPath(new URL('../scripts/solidworks-export.ps1', import.meta.url));
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', script, copy, directory, operation, firstPage],
      { windowsHide: true, env, timeout: 70_000 });
  } catch (error) {
    if (error.stderr?.includes('SolidWorks is already open')) throw new Error('SOLIDWORKS 当前已打开，请关闭桌面会话后重试。');
    if (operation === 'step') throw new Error('SOLIDWORKS 未能读取或导出 SLDPRT 的活动配置，请检查版本、外部引用及模型保存状态。');
    if (error.stderr?.includes('Saved detailing mode unavailable')) {
      throw new Error('官方接口未能以详图或分离模式读取此 SLDDRW 的保存视图。');
    }
    throw new Error('SOLIDWORKS 本机接口启动或导出失败，请核对安装、授权与保存视图。');
  }
}

export async function solidWorksNative(file, operation, env) {
  const part = operation === 'step';
  const original = await open(file, 'r');
  try {
    const header = Buffer.alloc(512);
    await original.read(header);
    if (!header.subarray(0, signature.length).equals(signature) && !hasSolidWorksRecords(header)) {
      throw new Error(part ? '请上传有效的 SLDPRT 零件。' : '请上传有效的 SLDDRW 工程图。');
    }
  } finally { await original.close(); }
  const directory = await mkdtemp(join(tmpdir(), 'xycad-sw-native-'));
  try {
    const copy = join(directory, part ? 'source.sldprt' : 'source.slddrw');
    await copyFile(file, copy);
    if (part) {
      await runSolidWorks(copy, directory, operation, '1', env);
      const model = join(directory, 'model.step');
      if ((await stat(model)).size > dxfExportBytes) throw new Error('STEP 超过转换输出容量。');
      const bytes = await readFile(model);
      if (!bytes.subarray(0, 32).toString('ascii').startsWith('ISO-10303-21;')) {
        throw new Error('SOLIDWORKS 返回了无效的 STEP。');
      }
      return { chunks: [bytes], kind: 'S' };
    }
    const pages = [];
    let totalPages;
    const deadline = performance.now() + 270_000;
    do {
      if (performance.now() >= deadline) throw new Error('SOLIDWORKS 图纸集转换超时。');
      const firstPage = String(pages.length + 1);
      await runSolidWorks(copy, directory, operation, firstPage, env);
      const batch = JSON.parse(await readFile(join(directory, 'sheets.json'), 'utf8'));
      if (!Number.isInteger(batch.total) || batch.total < 1 || batch.total > 64 ||
          totalPages && totalPages !== batch.total || !Array.isArray(batch.pages) || !batch.pages.length ||
          pages.length + batch.pages.length > batch.total ||
          batch.pages.some(page => typeof page?.name !== 'string' || !Number.isInteger(page.modelViews) || page.modelViews < 0)) {
        throw new Error('SOLIDWORKS 返回了无效的工程图页列表。');
      }
      totalPages = batch.total;
      pages.push(...batch.pages);
    } while (pages.length < totalPages);
    if (pages.some(page => !page.modelViews)) {
      let original;
      try { original = readSolidWorksVector(await readFile(copy), true); } catch {}
      if (!original?.completePages || original.sheets.length !== pages.length || pages.some((page, i) =>
        page.name !== original.sheets[i].name || !page.modelViews && original.sheets[i].restoredViews)) {
        throw new Error('有图纸页缺少模型视图，无法从源文件确认该页是纯图框或说明页。');
      }
    }
    if (operation === 'pdf') {
      const file = join(directory, 'drawing.pdf');
      if ((await stat(file)).size > dxfExportBytes) throw new Error('PDF 超过转换输出容量。');
      const pdf = await readFile(file);
      if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('SOLIDWORKS 返回了无效的 PDF。');
      return { chunks: [pdf], kind: 'P' };
    }
    const sheets = [];
    let total = 0;
    for (const [index, { name }] of pages.entries()) {
      const filename = 'sheet-' + String(index + 1).padStart(4, '0') + '.dxf';
      const path = join(directory, filename);
      total += (await stat(path)).size;
      if (total > dxfExportBytes) throw new Error('DXF 图纸集超过转换输出容量。');
      const bytes = await readFile(path);
      const document = parseDxf(bytes);
      if (!document.entities.some(entity => ['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'INSERT', 'SPLINE', 'ELLIPSE'].includes(entity.type)) ||
          document.entities.some(entity => entity.type === 'IMAGE')) throw new Error('SOLIDWORKS 图纸页缺少可编辑的矢量几何。');
      if (operation === 'dxf') sheets.push({ filename, bytes });
      else sheets.push({ ...buildScene(document, sceneLimits), name, vector: true });
    }
    if (operation === 'dxf') return sheets.length === 1 ? { chunks: [sheets[0].bytes], kind: 'D' } :
      { chunks: sheetZip(sheets), kind: 'Z' };
    return { scene: { format: 'SOLIDWORKS 本机矢量', sheets, items: [], layers: [], dxfAvailable: true, pdfAvailable: true,
      issues: [['本机 SOLIDWORKS 接口读取保存的工程图。请对照原图核查视图与标注。', 1]] } };
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
}
