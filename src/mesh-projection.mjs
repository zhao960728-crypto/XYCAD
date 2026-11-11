import {mapPlanarFaces} from './mesh-topology.mjs';
import { Buffer } from 'node:buffer';
import { projectionTriangleLimit } from '../public/cad-limits.mjs';
import {projectionLayout} from './projection-layout.mjs';
import {revolutionInView,revolutionHiddenIntervals,revolutionSilhouettes,revolutionModel} from './revolution-projection.mjs';

const weldTolerance = 1e-7;
const depthTolerance = 2e-7;
const crease = Math.cos(25 * Math.PI / 180);
const millimeters = new Map([['µm', 0.001], ['mm', 1], ['cm', 10], ['m', 1000], ['in', 25.4], ['ft', 304.8]]);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const pointKey = point => point.map(value => Math.round(value / weldTolerance)).join(',');
const pairKey = (a, b) => a < b ? a + ':' + b : b + ':' + a;
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

function meshEdges(mesh,showSurfacePartitions=false) {
  const bytes = Buffer.from(mesh.positions, 'base64');
  const vertexIds = new Map(), vertices = [], triangles = [], edges = new Map();
  const parts = new Int32Array(mesh.count);
  const planarIds = new Int32Array(mesh.count).fill(-1);
  const curvedIds = new Int32Array(mesh.count).fill(-1);
  (mesh.planarFaces??[]).forEach((face,i)=>planarIds.fill(i,face.start,face.start+face.count));
  (mesh.curvedFaces??[]).forEach((face,i)=>curvedIds.fill(i,face.start,face.start+face.count));
  const ranges = mesh.partRanges ?? [];
  function partRanges(nodes) {
    for (const node of nodes ?? []) {
      if (node.children) partRanges(node.children);
      else if (node.count) ranges.push({ start: node.start, count: node.count });
    }
  }
  if (!mesh.partRanges) partRanges(mesh.tree);
  ranges.forEach(({ start, count }, i) => parts.fill(i + 1, start, start + count));
  const faces = new Set();
  let duplicates = 0;
  for (let offset = 0; offset < bytes.length; offset += 36) {
    const ids = [0, 12, 24].map(delta => {
      const point = [0, 4, 8].map(axis => bytes.readFloatLE(offset + delta + axis));
      const key = pointKey(point);
      if (!vertexIds.has(key)) {
        vertexIds.set(key, vertices.length);
        vertices.push(point);
      }
      return vertexIds.get(key);
    });
    const [a, b, c] = ids.map(id => vertices[id]);
    const [ux, uy, uz] = b.map((value, i) => value - a[i]);
    const [vx, vy, vz] = c.map((value, i) => value - a[i]);
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(...n);
    if (!length) continue;
    const normal = n.map(value => value / length);
    const owner = parts[offset / 36];
    const faceKey = owner + ':' + [...ids].sort((a, b) => a - b).join(':');
    if (faces.has(faceKey)) { duplicates++; continue; }
    faces.add(faceKey);
    const triangle = { ids, normal, owner, id: triangles.length, planarFace: planarIds[offset/36], curvedFace:curvedIds[offset/36] };
    triangles.push(triangle);
    if(triangle.planarFace>=0)continue;
    for (let i = 0; i < 3; i++) {
      const from = ids[i], to = ids[(i + 1) % 3];
      const key = owner + ':' + pairKey(from, to);
      const edge = edges.get(key);
      if (!edge) edges.set(key, { from, to, normal, owner, triangle });
      else if (edge.other) edge.feature = true;
      else {
        // Orient the adjacent normals consistently even on meshes with mixed winding.
        edge.other = from === edge.from ? normal.map(value => -value) : normal;
        edge.otherTriangle=triangle;
        edge.feature = dot(edge.normal, edge.other) < crease;
      }
    }
  }
  // Match a long boundary edge against several shorter collinear edges.
  // Barycentric clipping alone is ill-conditioned on the very thin slivers
  // produced by CAD-face triangulation, so match these in model coordinates.
  const seams = new Map();
  for (const edge of edges.values()) {
    if (edge.other) continue;
    const a = vertices[edge.from], b = vertices[edge.to];
    const delta = b.map((v, i) => v - a[i]), length = Math.hypot(...delta);
    if (length <= weldTolerance) continue;
    const major = delta.reduce((m, v, i) => Math.abs(v) > Math.abs(delta[m]) ? i : m, 0);
    const direction = delta.map(v => v / length * Math.sign(delta[major]));
    const cross = (u, v) => [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const normalMajor = edge.normal.reduce((m, v, i) => Math.abs(v) > Math.abs(edge.normal[m]) ? i : m, 0);
    const normal = edge.normal.map(v => v * Math.sign(edge.normal[normalMajor]));
    const moment = cross(a, direction);
    const key = edge.owner + ':' + pointKey(direction) + ':' + pointKey(moment) + ':' + pointKey(normal);
    const opposite = vertices[edge.triangle.ids.find(id => id !== edge.from && id !== edge.to)];
    const side = dot(cross(normal, direction), opposite.map((v, i) => v - a[i])) > 0 ? 'positive' : 'negative';
    let group = seams.get(key);
    if (!group) { group = { positive: [], negative: [], edges: [] }; seams.set(key, group); }
    const start = dot(a, direction), end = dot(b, direction);
    group[side].push([Math.min(start, end), Math.max(start, end)]);
    group.edges.push({ edge, start, end, side });
  }
  for (const group of seams.values()) {
    const positive = unionIntervals(group.positive), negative = unionIntervals(group.negative);
    for (const { edge, start, end, side } of group.edges) {
      edge.seams = (side === 'positive' ? negative : positive).map(([lo, hi]) => {
        const a = (lo - start) / (end - start), b = (hi - start) / (end - start);
        return [Math.max(0, Math.min(a,b)), Math.min(1,Math.max(a,b))];
      }).filter(([a,b])=>b>a);
    }
  }
  const planes = (mesh.planarFaces??[]).map((face,id)=>{
    const a=face.rings[0][0];let b=a,n=[0,0,0];
    for(const p of face.rings[0])if(Math.hypot(...p.map((v,i)=>v-a[i]))>Math.hypot(...b.map((v,i)=>v-a[i])))b=p;
    for(const p of face.rings[0]){const candidate=cross(b.map((v,i)=>v-a[i]),p.map((v,i)=>v-a[i]));if(Math.hypot(...candidate)>Math.hypot(...n))n=candidate;}
    const length=Math.hypot(...n);if(!length)throw Error('原模型平面的边界无法确定投影方向。');
    return {rings:face.rings,normal:n.map(v=>v/length),owner:parts[face.start],id};
  });
  const native = new Map(), nativeGroups = new Map(), nativeEdges = [];
  for(const plane of planes)for(const [ringIndex,ring] of plane.rings.entries()){
    const normalMajor=plane.normal.reduce((m,v,i)=>Math.abs(v)>Math.abs(plane.normal[m])?i:m,0);
    const normal=plane.normal.map(v=>v*Math.sign(plane.normal[normalMajor]));
    const area=ring.reduce((sum,p,j)=>sum+dot(normal,cross(p.map((v,i)=>v-ring[0][i]),ring[(j+1)%ring.length].map((v,i)=>v-ring[0][i]))),0);
    for(let i=0;i<ring.length;i++){
    const ids=[ring[i],ring[(i+1)%ring.length]].map(point=>{
      const key=pointKey(point);if(!vertexIds.has(key)){vertexIds.set(key,vertices.length);vertices.push(point);}else vertices[vertexIds.get(key)]=point;return vertexIds.get(key);
    });
    if(ids[0]===ids[1])continue;
    const a=vertices[ids[0]],b=vertices[ids[1]],delta=b.map((v,i)=>v-a[i]),length=Math.hypot(...delta);
    const major=delta.reduce((m,v,i)=>Math.abs(v)>Math.abs(delta[m])?i:m,0);
    const direction=delta.map(v=>v/length*Math.sign(delta[major]));
    // Source faces may meet on the same plane. Their shared trim is a face
    // partition, not a crease. Keep separate component contacts and hole rims.
    const inside=cross(normal,delta).map(v=>v*Math.sign(area)*(ringIndex===0?1:-1));
    const side=dot(inside,cross(normal,direction))>0?'positive':'negative';
    const key=plane.owner+':'+pointKey(direction)+':'+pointKey(cross(a,direction))+':'+pointKey(normal);
    const start=dot(a,direction),end=dot(b,direction);
    const edge={from:ids[0],to:ids[1],normal:plane.normal,owner:plane.owner,explicit:true,feature:true};
    let group=nativeGroups.get(key);
    if(!group){group={positive:[],negative:[],edges:[]};nativeGroups.set(key,group);}
    group[side].push([Math.min(start,end),Math.max(start,end)]);group.edges.push({edge,start,end,side});nativeEdges.push(edge);
    }
  }
  for(const group of nativeGroups.values()){
    const positive=unionIntervals(group.positive),negative=unionIntervals(group.negative);
    for(const {edge,start,end,side} of group.edges)edge.seams=(side==='positive'?negative:positive).map(([lo,hi])=>{
      const a=(lo-start)/(end-start),b=(hi-start)/(end-start);return [Math.max(0,Math.min(a,b)),Math.min(1,Math.max(a,b))];
    }).filter(([a,b])=>b>a);
  }
  for(const edge of nativeEdges){if(showSurfacePartitions)edge.seams=[];const key=edge.owner+':'+pairKey(edge.from,edge.to);if(!native.has(key))native.set(key,edge);}
  const curveTrims=new Map();
  const curveModels=(mesh.curvedFaces??[]).map(face=>face.surface&&revolutionModel(face.surface));
  for(const [faceIndex,face] of (mesh.curvedFaces??[]).entries()){
    if(!face.surface)continue;
    const owner=parts[face.start],trim=new Map();
    for(const [ringIndex,ring] of face.rings.entries())for(let i=0;i<ring.length;i++){
      const ids=[ring[i],ring[(i+1)%ring.length]].map(point=>{
        const key=pointKey(point);if(!vertexIds.has(key)){vertexIds.set(key,vertices.length);vertices.push(point);}else vertices[vertexIds.get(key)]=point;return vertexIds.get(key);
      });
      if(ids[0]===ids[1])continue;const key=owner+':'+pairKey(...ids);
      const normals=face.normals?.[ringIndex];
      const n=normals?normals[i].map((v,k)=>v+normals[(i+1)%ring.length][k]):null,length=n&&Math.hypot(...n);
      const edge=trim.get(key)??{from:ids[0],to:ids[1],normal:length?n.map(v=>v/length):[0,0,0],owner,explicit:true,feature:true,balance:0,faceIndex};
      edge.balance+=ids[0]<ids[1]?1:-1;trim.set(key,edge);
    }
    // Opposite traversals of a periodic seam belong to one smooth face.
    // They close its parameter domain and are not physical trim edges.
    for(const [key,edge] of trim)if(edge.balance){if(!curveTrims.has(key))curveTrims.set(key,[]);curveTrims.get(key).push(edge);}
  }
  for(const [key,group] of curveTrims){
    if(native.has(key)){native.get(key).onSurfaces=new Set(group.map(e=>e.faceIndex));continue;}
    const first=curveModels[group[0].faceIndex];
    const smooth=group.length>1&&first&&group.every(e=>curveModels[e.faceIndex]?.signature.every((v,i)=>Math.abs(v-first.signature[i])<1e-8));
    if(!smooth||showSurfacePartitions){group[0].onSurfaces=new Set(group.map(e=>e.faceIndex));native.set(key,group[0]);}
  }
  for(const edge of native.values()){
    for(const [i,model] of curveModels.entries())if(model&&parts[mesh.curvedFaces[i].start]===edge.owner&&!edge.onSurfaces?.has(i)&&model.ownsEdge(vertices[edge.from],vertices[edge.to],weldTolerance*2)){
      edge.onSurfaces??=new Set();edge.onSurfaces.add(i);
    }
  }
  return { vertices, triangles, edges: [...edges.values(),...native.values()], planes, curves:(mesh.curvedFaces??[]).map(face=>({...face,owner:parts[face.start]})), duplicates };
}

function planeInView(plane,axes,signs){
  const rings=plane.rings.map(ring=>ring.map(p=>axes.map((axis,i)=>p[axis]*signs[i])));
  const normal=axes.map((axis,i)=>plane.normal[axis]*signs[i]);
  if(Math.abs(normal[2])<1e-10)return null;
  const box={lowX:Infinity,lowY:Infinity,highX:-Infinity,highY:-Infinity,highZ:-Infinity};
  for(const ring of rings)for(const p of ring){box.lowX=Math.min(box.lowX,p[0]);box.lowY=Math.min(box.lowY,p[1]);box.highX=Math.max(box.highX,p[0]);box.highY=Math.max(box.highY,p[1]);box.highZ=Math.max(box.highZ,p[2]);}
  const edges=[];
  for(const ring of rings)for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];
    edges.push({a,b,lowX:Math.min(a[0],b[0]),highX:Math.max(a[0],b[0]),lowY:Math.min(a[1],b[1]),highY:Math.max(a[1],b[1]),highZ:0});
  }
  return {...box,planar:true,normal,a:rings[0][0],boundaryIndex:indexTriangles(edges)};
}

