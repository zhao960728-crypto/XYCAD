// Preserve source planar-face boundaries through units and assembly transforms.
// The preview triangles stay unchanged; projection can distinguish CAD edges
// from the internal strip boundaries of a non-conforming tessellation.
function normalMapper(mapPoint){
  const o=mapPoint([0,0,0]),basis=[0,1,2].map(i=>mapPoint([0,1,2].map(j=>i===j?1:0)).map((v,j)=>v-o[j]));
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const matrix=[cross(basis[1],basis[2]),cross(basis[2],basis[0]),cross(basis[0],basis[1])];
  return n=>{const v=[0,1,2].map(i=>n.reduce((s,value,j)=>s+value*matrix[j][i],0)),length=Math.hypot(...v);return length?v.map(x=>x/length):[0,0,0];};
}

function mapSurface(surface,mapPoint){
  const o=surface.frame.origin,origin=mapPoint(o);
  return {...surface,frame:{origin,...Object.fromEntries(['x','y','z'].map(axis=>[axis,mapPoint(o.map((v,i)=>v+surface.frame[axis][i])).map((v,i)=>v-origin[i])]))}};
}

export function mapTriangle(triangle, mapPoint, faces = new WeakMap()) {
  const result = [0, 3, 6].flatMap(i => mapPoint(triangle.slice(i, i + 3)));
  for(const kind of ['planarFace','curvedFace']) {
    const source = triangle[kind];
    if(!source)continue;
    if (!faces.has(source)) {
      const mapNormal=source.normals&&normalMapper(mapPoint);
      faces.set(source, { rings: source.rings.map(ring => ring.map(mapPoint)),...(mapNormal&&{normals:source.normals.map(ring=>ring.map(mapNormal))}),...(source.surface&&{surface:mapSurface(source.surface,mapPoint)}) });
    }
    Object.defineProperty(result,kind,{value:faces.get(source)});
  }
  return result;
}

export function collectPlanarFace(faces, triangle, index, kind='planarFace') {
  const source = triangle[kind];
  if (!source) return;
  const last = faces.at(-1);
  if (last?.source === source && last.start + last.count === index) last.count++;
  else faces.push({ source, start: index, count: 1, rings: source.rings,...(source.normals&&{normals:source.normals}),...(source.surface&&{surface:source.surface}) });
}

export function* withCurvedBoundary(triangles,rings) {
  const face={rings};
  for(const triangle of triangles){Object.defineProperty(triangle,'curvedFace',{value:face});yield triangle;}
}

export function mapPlanarFaces(faces, mapPoint, start = 0, count = Infinity) {
  const mapNormal=faces.some(f=>f.normals)&&normalMapper(mapPoint);
  return faces.filter(face => face.start >= start && face.start + face.count <= start + count)
    .map(face => ({ start: face.start - start, count: face.count, rings: face.rings.map(ring => ring.map(mapPoint)),
      ...(face.normals&&{normals:face.normals.map(ring=>ring.map(mapNormal))}),...(face.surface&&{surface:mapSurface(face.surface,mapPoint)}) }));
}
