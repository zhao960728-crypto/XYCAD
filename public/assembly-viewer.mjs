import { pickMeshPoint } from './cad-measure.mjs';

const axes = [0, 1, 2];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const detailPixels = 140;
const batchBytes = 2 * 1024 * 1024;
const residentBytes = 96 * 1024 * 1024;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function bounds(part, camera) {
  const { node, offset } = part;
  const center = node.center.map((value, i) => value + offset[i] * camera.spread);
  return [camera.right, camera.up].map((axis, i) => {
    const radius = axes.reduce((sum, j) => sum + Math.abs(axis[j]) * node.half[j], 0) * camera.scale[i];
    const middle = dot(axis, center) * camera.scale[i] + camera.offset[i];
    return [middle - radius, middle + radius];
  });
}

export class AssemblyViewer {
  constructor(mesh, parts, viewer, onProgress) {
    this.mesh = mesh;
    this.viewer = viewer;
    this.onProgress = onProgress;
    this.parts = parts;
    this.resident = new Map();
    this.request = new AbortController();
    this.forced = new Set();
    this.instanceBuffer = viewer.upload(new Float32Array());
    this.visible = [];
    this.setVisible([[0, mesh.count]]);
  }

  clear() {
    this.request.abort();
    const gl = this.viewer.gl;
    for (const { buffer } of this.resident.values()) gl.deleteBuffer(buffer);
    gl.deleteBuffer(this.instanceBuffer);
  }

  restore() {
    this.instanceBuffer = this.viewer.upload(new Float32Array());
    for (const item of this.resident.values()) item.buffer = this.viewer.upload(item.positions);
  }

  setVisible(ranges) {
    let index = 0;
    this.partsVisible = this.parts.filter(({ node }) => {
      while (ranges[index] && node.start >= ranges[index][0] + ranges[index][1]) index++;
      return Boolean(ranges[index] && node.start >= ranges[index][0]);
    });
  }

  async load(keys) {
    this.loading = true;
    const url = './api/assembly/' + this.mesh.asset + '/mesh?' + new URLSearchParams({ parts: keys.join(',') });
    try {
      const response = await fetch(url, { signal: this.request.signal });
      if (!response.ok) throw new Error((await response.json()).error || '零件网格读取失败。');
      const data = await response.arrayBuffer();
      if (this.request.signal.aborted) return;
      if (data.byteLength !== keys.reduce((sum, key) => sum + this.bytes(key), 0)) {
        throw new Error('装配服务返回的网格数据不完整。');
      }
      let offset = 0;
      for (const key of keys) {
        const size = this.bytes(key);
        const positions = new Float32Array(data.slice(offset, offset + size));
        if (!littleEndian) {
          const view = new DataView(data, offset, size);
          for (let i = 0; i < positions.length; i++) positions[i] = view.getFloat32(i * 4, true);
        }
        this.resident.set(key, { positions, buffer: this.viewer.upload(positions), used: performance.now() });
        offset += size;
      }
    } catch (error) {
      if (!this.request.signal.aborted) this.failure = error.message;
    } finally {
      this.loading = false;
      if (!this.request.signal.aborted) this.viewer.drawSoon();
    }
  }

  bytes(key) {
    const coarse = key.endsWith('c');
    const definition = this.mesh.meshes[parseInt(key, 10)];
    return (coarse ? definition.coarseCount : definition.count) * 36;
  }