function planarHiddenIntervals(face,a,b,work){
  const n=face.normal,origin=face.a;
  const depth=p=>origin[2]-(n[0]*(p[0]-origin[0])+n[1]*(p[1]-origin[1]))/n[2]-p[2]-depthTolerance;
  const da=depth(a),db=depth(b);if(da<=0&&db<=0)return [];
  const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),cuts=[0,1];
  const budget=()=>{if(++work.visits>45_000_000)throw Error('模型遮挡关系超过三视图计算预算，请拆分模型后重试。');};
  const stack=[face.boundaryIndex];
  while(stack.length){
    const node=stack.pop();budget();const box=[0,1];
    if(!clip(box,a[0]-node.lowX,b[0]-node.lowX,true)||!clip(box,node.highX-a[0],node.highX-b[0],true)||!clip(box,a[1]-node.lowY,b[1]-node.lowY,true)||!clip(box,node.highY-a[1],node.highY-b[1],true))continue;
    if(node.children){stack.push(...node.children);continue;}
    for(const edge of node.triangles){
      budget();const p=edge.a,q=edge.b,ex=q[0]-p[0],ey=q[1]-p[1],d=dx*ey-dy*ex;
      if(Math.abs(d)<1e-18)continue;
      const x=p[0]-a[0],y=p[1]-a[1],t=(x*ey-y*ex)/d,u=(x*dy-y*dx)/d;
      if(t>0&&t<1&&u>=-1e-10&&u<=1+1e-10)cuts.push(t);
    }
  }
  cuts.sort((a,b)=>a-b);
  const inside=p=>{
    let filled=false;
    const stack=[face.boundaryIndex];
    while(stack.length){
      const node=stack.pop();budget();if(node.highX<p[0]||node.highY<p[1]||node.lowY>p[1])continue;
      if(node.children){stack.push(...node.children);continue;}
      for(const edge of node.triangles){budget();const u=edge.a,v=edge.b;
        if((u[1]>p[1])!==(v[1]>p[1])&&p[0]<(v[0]-u[0])*(p[1]-u[1])/(v[1]-u[1])+u[0])filled=!filled;
      }
    }return filled;
  };
  const result=[];
  for(let i=1;i<cuts.length;i++){
    const lo=cuts[i-1],hi=cuts[i];if((hi-lo)*length<=weldTolerance)continue;
    const t=(lo+hi)/2;if(!inside([a[0]+dx*t,a[1]+dy*t]))continue;
    const range=[lo,hi];if(clip(range,da,db))result.push(range);
  }
  return result;
}

