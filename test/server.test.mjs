import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateRawSync, deflateSync, inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MiB } from '../public/cad-limits.mjs';
import { parseDxf, name, number } from '../src/dxf-parser.mjs';
import { explainPreview } from '../src/preview-diagnostics.mjs';

async function startServer(t, converter = '', environment = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, ...environment, XYCAD_HOST: '127.0.0.1', XYCAD_PORT: '0', XYCAD_DWG_CONVERTER: converter },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Preview server exited with code ' + code)));
    child.stdout.once('data', chunk => resolve(chunk.toString().trim().split(/\s+/).at(-1)));
  });
}

const post = (url, body, query = '') => fetch(url + 'api/preview' + query,
  { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });

test('SLDPRT upload requires the offline parser even when the SOLIDWORKS bridge is enabled', async t => {
  const url = await startServer(t, '', { XYCAD_SLDPRT_PARSER_DIR: '', XYCAD_SOLIDWORKS: '1' });
  const result = await fetch(url + 'api/preview', {
    method: 'POST', body: 'part upload',
    headers: { 'Content-Type': 'application/octet-stream', 'X-XYCAD-Format': 'sldprt' },
  });
  assert.equal(result.status, 503);
  assert.match((await result.json()).error, /尚未配置 SLDPRT 离线解析器/);
  const invalid = await fetch(url + 'api/preview', {
    method: 'POST', body: 'part upload', headers: { 'Content-Type': 'application/octet-stream',
      'X-XYCAD-Format': 'sldprt', 'X-XYCAD-Configuration': '../other' },
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /无效的零件配置编号/);
});

test('shared STEP preview keeps repeated occurrences in one mesh and projects the selected placement', async t => {
  const url = await startServer(t);
  const body = [
    'ISO-10303-21;HEADER;ENDSEC;DATA;',
    '#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));',
    "#2=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#1))REPRESENTATION_CONTEXT('',''));",
    "#3=COORDINATES_LIST('',3,((0,0,0),(3,0,0),(0,4,0)));",
    "#4=TRIANGULATED_SURFACE_SET('',#3,3,(),(),((1,2,3)));",
    "#5=CARTESIAN_POINT('',(0,0,0));#6=CARTESIAN_POINT('',(10,2,0));",
    "#7=AXIS2_PLACEMENT_3D('',#5,$,$);#8=AXIS2_PLACEMENT_3D('',#6,$,$);",
    "#9=TESSELLATED_SHAPE_REPRESENTATION('Part',(#4),#2);",
    "#10=TESSELLATED_SHAPE_REPRESENTATION('Assembly',(#4),#2);",
    "#11=ITEM_DEFINED_TRANSFORMATION('','',#7,#8);",
    "#12=(REPRESENTATION_RELATIONSHIP('','',#9,#10)REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#11)SHAPE_REPRESENTATION_RELATIONSHIP());",
    ' #13=CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#12,$);',
    'ENDSEC;END-ISO-10303-21;',
  ].join('\n');
  const response = await fetch(url + 'api/preview', {
    method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', 'X-XYCAD-Format': 'stp', 'X-XYCAD-Assembly': '1' },
  });
  const { scene, error } = await response.json();
  assert.equal(response.status, 200, error);
  assert.equal(scene.mesh.instances, 2);
  assert.equal(scene.mesh.count, 2);
  assert.equal(scene.mesh.uniqueCount, 1);
  assert.equal(scene.mesh.positions, undefined);
  assert.deepEqual(scene.mesh.size, [13, 6, 0]);
  const [first, moved] = scene.mesh.tree[0].children;
  assert.equal(first.meshId, moved.meshId);
  assert.ok(Math.abs((moved.translation[0] - first.translation[0]) * 13 - 10) < 1e-10);
  const asset = url + 'api/assembly/' + scene.mesh.asset;
  const chunk = await fetch(asset + '/mesh?parts=0');
  assert.match(chunk.headers.get('content-type'), /octet-stream/);
  assert.equal((await chunk.arrayBuffer()).byteLength, 36);
  assert.equal((await fetch(asset + '/mesh?parts=1')).status, 404);
  assert.equal((await fetch(asset + '/mesh?parts=..%2Fscene.json')).status, 400);
  const projection = await fetch(asset + '/projection?part=0.1&front=pz');
  const result = await projection.json();
  assert.equal(projection.status, 200, result.error);
  assert.equal(result.scene.projectionPart.path, '0.1');
  const dxf = await fetch(asset + '/projection?part=0.1&front=pz&format=dxf');
  assert.match(dxf.headers.get('content-type'), /application\/dxf/);
  assert.ok(parseDxf(Buffer.from(await dxf.arrayBuffer())).entities.some(entity => entity.type === 'LINE'));
});

test('preview diagnostics defaults off and rejects cross-origin requests when configured', async t => {
  const disabled = await startServer(t, '', { XYCAD_OPENAI_API_KEY: '', XYCAD_OPENAI_MODEL: '' });
  const route = 'api/preview-diagnostics';
  assert.deepEqual(await (await fetch(disabled + route)).json(), { enabled: false });
  const enabled = await startServer(t, '', { XYCAD_OPENAI_API_KEY: 'test-only', XYCAD_OPENAI_MODEL: 'test-model' });
  assert.deepEqual(await (await fetch(enabled + route)).json(), { enabled: true });
  const endpoint = enabled + route + '?format=slddrw&status=partial';
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://other.test' } })).status, 403);
  const headers = { Origin: new URL(enabled).origin };
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'drawing bytes' })).status, 400);
  assert.equal((await fetch(endpoint + '&name=file', { method: 'POST', headers })).status, 400);
});

