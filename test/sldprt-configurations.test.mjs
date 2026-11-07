import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

test('offline configurations preserve native slot identity, active selection and deleted-slot exclusion', t => {
  const python = process.env.XYCAD_SLDPRT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const result = spawnSync(python, ['-I', '-S', '-B', fileURLToPath(new URL('./sldprt_configurations.py', import.meta.url))],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error?.code === 'ENOENT') return t.skip('Optional offline Python runtime is unavailable');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