function triangleInView([a, b, c]) {
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - a[0], vy = c[1] - a[1];
  const area = ux * vy - uy * vx;
  if (Math.abs(area) <= 1e-15) return null;
  return { a, u: [vy / area, -vx / area], v: [-uy / area, ux / area], du: b[2] - a[2], dv: c[2] - a[2],
    lowX: Math.min(a[0], b[0], c[0]), highX: Math.max(a[0], b[0], c[0]),
    lowY: Math.min(a[1], b[1], c[1]), highY: Math.max(a[1], b[1], c[1]), highZ: Math.max(a[2], b[2], c[2]) };
}

function indexTriangles(triangles) {
  if (!triangles.length) return null;
  const node = { lowX: Infinity, lowY: Infinity, highX: -Infinity, highY: -Infinity, highZ: -Infinity };
  for (const tri of triangles) {
    node.lowX = Math.min(node.lowX, tri.lowX);
    node.lowY = Math.min(node.lowY, tri.lowY);
    node.highX = Math.max(node.highX, tri.highX);
    node.highY = Math.max(node.highY, tri.highY);
    node.highZ = Math.max(node.highZ, tri.highZ);
  }
  if (triangles.length <= 16) {
    node.triangles = triangles;
  } else {
    const center = node.highX - node.lowX >= node.highY - node.lowY ? tri => tri.lowX + tri.highX : tri => tri.lowY + tri.highY;
    triangles.sort((a, b) => center(a) - center(b));
    const middle = triangles.length >>> 1;
    node.children = [indexTriangles(triangles.slice(0, middle)), indexTriangles(triangles.slice(middle))];
  }
  return node;
}