test('preview diagnostics sends only the format and state to the official Responses endpoint', async () => {
  const result = await explainPreview({ apiKey: 'test-only', model: 'test-model', format: 'x_t', status: 'partial' },
    async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test-only');
      const payload = JSON.parse(options.body);
      assert.equal(payload.store, false);
      assert.deepEqual(JSON.parse(payload.input), { format: 'x_t', preview: 'partial' });
      return Response.json({ status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: '诊断结果' }] }] });
    });
  assert.deepEqual(result, { text: '诊断结果' });
});

test('the BDYC bridge streams the original through the existing user session', async t => {
  const bytes = await readFile(new URL('../public/sample.dxf', import.meta.url));
  const requests = [];
  const bdyc = createServer((request, response) => {
    requests.push({ url: request.url, cookie: request.headers.cookie });
    response.writeHead(200, { 'Content-Type': 'image/vnd.dxf', 'Content-Disposition': 'attachment; filename="source.dxf"' });
    response.end(bytes);
  });
  t.after(() => bdyc.close());
  bdyc.listen(0, '127.0.0.1');
  await once(bdyc, 'listening');
  const origin = 'http://127.0.0.1:' + bdyc.address().port;
  const url = await startServer(t, '', { XYCAD_BDYC_ORIGIN: origin });
  const source = url + 'api/bdyc-file';
  assert.deepEqual(await (await fetch(source)).json(), { login: origin + '/login' });
  const path = '图纸/2026/样图.dxf';
  const target = source + '?' + new URLSearchParams({ path });
  const headers = { 'X-XYCAD-BDYC': '1' };
  assert.equal((await fetch(target, { headers })).status, 401);
  const session = 'bdyc_session=' + 'A'.repeat(43);
  const cookie = session + '; other=value';
  assert.equal((await fetch(target, { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(source + '?path=abc/../sample.dxf', { headers: { ...headers, Cookie: cookie } })).status, 400);
  const response = await fetch(target, { headers: { ...headers, Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(requests, [{ url: '/download?' + new URLSearchParams({ path }), cookie: session }]);
  assert.equal((await post(url, bytes)).status, 200);
});

test('official SOLIDWORKS conversion is opt-in and rejects invalid requests before launching', async t => {
  const disabled = await startServer(t, '', { XYCAD_SOLIDWORKS: '' });
  const route = 'api/solidworks';
  assert.deepEqual(await (await fetch(disabled + route)).json(), { enabled: false });
  if (process.platform !== 'win32') return;
  const enabled = await startServer(t, '', { XYCAD_SOLIDWORKS: '1' });
  const endpoint = enabled + route + '?format=dxf';
  assert.deepEqual(await (await fetch(enabled + route)).json(), { enabled: true });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://other.test' } })).status, 403);
  const result = await fetch(endpoint, { method: 'POST', headers: { Origin: new URL(enabled).origin,
    'Content-Type': 'application/octet-stream' }, body: 'invalid container' });
  assert.equal(result.status, 422);
  assert.match((await result.json()).error, /有效的 SLDDRW/);
  const partServer = await startServer(t, '', { XYCAD_SOLIDWORKS: '1' });
  const part = await fetch(partServer + route + '?format=step', { method: 'POST',
    headers: { Origin: new URL(partServer).origin, 'Content-Type': 'application/octet-stream' }, body: 'invalid container' });
  assert.equal(part.status, 422);
  assert.match((await part.json()).error, /有效的 SLDPRT/);
});

function savedSheetPng(color, rgba = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = rgba ? 6 : 2;
  const chunk = (name, payload) => {
    const body = Buffer.concat([Buffer.from(name), payload]);
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(payload.length, 0);
    body.copy(result, 4);
    result.writeUInt32BE(crc32(body), result.length - 4);
    return result;
  };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, ...color]))), chunk('IEND', Buffer.alloc(0))]);
}

