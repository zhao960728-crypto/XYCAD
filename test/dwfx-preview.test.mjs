import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { readDwfxPreview } from '../src/dwfx-preview.mjs';
import { buildPreview } from '../src/dxf-worker.mjs';

function zip(parts) {
  const files = [], directory = [];
  let offset = 0;
  for (const [path, text] of Object.entries(parts)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(8, 10);
    local.copy(record, 16, 14, 28);
    record.writeUInt32LE(offset, 42);
    directory.push(record, name);
    offset += local.length + name.length + packed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

const parts = {
  '_rels/.rels': '<Relationships><Relationship Type="http://schemas.autodesk.com/dwfx/2007/relationships/documentsequence"/>' +
    '<Relationship Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/print.fdseq"/></Relationships>',
  '[Content_Types].xml': '<Types/>',
  'print.fdseq': '<FixedDocumentSequence><DocumentReference Source="sheets/print.fdoc"/></FixedDocumentSequence>',
  'sheets/print.fdoc': '<FixedDocument><PageContent Source="2.fpage"/><PageContent Source="1.fpage"/></FixedDocument>',
  'sheets/1.fpage': '<FixedPage Width="200" Height="100"><Path Stroke="#222222" Data="M 5 5 L 80 20"/></FixedPage>',
  'sheets/2.fpage': '<FixedPage Width="100" Height="200"><Canvas RenderTransform="2,0,0,2,4,5" Clip="M0,0 h90 v150 z">' +
    '<Path Fill="#80010203" Data="F1 M 0,0 L 10,20 Z"/><Glyphs UnicodeString="Ignored"/></Canvas></FixedPage>',
};

test('DWFx reads document order, clips and paint while isolating unsupported objects', () => {
  const scene = readDwfxPreview(zip(parts));
  assert.deepEqual(scene.items.map(item => [item.width, item.height, item.offset]), [[100, 200, 0], [200, 100, 224]]);
  const canvas = scene.items[0].shapes[0];
  assert.deepEqual(canvas.matrix, [2, 0, 0, 2, 4, 5]);
  assert.equal(canvas.clip.rule, 'evenodd');
  assert.equal(canvas.children[0].path.rule, 'nonzero');
  assert.equal(canvas.children[0].fill, '#01020380');
  assert.equal(scene.issues[0][1], 1);
});

test('DWFx renders equivalent property-element transforms, clips, paths and solid brushes', () => {
  const page = '<FixedPage Width="200" Height="100"><Canvas>' +
    '<Canvas.RenderTransform><MatrixTransform Matrix="2,0,0,2,4,5"/></Canvas.RenderTransform>' +
    '<Canvas.Clip><PathGeometry FillRule="Nonzero" Figures="M0,0 h90 v80 z"/></Canvas.Clip>' +
    '<Path><Path.Data><PathGeometry Figures="M 5,5 L 80,20"/></Path.Data>' +
    '<Path.Stroke><SolidColorBrush Color="#80010203" Opacity="0.5"/></Path.Stroke></Path>' +
    '</Canvas></FixedPage>';
  const scene = readDwfxPreview(zip({ ...parts, 'sheets/1.fpage': page }));
  const [canvas] = scene.items[1].shapes;
  assert.deepEqual(canvas.matrix, [2, 0, 0, 2, 4, 5]);
  assert.equal(canvas.clip.rule, 'nonzero');
  assert.equal(canvas.children[0].stroke, '#01020340');
  assert.equal(canvas.children[0].path.d, 'M 5,5 L 80,20');
  assert.equal(scene.issues.length, 1);
});

test('DWFx rejects unsafe page XML and a corrupt ZIP checksum', () => {
  assert.throws(() => readDwfxPreview(zip({ ...parts, 'sheets/2.fpage': '<!DOCTYPE FixedPage SYSTEM "https://example.invalid/">' + parts['sheets/2.fpage'] })), /页面 XML 无效/);
  const invalid = zip(parts);
  const central = invalid.readUInt32LE(invalid.length - 6);
  invalid[central + 16] ^= 1;
  assert.throws(() => readDwfxPreview(invalid), /包目录无效/);
});

const modelPart = '3D/model.model';
const modelPackage = model => zip({
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/model.model"/></Relationships>',
  '[Content_Types].xml': '<Types/>',
  [modelPart]: model,
});
const model = `<m:model xmlns:m="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="inch">
<m:metadata name="Title">Test &amp; test</m:metadata>
<m:resources>
  <m:object id="1" name="连接件"><m:mesh><m:vertices>
    <m:vertex x="0" y="0" z="0"/><m:vertex x="2" y="0" z="0"/><m:vertex x="0" y="3" z="0"/>
  </m:vertices><m:triangles><m:triangle v1="0" v2="1" v3="2"/></m:triangles></m:mesh></m:object>
  <m:object id="2"><m:components><m:component objectid="1" transform="1 0 0 0 1 0 0 0 1 4 0 0"/></m:components></m:object>
</m:resources>
<m:build>
  <m:item objectid="1"/>
  <m:item objectid="2" transform="0 1 0 -1 0 0 0 0 1 0 0 5"/>
</m:build></m:model>`;

test('3MF follows the model relationship and preserves units, build items and nested transforms', async () => {
  const { scene } = await buildPreview({ bytes: modelPackage(model) });
  assert.equal(scene.format, '3MF');
  assert.equal(scene.mesh.count, 2);
  assert.equal(scene.mesh.unit, 'in');
  assert.deepEqual(scene.mesh.size, [5, 6, 5]);
  const bytes = Buffer.from(scene.mesh.positions, 'base64');
  assert.equal(bytes.length, 72);
  assert.equal(bytes.readFloatLE(36), Math.fround(0.5 / 6));
  assert.equal(bytes.readFloatLE(40), Math.fround(1 / 6));
  assert.equal(bytes.readFloatLE(44), Math.fround(2.5 / 6));
  const [first, assembly] = scene.mesh.tree;
  const [second] = assembly.children;
  assert.equal(first.label, '连接件');
  assert.equal(second.label, first.label);
  assert.equal(first.color, second.color);
  assert.equal(second.start, 1);
  assert.notDeepEqual(second.center, first.center);
});

test('3MF rejects out-of-range indices, reference cycles, required extensions and external entities', async () => {
  const parse = xml => buildPreview({ bytes: modelPackage(xml), formatHint: '3mf' });
  await assert.rejects(parse(model.replace('v3="2"', 'v3="3"')), /XML 或引用无效/);
  await assert.rejects(parse(model.replace('component objectid="1"', 'component objectid="2"')), /组件引用循环/);
  await assert.rejects(parse(model.replace('<m:model ', '<m:model requiredextensions="x" ')), /未支持的扩展/);
  await assert.rejects(parse('<!DOCTYPE model SYSTEM "https://example.invalid/">' + model), /XML 或引用无效/);
});