  draw(camera, uniforms) {
    const gl = this.viewer.gl;
    const needed = new Map(), groups = new Map();
    const wanted = new Set(), measuring = this.forced;
    let drawn = 0, detailed = 0, detailBytes = 0;
    const visible = [];
    for (const part of this.partsVisible) {
      const box = bounds(part, camera);
      if (box.some(([a, b]) => a > 1 || b < -1)) continue;
      const size = Math.max((box[0][1] - box[0][0]) * camera.width, (box[1][1] - box[1][0]) * camera.height) / 2;
      visible.push({ part, box, size });
    }
    visible.sort((a, b) => b.size - a.size);
    this.visible = visible;
    for (const { part, size } of visible) {
      const { node } = part;
      const full = String(node.meshId);
      const coarse = this.mesh.meshes[node.meshId].coarseCount ? full + 'c' : full;
      if (coarse !== full && (size >= detailPixels || measuring.has(full))) {
        if (!wanted.has(full) && (detailBytes + this.bytes(full) <= residentBytes / 2 || measuring.has(full))) {
          wanted.add(full);
          detailBytes += this.bytes(full);
        }
        if (wanted.has(full) && !this.resident.has(full)) needed.set(full, measuring.has(full) ? -1 : 1);
      }
      const ready = this.resident.has(full) && (wanted.has(full) || !this.resident.has(coarse)) ? full : coarse;
      if (!this.resident.has(coarse) && !(ready === full && wanted.has(full))) {
        needed.set(coarse, coarse === full && measuring.has(full) ? -1 : 0);
      }
      if (this.resident.has(ready)) {
        if (!groups.has(ready)) groups.set(ready, []);
        groups.get(ready).push(part);
        drawn++;
        if (ready === full) detailed++;
      }
      wanted.add(coarse);
    }
    gl.uniform1i(uniforms.sharedMesh, 1);
    for (const [key, parts] of groups) {
      const data = this.resident.get(key);
      const { buffer, positions } = data;
      data.used = performance.now();
      const attributes = new Float32Array(parts.length * 18);
      for (let i = 0; i < parts.length; i++) {
        const { node, color, offset } = parts[i];
        const start = i * 18;
        attributes.set(node.basis, start);
        attributes.set(node.translation, start + 9);
        attributes.set(color, start + 12);
        attributes.set(offset, start + 15);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, attributes, gl.STREAM_DRAW);
      for (const [index, offset] of [[3, 0], [4, 3], [5, 6], [6, 9], [1, 12], [2, 15]]) {
        gl.enableVertexAttribArray(index);
        gl.vertexAttribPointer(index, 3, gl.FLOAT, false, 72, offset * 4);
        gl.vertexAttribDivisor(index, 1);
      }
      gl.drawArraysInstanced(gl.TRIANGLES, 0, positions.length / 3, parts.length);
    }
    for (let index = 1; index <= 6; index++) {
      gl.vertexAttribDivisor(index, 0);
      gl.disableVertexAttribArray(index);
    }
    gl.uniform1i(uniforms.sharedMesh, 0);

    let total = 0;
    for (const item of this.resident.values()) total += item.positions.byteLength;
    if (total > residentBytes) {
      const unused = [...this.resident].filter(([key]) => !wanted.has(key)).sort((a, b) => a[1].used - b[1].used);
      for (const [key, item] of unused) {
        gl.deleteBuffer(item.buffer);
        this.resident.delete(key);
        total -= item.positions.byteLength;
        if (total <= residentBytes) break;
      }
    }
    this.onProgress({ drawn, detailed, visible: visible.length, failure: this.failure });
    if (needed.size && !this.loading && !this.failure) {
      const keys = [];
      let size = 0;
      for (const [key] of [...needed].sort((a, b) => a[1] - b[1])) {
        const bytes = this.bytes(key);
        if (keys.length && (keys.length === 16 || size + bytes > batchBytes)) break;
        keys.push(key);
        size += bytes;
      }
      void this.load(keys);
    }
  }

  pick(camera, screen, snapRadius) {
    const x = 2 * screen[0] / camera.width - 1, y = 1 - 2 * screen[1] / camera.height;
    const candidates = this.visible.filter(({ box }) => x >= box[0][0] && x <= box[0][1] && y >= box[1][0] && y <= box[1][1]);
    this.forced.clear();
    let nearest, depth = -Infinity;
    for (const { part } of candidates) {
      const { node, offset } = part;
      const key = String(node.meshId), data = this.resident.get(key);
      if (!data) { this.forced.add(key); continue; }
      const hit = pickMeshPoint({ positions: data.positions, basis: node.basis, translation: node.translation,
        partOffset: offset }, [[0, node.count]], camera, screen, snapRadius);
      if (!hit) continue;
      const z = dot(hit.point, camera.eye) + camera.spread * dot(offset, camera.eye);
      if (z > depth) { depth = z; nearest = hit; }
    }
    if (!this.forced.size) return nearest;
    if (this.failure) return { message: this.failure };
    this.viewer.drawSoon();
    return { message: '正在加载测量所需的完整网格，加载后请重新取点。' };
  }
}