function solidWorksRecord(name, data, valid = true) {
  const compressed = deflateRawSync(data);
  const header = Buffer.alloc(26);
  header.set(Buffer.from('140006000800', 'hex'));
  header.writeUInt32LE(valid ? crc32(data) : 0, 10);
  header.writeUInt32LE(compressed.length, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(name.length, 22);
  const encoded = Buffer.from(name).map(byte => (byte >>> 4) | (byte << 4 & 255));
  return Buffer.concat([header, encoded, compressed]);
}

function sheetName(name) {
  return Buffer.concat([Buffer.from([255, 254, 255, name.length]), Buffer.from(name, 'utf16le')]);
}

test('SLDDRW without vector caches retains page order and PDF without serving a raster preview or DXF', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const names = ['零件图', '装配图'];
  const list = Buffer.concat([Buffer.from([2, 0]), ...names.map(sheetName)]);
  const metadata = Buffer.from('<property name="SW-Current Sheet" pid="19"><vt:lpstr>2</vt:lpstr></property>');
  const first = savedSheetPng([15, 0, 0]);
  const second = savedSheetPng([0, 128, 0, 64], true);
  const prefix = Buffer.concat([Buffer.alloc(16), solidWorksRecord('SheetPreviews/SheetNames', list),
    solidWorksRecord('docProps/ISolidWorksInformation.xml', metadata), solidWorksRecord('Images/Sheet_0', first)]);
  const source = Buffer.concat([prefix, solidWorksRecord('PreviewPNG', second),
    solidWorksRecord('Images/Sheet_1', first), solidWorksRecord('Images/Sheet_0', second, false)]);
  const result = await post(url, source);
  assert.equal(result.status, 200);
  const { scene } = await result.json();
  assert.equal(scene.format, 'SolidWorks SLDDRW');
  assert.deepEqual(scene.sheets.map(sheet => sheet.name), names);
  assert.deepEqual(scene.items, []);
  assert.ok(scene.sheets.every(sheet => !sheet.image));
  assert.equal(scene.pdfAvailable, true);
  const send = (format, body = source) => fetch(url + 'api/export?format=' + format, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
  });
  const pdf = await send('pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const pdfBody = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
  assert.match(pdfBody, /^%PDF-1\.4/);
  assert.match(pdfBody, /\/Type \/Pages \/Count 2 \/Kids \[3 0 R 6 0 R\]/);
  const offset = Number(/startxref\n([0-9]+)/.exec(pdfBody)[1]);
  assert.equal(pdfBody.slice(offset, offset + 4), 'xref');
  assert.equal((await send('dxf')).status, 422);
  const partial = await post(url, prefix);
  assert.equal(partial.status, 200);
  assert.equal((await partial.json()).scene.pdfAvailable, false);
  for (const format of ['pdf', 'dxf']) assert.equal((await send(format, prefix)).status, 422);
  assert.equal((await send('svg')).status, 400);
  assert.equal((await send('pdf', 'not a drawing')).status, 422);
});

test('SLDDRW displays separate vector sheets and exports their independent drawing layers', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const names = ['主图', '副图'];
  const list = Buffer.concat([Buffer.from([2, 0]), ...names.map(sheetName)]);
  const metadata = Buffer.from('<property name="SW-Current Sheet" pid="19"><vt:lpstr>2</vt:lpstr></property>');
  function page(name, length) {
    const line = Buffer.alloc(57), size = Buffer.alloc(16);
    line.writeUInt32LE(80, 0);
    line.writeUInt32LE(4, 4);
    line.writeDoubleLE(length, 32);
    size.writeDoubleLE(0.210, 0);
    size.writeDoubleLE(0.297, 8);
    return Buffer.concat([line, size, sheetName(name)]);
  }
  const display = Buffer.concat([Buffer.from('uiLayerMgr_c'), page(names[0], 0.015), page(names[1] + '-Active', 0.025)]);
  const source = Buffer.concat([Buffer.alloc(16), solidWorksRecord('SheetPreviews/SheetNames', list),
    solidWorksRecord('docProps/ISolidWorksInformation.xml', metadata), solidWorksRecord('Contents/DisplayLists', display),
    solidWorksRecord('Contents/VBLists', Buffer.alloc(8))]);
  const response = await post(url, source);
  assert.equal(response.status, 200);
  const { scene } = await response.json();
  assert.deepEqual(scene.sheets.map(sheet => [sheet.name, sheet.items[0].end[0]]), [['主图', 15], ['副图', 25]]);
  assert.equal(scene.image, undefined);
  const result = await fetch(url + 'api/export?format=dxf', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: source,
  });
  assert.equal(result.headers.get('content-type'), 'application/dxf');
  const { entities } = parseDxf(new Uint8Array(await result.arrayBuffer()));
  assert.deepEqual(entities.map(entity => [name(entity, 8), number(entity, 10), number(entity, 11)]),
    [['P01-SHEET', 0, 15], ['P02-SHEET', 317, 342]]);

  function placement(scale, x, active) {
    const record = Buffer.alloc(145);
    record.writeDoubleLE(scale, 26);
    record.writeDoubleLE(x, 36);
    record.writeDoubleLE(0.1, 44);
    record.writeDoubleLE(1, 60);
    record.writeUInt32LE(active, 69);
    [x, 0.1, x + 0.01 * scale, 0.1 + 0.01 * scale].forEach((value, i) => record.writeDoubleLE(value, 105 + 8 * i));
    record.writeUInt32LE(1, 141);
    return record;
  }
  function viewCache(scale) {
    const header = Buffer.alloc(84);
    header.write('uiViewBucket_c', 10);
    header.writeDoubleLE(1, 40);
    header.writeDoubleLE(1 / scale, 56);
    header.writeUInt32LE(40, 64);
    header.writeUInt32LE(2, 80);
    const edge = (x, y) => {
      const record = Buffer.alloc(121);
      record.writeUInt32LE(769, 8);
      record.writeUInt32LE(2, 12);
      record.writeDoubleLE(x, 40);
      record.writeDoubleLE(y, 48);
      record.writeUInt32LE(110, 69);
      return record;
    };
    return Buffer.concat([header, edge(0.01, 0), edge(0, 0.01), Buffer.from([1, 0, 0, 0]), edge(0.01, 0.01)]);
  }
  const bothViews = Buffer.concat([display, placement(2, 0.12, 1), placement(1, 0.05, 0)]);
  const twoModels = Buffer.concat([Buffer.alloc(16), solidWorksRecord('SheetPreviews/SheetNames', list),
    solidWorksRecord('docProps/ISolidWorksInformation.xml', metadata), solidWorksRecord('Contents/DisplayLists', bothViews),
    solidWorksRecord('Contents/VBLists', Buffer.concat([viewCache(2), viewCache(1)]))]);
  const multi = await post(url, twoModels);
  assert.equal(multi.status, 200);
  const { scene: multiScene } = await multi.json();
  assert.equal(multiScene.dxfAvailable, true);
  assert.deepEqual(multiScene.sheets.map(sheet => sheet.items.filter(item => item.dash).map(item => item.start)),
    [[[50, 100]], [[120, 100]]]);
  const multiExport = await fetch(url + 'api/export?format=dxf', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: twoModels,
  });
  assert.equal(multiExport.status, 200);
  const exported = parseDxf(new Uint8Array(await multiExport.arrayBuffer()));
  assert.deepEqual(exported.entities.filter(entity => name(entity, 8).endsWith('-HIDDEN')).map(entity => name(entity, 8)),
    ['P01-VIEW-1-HIDDEN', 'P02-VIEW-1-HIDDEN']);
});