function clip(interval, a, b, includePoint = false) {
  if (a < 0 && b < 0) return false;
  if (a < 0) interval[0] = Math.max(interval[0], a / (a - b));
  if (b < 0) interval[1] = Math.min(interval[1], a / (a - b));
  return includePoint ? interval[0] <= interval[1] : interval[0] < interval[1];
}

function hiddenIntervals(index, start, end, work, boundary, onSurfaces) {
  const found = [], seams = [];
  const lowZ = Math.min(start[2], end[2]) + (boundary ? -depthTolerance * 2 : depthTolerance);
  const lowX = Math.min(start[0], end[0]), highX = Math.max(start[0], end[0]);
  const lowY = Math.min(start[1], end[1]), highY = Math.max(start[1], end[1]);
  const stack = index ? [index] : [];
  function overlaps(box) {
    if (box.highZ <= lowZ || highX < box.lowX || lowX > box.highX || highY < box.lowY || lowY > box.highY) return false;
    const interval = [0, 1];
    return clip(interval, start[0] - box.lowX, end[0] - box.lowX) &&
      clip(interval, box.highX - start[0], box.highX - end[0]) &&
      clip(interval, start[1] - box.lowY, end[1] - box.lowY) &&
      clip(interval, box.highY - start[1], box.highY - end[1]);
  }
  while (stack.length) {
    if (++work.visits > 45_000_000) throw new Error('模型遮挡关系超过三视图计算预算，请拆分模型后重试。');
    const node = stack.pop();
    if (!overlaps(node)) continue;
    if (node.children) {
      stack.push(...node.children);
      continue;
    }
    for (const tri of node.triangles) {
      if (!overlaps(tri)) continue;
      if(tri.planar){found.push(...planarHiddenIntervals(tri,start,end,work));continue;}
      if(tri.revolution){found.push(...revolutionHiddenIntervals(tri,start,end,work,depthTolerance,onSurfaces?.has(tri.faceIndex)));continue;}
      const coords = ([x, y]) => [
        (x - tri.a[0]) * tri.u[0] + (y - tri.a[1]) * tri.u[1],
        (x - tri.a[0]) * tri.v[0] + (y - tri.a[1]) * tri.v[1],
      ];
      const [u0, v0] = coords(start), [u1, v1] = coords(end);
      const interval = [0, 1], tolerance = 1e-8;
      if (!clip(interval, u0 + tolerance, u1 + tolerance) || !clip(interval, v0 + tolerance, v1 + tolerance) ||
          !clip(interval, 1 - u0 - v0 + tolerance, 1 - u1 - v1 + tolerance)) continue;
      // A tessellated face can have T junctions: one triangle uses a long
      // edge and its neighbours use several short edges. These are interior
      // seams, not holes. Remove only intervals covered on the other side
      // by a coplanar triangle of the SAME part, never an adjacent component.
      if (boundary && tri.owner === boundary.owner && tri.id !== boundary.id &&
          Math.abs(dot(tri.normal, boundary.normal)) > 1 - 1e-6 &&
          tri.points.every(p => Math.abs(dot(boundary.normal, p.map((v, i) => v - start[i]))) <= depthTolerance * 2)) {
        const side = p => (end[0] - start[0]) * (p[1] - start[1]) - (end[1] - start[1]) * (p[0] - start[0]);
        const own = side(boundary.opposite);
        if (tri.points.some(p => side(p) * Math.sign(own) < -weldTolerance * Math.hypot(end[0] - start[0], end[1] - start[1]))) seams.push([...interval]);
      }
      const depth = tri.a[2] - depthTolerance;
      if (clip(interval, depth + u0 * tri.du + v0 * tri.dv - start[2], depth + u1 * tri.du + v1 * tri.dv - end[2])) found.push(interval);
    }
  }
  return { hidden: unionIntervals(found), seams: unionIntervals(seams) };
}

