import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Public release 2026-11-07: retain NOTICE/docs and accept external destinations on another drive.
import { resolve, relative, dirname, join, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadExtensions } from '../public/cad-limits.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = process.argv[2] && resolve(process.argv[2]);
const destinationRelative = destination && relative(root, destination);
if (!destination || (!isAbsolute(destinationRelative) && destinationRelative !== '..' && !destinationRelative.startsWith('..' + sep))) {
  throw new Error('请指定项目目录之外的 BDYC 运行目录。');
}
const files = ['server.mjs', 'package.json', 'LICENSE', 'NOTICE', 'README.md',
  'docs/release.md', 'docs/known-limitations.md', 'docs/bdyc-integration.md', 'docs/project-regression.md'];
for (const directory of ['src', 'public', 'scripts']) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.parentPath.includes('__pycache__')) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
    if (/\.(mjs|html|css|dxf|py|ps1|cs)$/.test(path)) files.push(path);
  }
}
const hashes = {};
for (const file of files.sort()) {
  const bytes = await readFile(join(root, file));
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  const target = join(destination, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target + '.new', bytes);
  await rename(target + '.new', target);
}
const manifest = { schema: 1, product: 'XYCAD', formats: uploadExtensions, files: hashes,
  identity: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') };
await writeFile(join(destination, 'manifest.json.new'), JSON.stringify(manifest, null, 2) + '\n');
await rename(join(destination, 'manifest.json.new'), join(destination, 'manifest.json'));
console.log(JSON.stringify({ destination, files: files.length, identity: manifest.identity }));