test('SLDDRW uses source vectors for preview and returns editable DXF in millimeters', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const line = Buffer.alloc(57);
  line.writeUInt32LE(80, 0);
  line.writeUInt32LE(4, 4);
  line.writeDoubleLE(0.035, 32);
  const placement = Buffer.alloc(144);
  placement[0] = 1;
  for (const offset of [1, 33, 65, 97, 131]) placement.writeDoubleLE(1, offset);
  placement.writeDoubleLE(0.05, 107);
  placement.writeUInt32LE(1, 140);
  const display = Buffer.concat([Buffer.from('uiLayerMgr_c'), line, placement]);
  const bucket = Buffer.alloc(84 + 89);
  bucket.write('uiViewBucket_c', 10);
  bucket.writeDoubleLE(1, 40);
  bucket.writeUInt32LE(2, 48);
  bucket.writeDoubleLE(1, 56);
  bucket.writeUInt32LE(40, 64);
  bucket.writeUInt32LE(1, 80);
  bucket.writeUInt32LE(1, 84);
  bucket.writeUInt32LE(1, 88);
  bucket.writeUInt32LE(2, 96);
  bucket.writeFloatLE(0.01, 112);
  Buffer.from('ffffffff0100000001000000', 'hex').copy(bucket, bucket.length - 12);
  const source = Buffer.concat([Buffer.alloc(16), solidWorksRecord('SheetPreviews/SheetNames', Buffer.from([1, 0, 255, 254, 255, 1, 65, 0])),
    solidWorksRecord('Contents/DisplayLists', display), solidWorksRecord('Contents/VBLists', bucket)]);
  const response = await post(url, source);
  assert.equal(response.status, 200);
  const { scene } = await response.json();
  assert.deepEqual(scene.sheets, [{ name: 'A', vector: true }]);
  assert.equal(scene.image, undefined);
  assert.deepEqual(scene.items.map(item => item.kind), ['line', 'line']);
  const result = await fetch(url + 'api/export?format=dxf', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: source,
  });
  assert.equal(result.headers.get('content-type'), 'application/dxf');
  const { entities } = parseDxf(new Uint8Array(await result.arrayBuffer()));
  assert.deepEqual(entities.map(entity => entity.type), ['LINE', 'LINE']);
  assert.deepEqual(entities.map(entity => name(entity, 8)), ['SHEET', 'VIEW-1']);
  assert.deepEqual(entities.map(entity => number(entity, 10)), [0, 50]);
  assert.deepEqual(entities.map(entity => Math.round(number(entity, 11) * 1e5) / 1e5), [35, 60]);

  const partial = Buffer.concat([Buffer.alloc(16), solidWorksRecord('SheetPreviews/SheetNames',
    Buffer.from([1, 0, 255, 254, 255, 1, 65, 0])), solidWorksRecord('Contents/DisplayLists', display)]);
  const partialResponse = await post(url, partial);
  assert.equal(partialResponse.status, 200);
  const { scene: partialScene } = await partialResponse.json();
  assert.equal(partialScene.sheets[0].vector, true);
  assert.equal(partialScene.items.length, 1);
  assert.equal(partialScene.dxfAvailable, false);
  assert.ok(partialScene.issues.some(([message]) => message.includes('缺少可读取的矢量缓存')));
});

