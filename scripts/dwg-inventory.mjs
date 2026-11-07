import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dwgVersion } from '../src/dwg-preview.mjs';

const [first, ...rest] = process.argv.slice(2);
const copperOnly = first === '--copper';
const roots = copperOnly ? rest : [first, ...rest].filter(Boolean);
if (!roots.length) {
  console.error('用法 node scripts/dwg-inventory.mjs [--copper] <目录> [...]');
  process.exit(1);
}

const copper = /铜排|铜条|铜牌|铜板|铜-T|紫铜|bus[ _-]*bar|汇流排/i;
const inventory = new Map();
const hashes = new Set();
let scanned = 0;
let unreadable = 0;
for (const root of roots) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.dwg$/i.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    if (copperOnly && !copper.test(path)) continue;
    scanned++;
    try {
      const hash = createHash('sha256');
      let version;
      for await (const chunk of createReadStream(path)) {
        version ??= dwgVersion(chunk) ?? 'UNKNOWN';
        hash.update(chunk);
      }
      const id = hash.digest('hex');
      if (hashes.has(id)) continue;
      hashes.add(id);
      version ??= 'UNKNOWN';
      inventory.set(version, (inventory.get(version) ?? 0) + 1);
    } catch {
      unreadable++;
    }
  }
}
console.log(JSON.stringify({
  scanned, unique: hashes.size, unreadable,
  versions: Object.fromEntries([...inventory].sort((first, second) => second[1] - first[1])),
}, null, 2));