function subtractIntervals(intervals, removed) {
  const result = [];
  for (const [start, end] of intervals) {
    let cursor = start;
    for (const [low, high] of removed) {
      if (high <= cursor) continue;
      if (low >= end) break;
      if (low > cursor) result.push([cursor, Math.min(low, end)]);
      cursor = Math.max(cursor, high);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

function unionIntervals(intervals) {
  const result = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && interval[0] - last[1] <= weldTolerance) last[1] = Math.max(last[1], interval[1]);
    else result.push(interval);
  }
  return result;
}

function* coalesceLines(lines) {
  const groups = new Map();
  for (const { a, b, hidden } of lines) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const sign = (Math.abs(dx) >= Math.abs(dy) ? dx : dy) < 0 ? -1 : 1;
    const x = sign * dx / length, y = sign * dy / length;
    const offset = a[1] * x - a[0] * y;
    const key = pointKey([x, y, offset]);
    let group = groups.get(key);
    if (!group) {
      group = { x, y, offset, visible: [], hidden: [] };
      groups.set(key, group);
    }
    const distance = point => point[0] * group.x + point[1] * group.y;
    const start = distance(a), end = distance(b);
    group[hidden ? 'hidden' : 'visible'].push([Math.min(start, end), Math.max(start, end)]);
  }
  for (const { x, y, offset, visible, hidden } of groups.values()) {
    const point = length => [length * x - offset * y, length * y + offset * x];
    const solid = unionIntervals(visible);
    for (const [start, end] of solid) yield { a: point(start), b: point(end), hidden: false };
    let cursor = 0;
    for (const [start, end] of unionIntervals(hidden)) {
      let from = start;
      while (cursor < solid.length && solid[cursor][1] <= from + weldTolerance) cursor++;
      for (let i = cursor; i < solid.length && solid[i][0] < end; i++) {
        const [low, high] = solid[i];
        if (low - from > weldTolerance) yield { a: point(from), b: point(low), hidden: true };
        from = Math.max(from, high);
      }
      if (end - from > weldTolerance) yield { a: point(from), b: point(end), hidden: true };
    }
  }
}