test('SLDDRW matches a compact view placement to contours and edges with a reciprocal scale', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const line = Buffer.alloc(57);
  line.writeUInt32LE(80, 0);
  line.writeUInt32LE(4, 4);
  line.writeDoubleLE(0.035, 32);
  const placement = Buffer.alloc(145);
  placement.writeDoubleLE(2, 26);
  placement.writeDoubleLE(0.05, 36);
  placement.writeDoubleLE(0.1, 44);
  placement.writeDoubleLE(1, 60);
  placement.writeUInt32LE(1, 69);
  [0.05, 0.1, 0.07, 0.12].forEach((value, i) => placement.writeDoubleLE(value, 105 + i * 8));
  placement.writeUInt32LE(1, 141);
  const display = Buffer.concat([Buffer.from('uiLayerMgr_c'), line, placement]);
  const header = Buffer.alloc(72);
  header.write('uiViewBucket_c', 10);
  header.writeDoubleLE(1, 40);
  header.writeDoubleLE(0.5, 56);
  header.writeUInt32LE(50, 64);
  const count = value => Buffer.from([value, 0, 0, 0]);
  function edge(kind, endpoint) {
    const tail = 64;
    const result = Buffer.alloc(tail + (kind & 32 ? 140 : 57));
    result.writeUInt32LE(kind, 8);
    result.writeUInt32LE(2, 12);
    endpoint.forEach((value, i) => result.writeDoubleLE(value, 40 + 8 * i));
    result.writeUInt32LE(110, tail + 5);
    return result;
  }
  const bucket = Buffer.concat([header, count(1), edge(817, [0, 0.01]), count(0), count(1), edge(769, [0.01, 0])]);
  const source = Buffer.concat([Buffer.alloc(16),
    solidWorksRecord('SheetPreviews/SheetNames', Buffer.concat([Buffer.from([1, 0]), sheetName('A')])),
    solidWorksRecord('Contents/DisplayLists', display), solidWorksRecord('Contents/VBLists', bucket)]);
  const response = await post(url, source);
  assert.equal(response.status, 200);
  const { scene } = await response.json();
  assert.equal(scene.dxfAvailable, true);
  assert.deepEqual(scene.items.map(item => item.kind), ['line', 'line', 'line']);

  // The newer cache adds an explicit compact-placement marker before its translation.
  const compact = Buffer.alloc(16 + placement.length);
  placement.copy(compact, 16);
  compact.fill(0, 16, 32);
  compact.writeUInt32LE(5, 5);
  compact.writeDoubleLE(-0.002, 26);
  compact.writeDoubleLE(0.098, 16 + 113);
  compact.writeDoubleLE(0.118, 16 + 129);
  compact.writeUInt32LE(2, 16 + 141);
  header.writeUInt32LE(2, 48);
  function extendedEdge(endpoint, long) {
    const tail = 64;
    const record = Buffer.alloc(tail + (long ? 172 : 89));
    record.writeUInt32LE(1, 4);
    record.writeUInt32LE(2, 12);
    endpoint.forEach((value, i) => record.writeDoubleLE(value, 40 + 8 * i));
    record.writeFloatLE(-1, tail + 1);
    record.writeUInt32LE(101, tail + 9);
    record.writeUInt32LE(Number(long), tail + 49);
    return record;
  }
  const extended = Buffer.concat([header, count(1), extendedEdge([0, 0.01], true),
    count(0), count(1), extendedEdge([0.01, 0], false)]);
  const displayExtended = Buffer.concat([Buffer.from('uiLayerMgr_c'), line, compact]);
  const sourceExtended = Buffer.concat([Buffer.alloc(16),
    solidWorksRecord('SheetPreviews/SheetNames', Buffer.concat([Buffer.from([1, 0]), sheetName('A')])),
    solidWorksRecord('Contents/DisplayLists', displayExtended), solidWorksRecord('Contents/VBLists', extended)]);
  const extendedResponse = await post(url, sourceExtended);
  const { scene: extendedScene } = await extendedResponse.json();
  assert.equal(extendedScene.dxfAvailable, true);
  assert.deepEqual(extendedScene.items.map(item => item.kind), ['line', 'line', 'line']);
});

