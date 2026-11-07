import { AssemblyViewer } from './assembly-viewer.mjs';
import { pickMeshPoint } from './cad-measure.mjs';

const vertexShader = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 partTint;
layout(location = 2) in vec3 partOffset;
layout(location = 3) in vec3 partX;
layout(location = 4) in vec3 partY;
layout(location = 5) in vec3 partZ;
layout(location = 6) in vec3 partTranslation;
uniform bool sharedMesh;
uniform vec3 rightAxis;
uniform vec3 upAxis;
uniform vec3 eyeAxis;
uniform vec2 scale;
uniform vec2 offset;
uniform float spread;
uniform float depthScale;
out vec3 viewPosition;
flat out vec3 baseColor;
void main() {
  vec3 placed = sharedMesh ? mat3(partX, partY, partZ) * position + partTranslation : position;
  vec3 displaced = placed + partOffset * spread;
  viewPosition = vec3(dot(rightAxis, displaced), dot(upAxis, displaced), dot(eyeAxis, displaced));
  gl_Position = vec4(viewPosition.xy * scale + offset, -viewPosition.z * depthScale, 1.0);
  baseColor = partTint;
}`;

const fragmentShader = `#version 300 es
precision highp float;
in vec3 viewPosition;
flat in vec3 baseColor;
out vec4 color;
void main() {
  vec3 normal = normalize(cross(dFdx(viewPosition), dFdy(viewPosition)));
  vec3 light = normalize(vec3(-0.35, 0.55, 0.8));
  float shade = 0.39 + 0.61 * max(0.0, dot(normal, light));
  color = vec4(baseColor * shade, 1.0);
}`;

const palette = [[103, 214, 202], [244, 183, 99], [136, 182, 255], [230, 141, 175], [170, 209, 112],
  [177, 151, 249], [246, 143, 103], [126, 211, 249], [237, 222, 113], [109, 209, 161]];
const appearanceStride = 10;

export function partColor(index) {
  if (index < palette.length) return palette[index];
  const hue = ((index * 137.507764) % 360) / 60;
  const light = index % 2 ? 0.73 : 0.62;
  const chroma = (1 - Math.abs(2 * light - 1)) * 0.61;
  return [0, 4, 2].map(offset => {
    const channel = (hue + offset) % 6;
    return Math.round(255 * (light + chroma * (Math.max(0, Math.min(channel, 4 - channel, 1)) - 0.5)));
  });
}

function partOffsets(tree) {
  const parts = [];
  let radius = 0;
  function visit(nodes, center, span, parentOffset) {
    nodes = nodes.filter(node => node.count);
    nodes.forEach((node, index) => {
      const delta = node.center.map((value, i) => value - center[i]);
      const distance = Math.hypot(...delta);
      let direction = delta;
      if (distance <= 0.025 * span) {
        // Coaxial bodies still separate. Use different directions for siblings with the same center.
        const z = 1 - 2 * (index + 0.5) / nodes.length;
        const angle = index * 2.39996323;
        const planar = Math.sqrt(1 - z * z);
        direction = [planar * Math.cos(angle), planar * Math.sin(angle), z];
      }
      const motion = nodes.length > 1 ? 0.38 * span / Math.hypot(...direction) : 0;
      const offset = parentOffset.map((value, i) => value + motion * direction[i]);
      if (node.children) visit(node.children, node.center, node.span, offset);
      else {
        radius = Math.max(radius, Math.hypot(...offset));
        parts.push({ node, offset });
      }
    });
  }
  visit(tree, [0, 0, 0], 1, [0, 0, 0]);
  return { parts, radius };
}

function appearanceFor(tree, count, positions) {
  const { parts, radius } = partOffsets(tree);
  const magnitude = Math.max(radius, 1);
  const expandedHalfSize = [0, 0, 0];
  const bytes = new Uint8Array(count * 3 * appearanceStride);
  const words = new Int16Array(bytes.buffer);
  for (const { node, offset } of parts) {
    const color = partColor(node.color);
    const [x, y, z] = offset.map(value => Math.round(value / magnitude * 32767));
    const end = (node.start + node.count) * 3 * appearanceStride;
    let p = node.start * 9;
    for (let i = node.start * 3 * appearanceStride; i < end; i += appearanceStride, p += 3) {
      const w = i / 2;
      words[w] = x;
      words[w + 1] = y;
      words[w + 2] = z;
      bytes[i + 6] = color[0];
      bytes[i + 7] = color[1];
      bytes[i + 8] = color[2];
      for (let axis = 0; axis < 3; axis++) {
        expandedHalfSize[axis] = Math.max(expandedHalfSize[axis], Math.abs(positions[p + axis] + offset[axis]));
      }
    }
  }
  return { bytes, stride: appearanceStride, magnitude, expandedHalfSize, radius };
}

const views = {
  iso: [-Math.PI / 4, Math.atan(Math.SQRT1_2)],
  front: [-Math.PI / 2, 0],
  right: [0, 0],
  top: [-Math.PI / 2, Math.PI / 2],
};

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  throw new Error('浏览器无法初始化三维着色器。');
}

export class MeshViewer {
  constructor(canvas, onError, onDraw, onProgress) {
    this.canvas = canvas;
    this.onDraw = onDraw;
    this.onProgress = onProgress;
    this.gl = canvas.getContext('webgl2', { alpha: true, antialias: true, depth: true });
    if (!this.gl) throw new Error('当前浏览器无法使用 WebGL 2，请检查浏览器的图形加速设置。');
    this.initialize();
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (this.mesh) onError('三维渲染暂时中断，正在等待浏览器恢复图形上下文。');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      try {
        this.initialize();
        if (this.mesh) {
          if (this.assembly) this.assembly.restore();
          else this.buffers = this.uploadMesh(this.mesh.positions, this.mesh.appearance.bytes);
          this.drawSoon();
          onError('');
        }
      } catch (error) {
        if (this.mesh) onError(error.message);
      }
    });
  }

  initialize() {
    const gl = this.gl;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexShader], [gl.FRAGMENT_SHADER, fragmentShader]]) {
      const shader = compile(gl, type, source);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      throw new Error('浏览器无法初始化三维预览。');
    }
    gl.useProgram(program);
    this.uniforms = Object.fromEntries(['rightAxis', 'upAxis', 'eyeAxis', 'scale', 'offset', 'spread', 'depthScale', 'sharedMesh']
      .map(name => [name, gl.getUniformLocation(program, name)]));
    gl.enable(gl.DEPTH_TEST);
    this.buffers = [];
  }

  upload(positions) {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('浏览器的三维图形上下文暂不可用。');
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('浏览器无法分配三维网格缓冲区。');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteBuffer(buffer);
      throw new Error('浏览器无法加载此三维网格。');
    }
    return buffer;
  }

  uploadMesh(positions, appearance) {
    const position = this.upload(positions);
    try { return [position, this.upload(appearance)]; }
    catch (error) { this.gl.deleteBuffer(position); throw error; }
  }

  load(mesh, resume = false) {
    if (mesh.asset) {
      const { parts, radius } = partOffsets(mesh.tree);
      const span = Math.max(...mesh.size);
      const halfSize = mesh.size.map(length => length / span / 2);
      const expandedHalfSize = [...halfSize];
      for (const part of parts) {
        part.color = partColor(part.node.color).map(value => value / 255);
        for (let i = 0; i < 3; i++) expandedHalfSize[i] = Math.max(expandedHalfSize[i],
          Math.abs(part.node.center[i] + part.offset[i]) + part.node.half[i]);
      }
      const assembly = new AssemblyViewer(mesh, parts, this, this.onProgress);
      this.clear();
      this.assembly = assembly;
      this.mesh = { halfSize, appearance: { magnitude: 1, expandedHalfSize, radius } };
      if (!resume) {
        this.explosion = 0;
        this.setView('iso');
      }
      return mesh.tree;
    }
    const decoded = atob(mesh.positions);
    if (decoded.length !== mesh.count * 36) throw new Error('预览服务返回的网格数据不完整。');
    const positions = new Float32Array(decoded.length / 4);
    const view = new DataView(positions.buffer);
    for (let i = 0; i < decoded.length; i++) view.setUint8(i, decoded.charCodeAt(i));
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
      for (let i = 0; i < positions.length; i++) positions[i] = view.getFloat32(i * 4, true);
    }
    const tree = mesh.tree ?? [{ label: '网格', start: 0, count: mesh.count, color: 0, center: [0, 0, 0], span: 1 }];
    const appearance = appearanceFor(tree, mesh.count, positions);
    const buffers = this.uploadMesh(positions, appearance.bytes);
    this.clear();
    this.buffers = buffers;
    const span = Math.max(...mesh.size);
    this.mesh = { positions, appearance, halfSize: mesh.size.map(length => length / span / 2) };
    this.ranges = [[0, mesh.count]];
    if (!resume) {
      this.explosion = 0;
      this.setView('iso');
    }
    return tree;
  }

  clear() {
    this.assembly?.clear();
    this.assembly = null;
    for (const buffer of this.buffers) this.gl.deleteBuffer(buffer);
    this.buffers = [];
    this.mesh = null;
  }

  setExplosion(value) {
    this.explosion = value;
    this.drawSoon();
  }

  setVisible(ranges) {
    this.ranges = ranges;
    this.assembly?.setVisible(ranges);
    this.drawSoon();
  }

  pick(camera, screen, snapRadius) {
    return this.assembly ? this.assembly.pick(camera, screen, snapRadius)
      : pickMeshPoint(this.mesh, this.ranges, camera, screen, snapRadius);
  }

  setView(name) {
    [this.yaw, this.pitch] = views[name];
    this.fit();
  }

  fit() {
    this.magnification = 1;
    this.offset = [0, 0];
    this.fitAxes = null;
    this.drawSoon();
  }

  zoom(factor, x, y) {
    const next = Math.max(0.08, Math.min(300, this.magnification / factor));
    const ratio = next / this.magnification;
    const pivot = [2 * x - 1, 1 - 2 * y];
    this.offset = this.offset.map((value, i) => pivot[i] + (value - pivot[i]) * ratio);
    this.magnification = next;
    this.drawSoon();
  }

  drag(dx, dy, pan) {
    if (pan) {
      this.offset[0] += 2 * dx / this.canvas.clientWidth;
      this.offset[1] -= 2 * dy / this.canvas.clientHeight;
    } else {
      this.yaw -= dx * 0.009;
      this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + dy * 0.009));
    }
    this.drawSoon();
  }

  drawSoon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  camera() {
    const { canvas, mesh } = this;
    if (!mesh || !canvas.clientWidth || !canvas.clientHeight) return null;
    const density = Math.min(devicePixelRatio, 2);
    const pixelWidth = Math.round(canvas.clientWidth * density), pixelHeight = Math.round(canvas.clientHeight * density);
    const { width, height } = canvas.getBoundingClientRect();
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    const right = [-sy, cy, 0], up = [-sp * cy, -sp * sy, cp];
    const aspect = pixelWidth / pixelHeight;
    const aspectX = Math.max(1, aspect), aspectY = Math.max(1, 1 / aspect);
    this.fitAxes ??= [right, up];
    const { magnitude, expandedHalfSize, radius } = mesh.appearance;
    const halfSize = mesh.halfSize.map((value, i) => value + (expandedHalfSize[i] - value) * this.explosion);
    const [extentX, extentY] = this.fitAxes.map(axis => axis.reduce((sum, value, i) =>
      sum + Math.abs(value) * halfSize[i], 0));
    const scale = this.magnification / (1.12 * Math.max(extentX / aspectX, extentY / aspectY));
    return { pixelWidth, pixelHeight, width, height, right, up, eye: [cp * cy, cp * sy, sp],
      scale: [scale / aspectX, scale / aspectY], offset: this.offset, spread: this.explosion * magnitude,
      depthScale: 1 / (1 + this.explosion * radius) };
  }

  draw() {
    const { canvas, gl, uniforms } = this;
    if ((!this.buffers.length && !this.assembly) || gl.isContextLost()) return;
    const camera = this.camera();
    if (!camera) return;
    if (canvas.width !== camera.pixelWidth || canvas.height !== camera.pixelHeight) {
      canvas.width = camera.pixelWidth;
      canvas.height = camera.pixelHeight;
    }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform3f(uniforms.rightAxis, ...camera.right);
    gl.uniform3f(uniforms.upAxis, ...camera.up);
    gl.uniform3f(uniforms.eyeAxis, ...camera.eye);
    gl.uniform2f(uniforms.scale, ...camera.scale);
    gl.uniform2f(uniforms.offset, ...camera.offset);
    gl.uniform1f(uniforms.spread, camera.spread);
    gl.uniform1f(uniforms.depthScale, camera.depthScale);
    if (this.assembly) {
      this.assembly.draw(camera, uniforms);
      this.onDraw?.(camera);
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[0]);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[1]);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.UNSIGNED_BYTE, true, appearanceStride, 6);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.SHORT, true, appearanceStride, 0);
    for (const [start, count] of this.ranges) gl.drawArrays(gl.TRIANGLES, start * 3, count * 3);
    this.onDraw?.(camera);
  }
}