function weldLines(lines) {
  const points=[],buckets=new Map(),unique=new Map();
  function node(p){
    const q=p.map(v=>Math.floor(v/weldTolerance));
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(const id of buckets.get((q[0]+x)+','+(q[1]+y))??[])
      if(Math.hypot(points[id][0]-p[0],points[id][1]-p[1])<=weldTolerance)return id;
    const id=points.length,key=q.join(',');points.push(p);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(id);return id;
  }
  // Give the actual visible contour ownership of a coincident hidden edge,
  // including float32 mesh / float64 source-boundary round-off differences.
  for(const line of [...lines].sort((a,b)=>Number(a.hidden)-Number(b.hidden)||Number(b.native)-Number(a.native))){
    const a=node(line.a),b=node(line.b);if(a===b)continue;const key=pairKey(a,b);
    if(!unique.has(key))unique.set(key,{a:points[a],b:points[b],hidden:line.hidden});
  }
  return unique.values();
}

function stitchLines(lines) {
  const result=[];
  for(const hidden of [true,false]){
    const nodes=[],buckets=new Map(),edges=[],keys=new Set();
    function node(point){
      const q=point.map(v=>Math.floor(v/weldTolerance));
      for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++){
        for(const id of buckets.get((q[0]+x)+','+(q[1]+y))??[])if(Math.hypot(...nodes[id].point.map((v,i)=>v-point[i]))<=weldTolerance)return id;
      }
      const id=nodes.length,key=q.join(',');nodes.push({point,edges:[]});if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(id);return id;
    }
    for(const line of lines){
      if(line.hidden!==hidden)continue;const a=node(line.a),b=node(line.b);if(a===b)continue;
      const key=pairKey(a,b);if(keys.has(key))continue;keys.add(key);
      const id=edges.length;edges.push({a,b,used:false});nodes[a].edges.push(id);nodes[b].edges.push(id);
    }
    function walk(start,first){
      const vertices=[nodes[start].point];let current=start,index=first;
      for(;;){const edge=edges[index];if(edge.used)break;edge.used=true;current=edge.a===current?edge.b:edge.a;vertices.push(nodes[current].point);
        if(current===start||nodes[current].edges.length!==2)break;
        index=nodes[current].edges.find(i=>!edges[i].used);if(index===undefined)break;
      }
      const closed=current===start;if(closed)vertices.pop();
      result.push({vertices,closed,hidden});
    }
    for(let i=0;i<nodes.length;i++)if(nodes[i].edges.length!==2)for(const edge of nodes[i].edges)if(!edges[edge].used)walk(i,edge);
    for(let i=0;i<edges.length;i++)if(!edges[i].used)walk(edges[i].a,i);
  }
  return result;
}