test('a model projects into editable three-view DXF and splits a partially occluded edge', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const model = 'v -4 2 0\nv 4 2 0\nv 4 2 2\nv -4 2 2\nv -1 0 -1\nv 1 0 -1\nv 1 0 1\nv -1 0 1\nf 1 2 3 4\nf 5 6 7 8\n';
  const project = query => fetch(url + 'api/projection' + query, {
    method: 'POST', body: model, headers: { 'Content-Type': 'application/octet-stream', 'X-XYCAD-Format': 'obj' },
  });
  const preview = await project('');
  assert.equal(preview.status, 200);
  const { scene } = await preview.json();
  assert.equal(scene.projection, true);
  assert.ok(scene.items.some(item => item.kind === 'line' && item.dash));
  assert.match(JSON.stringify(scene.issues), /未声明长度单位/);
  const exported = await project('?format=dxf');
  assert.equal(exported.headers.get('content-type'), 'application/dxf');
  const dxf = Buffer.from(await exported.arrayBuffer());
  assert.match(dxf.toString(), /\$INSUNITS\r\n70\r\n0\r\n/);
  const { entities } = parseDxf(dxf);
  const layer = value => entities.filter(entity => name(entity, 8) === value);
  const hidden = layer('FRONT-HIDDEN');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].type, 'LINE');
  assert.ok(Math.abs(Math.abs(number(hidden[0], 11) - number(hidden[0], 10)) - 2) < 1e-5);
  assert.ok(layer('TOP-VISIBLE').every(entity => number(entity, 20) < number(hidden[0], 20)));
  assert.ok(layer('RIGHT-VISIBLE').every(entity => number(entity, 10) < -4));
  assert.deepEqual(layer('VIEW-LABELS').map(entity => name(entity, 1)), ['正视图', '俯视图', '右视图']);

  const clean = await project('?format=dxf&hidden=0');
  const cleanDxf = parseDxf(new Uint8Array(await clean.arrayBuffer()));
  assert.ok(cleanDxf.entities.every(entity => !name(entity, 8).endsWith('-HIDDEN')));
  assert.equal(cleanDxf.entities.length, entities.length - hidden.length);
  assert.equal((await project('?format=pdf&hidden=8')).status, 400);
  async function pdfVectors(query) {
    const result = await project(query);
    assert.equal(result.headers.get('content-type'), 'application/pdf');
    const pdf = Buffer.from(await result.arrayBuffer());
    assert.match(pdf.toString('latin1'), /\/Type \/Pages \/Count 1/);
    assert.doesNotMatch(pdf.toString('latin1'), /\/Subtype \/Image/);
    const start = pdf.indexOf('stream\n') + 7;
    const end = pdf.indexOf('\nendstream', start);
    return inflateSync(pdf.subarray(start, end)).toString();
  }
  const pdf = await pdfVectors('?format=pdf');
  const cleanPdf = await pdfVectors('?format=pdf&hidden=0');
  assert.match(pdf, /\[3 2\] 0 d\n[^\n]+ m [^\n]+ l S\n/);
  assert.doesNotMatch(cleanPdf, /\[3 2\] 0 d\n[^\n]+ m [^\n]+ l S\n/);
  assert.match(cleanPdf, /\(Front\) Tj[\s\S]+\(Top\) Tj[\s\S]+\(Right\) Tj/);
  const side = await project('?front=px');
  assert.equal((await side.json()).scene.projectionFront, 'px');
  const sideDxf = parseDxf(new Uint8Array(await (await project('?front=px&format=dxf')).arrayBuffer()));
  const sideX = sideDxf.entities.filter(entity => name(entity, 8) === 'FRONT-VISIBLE')
    .flatMap(entity => [number(entity, 10), number(entity, 11)]);
  assert.ok(Math.abs(Math.max(...sideX) - Math.min(...sideX) - 2) < 1e-5);
  assert.equal((await project('?front=iso')).status, 400);
});

test('the selected assembly occurrence projects before whole-model normalization', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const model = [
    'v 0 0 0', 'v 3 0 0', 'v 0 0 1',
    'v 1000000000000 0 0', 'v 1000000000007 0 0', 'v 1000000000000 0 2',
    'o 同名零件', 'f 1 2 3', 'o 同名零件', 'g 选件', 'f 4 5 6',
  ].join('\n');
  const project = (part, format) => fetch(url + 'api/projection/part?' + new URLSearchParams({ part, ...(format && { format }) }), {
    method: 'POST', body: model, headers: { 'Content-Type': 'application/octet-stream', 'X-XYCAD-Format': 'obj' },
  });
  const preview = await project('1.0');
  assert.equal(preview.status, 200);
  assert.deepEqual((await preview.json()).scene.projectionPart, { path: '1.0', label: '选件' });
  async function frontWidth(path) {
    const response = await project(path, 'dxf');
    assert.equal(response.headers.get('content-type'), 'application/dxf');
    const { entities } = parseDxf(new Uint8Array(await response.arrayBuffer()));
    const front = entities.filter(entity => name(entity, 8) === 'FRONT-VISIBLE');
    const positions = front.flatMap(entity => [number(entity, 10), number(entity, 11)]);
    return Math.max(...positions) - Math.min(...positions);
  }
  assert.equal(await frontWidth('0'), 3);
  assert.equal(await frontWidth('1'), 7);
  assert.equal(await frontWidth('1.0'), 7);
  const partPdf = await project('1.0', 'pdf');
  assert.equal(partPdf.headers.get('content-type'), 'application/pdf');
  assert.match(await partPdf.text(), /^%PDF-1\.4/);
  assert.equal((await project('1.1', 'dxf')).status, 422);
  assert.equal((await project('1..0')).status, 400);
});

function dwgWithBitmap() {
  const start = 64;
  const imageOffset = start + 21 + 9;
  const imageSize = 44;
  const end = imageOffset + imageSize;
  const bytes = Buffer.alloc(end + 16);
  bytes.write('AC1024');
  bytes.writeUInt32LE(start, 13);
  Buffer.from('1f256d07d43628289d57ca3f9d44102b', 'hex').copy(bytes, start);
  bytes.writeUInt32LE(end - start - 20, start + 16);
  bytes[start + 20] = 1;
  bytes[start + 21] = 2;
  bytes.writeUInt32LE(imageOffset, start + 22);
  bytes.writeUInt32LE(imageSize, start + 26);
  bytes.writeUInt32LE(40, imageOffset);
  bytes.writeInt32LE(1, imageOffset + 4);
  bytes.writeInt32LE(1, imageOffset + 8);
  bytes.writeUInt16LE(1, imageOffset + 12);
  bytes.writeUInt16LE(24, imageOffset + 14);
  Buffer.from('e0da92f82bc9d7d762a835c062bbefd4', 'hex').copy(bytes, end);
  return bytes;
}

test('the self-hosted service returns drawing data and keeps parser source private', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const index = await fetch(url);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /XYCAD 自托管解析/);
  for (const path of ['src/dxf-parser.mjs', 'src/dxf-scene.mjs', 'src/dwg-preview.mjs', 'src/exb-vector.mjs', 'dxf-parser.mjs', 'server.mjs']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 404);
  }
  const body = await readFile(new URL('../public/sample.dxf', import.meta.url));
  const result = await post(url, body);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const { scene } = await result.json();
  assert.ok(scene.items.some(item => item.content === '180'));
  assert.ok(scene.layers.some(layer => layer.name === '标注_DIM'));
  const invalid = await post(url, 'AutoCAD Binary DXF');
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).error, /二进制 DXF/);
});

test('STL uploads serve the same geometry for text and binary files, including a solid-prefixed binary header', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const text = `solid test
facet normal 0 0 1
outer loop
vertex -1 0 3
vertex 1 0 3
vertex 0 4 3
endloop
endfacet
endsolid test
`;
  const bytes = Buffer.alloc(134);
  bytes.write('solid binary sample');
  bytes.writeUInt32LE(1, 80);
  [-1, 0, 3, 1, 0, 3, 0, 4, 3].forEach((value, i) => bytes.writeFloatLE(value, 96 + 4 * i));
  const [ascii, binary] = await Promise.all([post(url, text), post(url, bytes)]);
  assert.equal(ascii.status, 200);
  assert.equal(binary.status, 200);
  const a = (await ascii.json()).scene;
  const b = (await binary.json()).scene;
  assert.equal(a.format, 'STL（文本）');
  assert.equal(b.format, 'STL（二进制）');
  assert.deepEqual(a.mesh, b.mesh);
  assert.equal(a.mesh.unit, null);
  assert.deepEqual(a.mesh.size, [2, 4, 0]);
  const positions = Buffer.from(a.mesh.positions, 'base64');
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => positions.readFloatLE(4 * i)),
    [-0.25, -0.5, 0, 0.25, -0.5, 0, 0, 0.5, 0]);
  const truncated = await fetch(url + 'api/preview', { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-XYCAD-Format': 'stl' }, body: bytes.subarray(0, 110) });
  assert.equal(truncated.status, 422);
  assert.match((await truncated.json()).error, /STL/);
});

test('DWG works without a converter and rejects broken preview offsets', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const bytes = dwgWithBitmap();
  const result = await post(url, bytes);
  assert.equal(result.status, 200);
  const { scene } = await result.json();
  assert.equal(scene.dwgVersion, 'AC1024');
  assert.equal(scene.image.mime, 'image/bmp');
  assert.equal(Buffer.from(scene.image.base64, 'base64').toString('ascii', 0, 2), 'BM');
  assert.deepEqual(scene.layers, []);
  bytes.writeUInt32LE(0xffffffff, 13);
  const invalid = await post(url, bytes);
  assert.equal(invalid.status, 422);
  assert.match((await invalid.json()).error, /没有可读取的内嵌预览/);
});