function viewLines(mesh, view, work) {
  const { axes, signs } = view;
  const points = mesh.vertices.map(point => axes.map((axis, i) => point[axis] * signs[i]));
  const analytic=new Map();
  for(const [i,face] of mesh.curves.entries())if(face.surface){const primitive=revolutionInView(face,axes,signs,indexTriangles);if(primitive)analytic.set(i,{...primitive,faceIndex:i});}
  const triangles = mesh.triangles.filter(triangle=>triangle.planarFace<0&&!analytic.has(triangle.curvedFace)).map(triangle => {
    const vertices = triangle.ids.map(id => points[id]), projected = triangleInView(vertices);
    return projected && { ...projected, points: vertices, id: triangle.id, owner: triangle.owner,
      normal: axes.map((axis, i) => triangle.normal[axis] * signs[i]) };
  }).filter(Boolean);
  triangles.push(...mesh.planes.map(plane=>planeInView(plane,axes,signs)).filter(Boolean));
  triangles.push(...analytic.values());
  const index = indexTriangles(triangles), lines = new Map();
  const tangentFaces=new Set(mesh.curves.flatMap((face,i)=>face.normals&&face.normals.every(ring=>ring.every(n=>Math.abs(n[axes[2]])<1e-9))?[i]:[]));
  const generated=[];
  for(const [i,face] of analytic)for(const projected of revolutionSilhouettes(face,work))generated.push({projected,normal:[0,0,0],owner:mesh.curves[i].owner,explicit:true,feature:true,onSurfaces:new Set([i])});
  for (const edge of [...mesh.edges,...generated]) {
    if(!edge.explicit&&analytic.has(edge.triangle.curvedFace)&&!edge.otherTriangle)continue;
    if(!edge.explicit&&edge.otherTriangle&&edge.triangle.curvedFace===edge.otherTriangle.curvedFace&&analytic.has(edge.triangle.curvedFace))continue;
    if (edge.seams?.some(([a,b])=>a===0&&b===1)) { work.seams++; continue; }
    const coplanar = edge.other && dot(edge.normal, edge.other) > 1 - 1e-8;
    const tangent=edge.otherTriangle&&(edge.triangle.curvedFace===edge.otherTriangle.curvedFace&&tangentFaces.has(edge.triangle.curvedFace)||analytic.has(edge.triangle.curvedFace)&&analytic.has(edge.otherTriangle.curvedFace));
    const silhouette = edge.other && !coplanar && !tangent && (edge.normal[axes[2]] * signs[2] > 1e-8) !== (edge.other[axes[2]] * signs[2] > 1e-8);
    if (edge.other && !edge.feature && !silhouette) continue;
    const [a,b] = edge.projected??[points[edge.from],points[edge.to]];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const span = Math.hypot(dx, dy);
    if (span <= weldTolerance) continue;
    function append(start, end, hidden) {
      if ((end - start) * span <= weldTolerance) return;
      const from = [a[0] + start * dx, a[1] + start * dy];
      const to = [a[0] + end * dx, a[1] + end * dy];
      const key = pairKey(pointKey(from), pointKey(to));
      if (!lines.has(key) || !hidden) lines.set(key, { a: from, b: to, hidden, native:edge.explicit??false });
      if (lines.size > 100_000) throw new Error('三视图线条超过单视图预算，请拆分模型后重试。');
    }
    const boundary = !edge.other && !edge.explicit ? { owner: edge.owner, id: edge.triangle.id,
      normal: axes.map((axis, i) => edge.normal[axis] * signs[i]),
      opposite: points[edge.triangle.ids.find(id => id !== edge.from && id !== edge.to)] } : null;
    const onSurfaces=edge.onSurfaces??(!edge.explicit&&edge.triangle.curvedFace>=0?new Set([edge.triangle.curvedFace]):undefined);
    const { hidden, seams: projectedSeams } = hiddenIntervals(index, a, b, work, boundary,onSurfaces);
    const seams = unionIntervals([...(edge.seams ?? []), ...projectedSeams]);
    work.seams += seams.length;
    const visible = subtractIntervals([[0, 1]], unionIntervals([...hidden, ...seams]));
    for (const [start, end] of visible) append(start, end, false);
    for (const [start, end] of subtractIntervals(hidden, seams)) append(start, end, true);
  }
  return coalesceLines(weldLines(lines.values()));
}