test('a block view displays editable DXF multileader geometry without placing the block in model space', { timeout: 10000 }, async t => {
  const url = await startServer(t);
  const drawing = [
    [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [330, 'AB'], [2, 'DETAIL'],
    [0, 'MULTILEADER'], [100, 'AcDbMLeader'], [300, 'CONTEXT_DATA{'], [41, 3], [140, 3],
    [290, 1], [304, '右门'], [12, 28], [22, 15], [171, 1],
    [302, 'LEADER{'], [290, 1], [291, 1], [10, 20], [20, 10], [11, 1], [21, 0], [40, 5],
    [304, 'LEADER_LINE{'], [10, 0], [20, 0], [10, 8], [20, 0], [305, '}'], [303, '}'], [301, '}'],
    [170, 1], [290, 1], [291, 1], [0, 'ENDBLK'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [10, 0], [20, 0], [11, 1], [21, 1], [0, 'ENDSEC'], [0, 'EOF'],
  ].flat().join('\n') + '\n';
  const { scene: model } = await (await post(url, drawing)).json();
  assert.deepEqual(model.items.map(item => item.kind), ['line']);
  assert.deepEqual(model.blockViews, [{ handle: 'AB', name: 'DETAIL', count: 1 }]);
  const selected = await post(url, drawing, '?block=ab');
  assert.equal(selected.status, 200);
  const { scene } = await selected.json();
  assert.equal(scene.blockView.handle, 'AB');
  assert.deepEqual(scene.items.map(item => item.kind), ['fill', 'path', 'line', 'text']);
  assert.deepEqual(scene.items[0].vertices, [[3, -0.5], [0, 0], [3, 0.5]]);
  assert.equal(scene.items[1].path, 'M 3 0 L 8 0 L 20 10');
  assert.deepEqual(scene.items[2].end, [25, 10]);
  assert.equal(scene.items[3].content, '右门');
  assert.deepEqual(scene.items[3].origin, [28, 15]);
  const short = await post(url, drawing.replace('140\n3\n', '140\n6\n'), '?block=AB');
  assert.deepEqual((await short.json()).scene.items.map(item => item.kind), ['path', 'line', 'text']);
  assert.equal((await post(url, drawing, '?block=bad%20')).status, 400);
  assert.equal((await post(url, drawing, '?block=AA')).status, 422);
});

test('accepts a chunked upload and a complete file above the old upload ceiling', { timeout: 30000 }, async t => {
  const storage = await mkdtemp(join(tmpdir(), 'xycad-test-upload-'));
  const url = await startServer(t, '', { TEMP: storage, TMP: storage, TMPDIR: storage });
  t.after(() => rmdir(storage));
  const source = await readFile(new URL('../public/sample.dxf', import.meta.url));
  const dxf = Buffer.concat([Buffer.from('999\n'), Buffer.alloc(16 * MiB, 32), Buffer.from('\n'), source]);
  const response = await post(url, dxf);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).scene.items.some(item => item.content === '180'));

  const off = Buffer.from('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n');
  const headers = { 'Content-Type': 'application/octet-stream', 'X-XYCAD-Format': 'off' };
  const chunked = await fetch(url + 'api/preview', {
    method: 'POST', headers, duplex: 'half', body: new ReadableStream({ start(controller) {
      controller.enqueue(off.subarray(0, 5));
      controller.enqueue(off.subarray(5));
      controller.close();
    } }),
  });
  assert.equal(chunked.status, 200);
  assert.equal((await chunked.json()).scene.mesh.count, 1);

  const length = 256 * MiB + 1;
  const req = httpRequest(url + 'api/preview', { method: 'POST', headers: { ...headers, 'Content-Length': length } });
  const reply = once(req, 'response');
  req.write(off);
  const pad = Buffer.alloc(MiB, 32);
  for (let i = off.length; i < length; i += pad.length) {
    if (!req.write(pad.subarray(0, Math.min(pad.length, length - i)))) await once(req, 'drain');
  }
  req.end();
  const [large] = await reply;
  assert.deepEqual(await readdir(storage), []);
  const chunks = [];
  for await (const chunk of large) chunks.push(chunk);
  assert.equal(large.statusCode, 200, Buffer.concat(chunks).toString());
  assert.equal(JSON.parse(Buffer.concat(chunks)).scene.mesh.count, 1);
  assert.equal((await post(url, Buffer.alloc(0))).status, 400);
  assert.deepEqual(await readdir(storage), []);

  async function waitForEntries(expected) {
    for (let i = 0; i < 100; i++) {
      if ((await readdir(storage)).length === expected) return;
      await delay(20);
    }
    assert.fail('The upload temporary directory did not reach the expected state.');
  }
  const interrupted = httpRequest(url + 'api/preview', { method: 'POST', headers });
  interrupted.on('error', () => {});
  interrupted.write(off);
  await waitForEntries(1);
  interrupted.destroy();
  await waitForEntries(0);
});

test('a local DWG converter uses the same DXF pipeline, with native preview as a fallback', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xycad-test-converter-'));
  const file = join(dir, 'convert.mjs');
  t.after(async () => {
    await rm(file);
    await rmdir(dir);
  });
  const sample = new URL('../public/sample.dxf', import.meta.url).href;
  await writeFile(file, `
    import { readFile } from 'node:fs/promises';
    export async function convertDwg(bytes, { version }) {
      if (bytes[10] === 2) process.exit(9);
      if (version !== 'AC1024' || bytes[10] === 1) {
        bytes.fill(0);
        throw new Error('fixture could not convert file');
      }
      return readFile(new URL(${JSON.stringify(sample)}));
    }
  `);
  const url = await startServer(t, file);
  const bytes = dwgWithBitmap();
  const converted = await post(url, bytes);
  assert.equal(converted.status, 200);
  const { scene } = await converted.json();
  assert.equal(scene.dwgVersion, 'AC1024');
  assert.ok(scene.items.some(item => item.content === '180'));
  const exported = await fetch(url + 'api/convert', { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('Content-Type'), 'application/dxf');
  assert.match(await exported.text(), /COPPER BUSBAR/);
  bytes[10] = 1;
  const fallback = await post(url, bytes);
  assert.equal(fallback.status, 200);
  const fallbackScene = (await fallback.json()).scene;
  assert.equal(fallbackScene.image.mime, 'image/bmp');
  assert.match(fallbackScene.issues[0][0], /转换模块未返回有效结果/);
  const large = Buffer.alloc(4 * MiB);
  bytes.copy(large);
  large[10] = 2;
  const aborted = await post(url, large);
  assert.equal(aborted.status, 422);
  assert.match((await aborted.json()).error, /大图解析未完成/);
  large[10] = 0;
  const recovered = await post(url, large);
  assert.equal(recovered.status, 200);
  assert.ok((await recovered.json()).scene.items.some(item => item.content === '180'));
});