export function buildOrthographic(mesh, front = 'ny', options = {}) {
  if (mesh.count > projectionTriangleLimit) throw new Error('三视图目前支持 20 万个三角面以内的模型，请拆分模型后重试。');
  const scale = Math.max(...mesh.size);
  const unitScale = millimeters.get(mesh.unit);
  const span = scale * (unitScale ?? 1);
  const layout=projectionLayout(mesh.size.map(v=>v*(unitScale??1)),front,options);
  const viewAxes=layout.views.map(view=>({...view,axes:view.frame.map(a=>Math.abs(a)-1),signs:view.frame.map(Math.sign)}));
  const work = { visits: 0, seams: 0 };
  const entities = [];
  const model = meshEdges(mesh,layout.requested.seams==='1');
  for (const [i, view] of viewAxes.entries()) {
    const [sx, sy] = view.shift;
    const point = ([u, v]) => [u * span + sx, v * span + sy];
    let projectedModel=model;
    if(view.basis){
      const rotate=p=>view.basis.map(row=>row.reduce((sum,v,i)=>sum+v*p[i],0));
      const bytes=Buffer.from(mesh.positions,'base64'),rotated=Buffer.allocUnsafe(bytes.length);
      for(let o=0;o<bytes.length;o+=12){const q=rotate([0,4,8].map(i=>bytes.readFloatLE(o+i)));q.forEach((v,i)=>rotated.writeFloatLE(v,o+i*4));}
      projectedModel=meshEdges({...mesh,positions:rotated.toString('base64'),planarFaces:mapPlanarFaces(mesh.planarFaces??[],rotate),curvedFaces:mapPlanarFaces(mesh.curvedFaces??[],rotate)},layout.requested.seams==='1');
    }
    const lines = [...viewLines(projectedModel, view, work)].filter(line=>!view.basis||!line.hidden);
    for (const { vertices, closed, hidden } of stitchLines(lines)) {
      const layer=view.layer+(hidden?'-HIDDEN':'-VISIBLE');
      if(vertices.length===2&&!closed)entities.push({type:'LINE',layer,a:point(vertices[0]),b:point(vertices[1])});
      else entities.push({type:'LWPOLYLINE',layer,vertices:vertices.map(point),closed,patternContinuous:true});
    }
    entities.push({ type: 'TEXT', layer: 'VIEW-LABELS', value: view.label, height: layout.labelHeight, angle: 0, width: 1,
      a: view.labelPosition });
  }
  if (entities.length > 180_000) throw new Error('三视图线条超过导出预算，请拆分模型后重试。');
  if (!entities.some(entity => entity.type === 'LINE' || entity.type === 'LWPOLYLINE')) throw new Error('模型精度不足，无法生成三视图线条。');
  return { entities, units: unitScale ? 4 : 0, hiddenDash: span * 0.008,layout,
    diagnostics: { suppressedSeamIntervals: work.seams, duplicateTriangles: model.duplicates, sourcePlanarFaces:model.planes.length,
      sourceCurvedFaces:model.curves.length,analyticRevolutionFaces:model.curves.filter(f=>f.surface).length,
      meshCurvedFaces:model.curves.filter(f=>!f.surface).length,
      boundaryChordTargetMm:unitScale?Math.max(0,...model.curves.filter(f=>f.surface).map(({surface:f})=>(f.chord??0)*span*Math.max(...['x','y','z'].map(k=>Math.hypot(...f.frame[k]))))):null } };
}
