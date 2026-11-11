import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { axes, faceTriangles, worldPoint, projectionArcPoints } from '../src/brep-mesh.mjs';
import { buildMeshScene } from '../src/mesh-scene.mjs';
import { mapTriangle } from '../src/mesh-topology.mjs';
import { buildAssemblyScene, readAssemblyProjection } from '../src/assembly-scene.mjs';
import { buildOrthographic } from '../src/mesh-projection.mjs';
import { projectionLayout, projectionSettings, frontFrames } from '../src/projection-layout.mjs';
import { writeVectorDxf } from '../src/dxf-write.mjs';
import { parseDxf, name, number } from '../src/dxf-parser.mjs';
import { writeProjectionPdf } from '../src/projection-pdf.mjs';
import {projectionHiddenMask} from '../public/cad-limits.mjs';

const ring = (x,z,y=0) => [[-x,y,-z],[x,y,-z],[x,y,z],[-x,y,z]];
function face(rings) { return [...faceTriangles({frame:axes([0,0,0],[0,-1,0],[1,0,0])},rings,1e-6)]; }
function segments(drawing,layer) {
  return drawing.entities.filter(e=>e.layer===layer).flatMap(e=>{
    if(e.type==='LINE')return [[e.a,e.b]];
    if(e.type!=='LWPOLYLINE')return [];
    const v=e.closed?[...e.vertices,e.vertices[0]]:e.vertices;
    return v.slice(1).map((p,i)=>[v[i],p]);
  });
}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`);
const horizontal=(drawing,layer,z=0)=>segments(drawing,layer).filter(([a,b])=>Math.abs(a[1]-z)<1e-5&&Math.abs(b[1]-z)<1e-5).map(([a,b])=>[a[0],b[0]].sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);

test('source planar holes split rear edges, without introducing tessellation lines',()=>{
  const triangles=face([ring(5,3),ring(1,1).reverse()]);
  triangles.push([-4,1,0,4,1,0,4,1,2]);
  const scene=buildMeshScene('test','mm',triangles),copy=JSON.stringify(scene.mesh);
  const drawing=buildOrthographic(scene.mesh);
  const hidden=horizontal(drawing,'FRONT-HIDDEN');
  assert.equal(hidden.length,2);hidden.flat().forEach((v,i)=>close(v,[-4,-1,1,4][i]));
  const visible=horizontal(drawing,'FRONT-VISIBLE');
  assert.equal(visible.length,1);close(visible[0][0],-1);close(visible[0][1],1);
  assert.equal(drawing.diagnostics.sourcePlanarFaces,1);
  assert.equal(JSON.stringify(scene.mesh),copy);
});

test('nonconforming mesh seams disappear but a boundary between different parts remains',()=>{
  const left=[-2,0,-2,0,0,-2,0,0,2],left2=[-2,0,-2,0,0,2,-2,0,2];
  const right=[0,0,-2,2,0,-2,0,0,0],right2=[2,0,-2,2,0,2,0,0,0],right3=[0,0,0,2,0,2,0,0,2];
  const triangles=[left,left2,right,right2,right3];
  const fused=buildOrthographic(buildMeshScene('test','mm',triangles).mesh);
  const interior=d=>segments(d,'FRONT-VISIBLE').filter(([a,b])=>Math.abs(a[0])+Math.abs(b[0])<1e-5);
  assert.equal(interior(fused).length,0);
  const separate=buildOrthographic(buildMeshScene('test','mm',[{label:'left',key:1},left,left2,null,{label:'right',key:2},right,right2,right3,null]).mesh);
  assert.ok(interior(separate).length>0);
  const duplicated=buildOrthographic(buildMeshScene('test','mm',[...triangles,...triangles]).mesh);
  assert.equal(duplicated.diagnostics.duplicateTriangles,5);
  assert.deepEqual(segments(fused,'FRONT-VISIBLE'),segments(duplicated,'FRONT-VISIBLE'));
});

test('native boundaries survive shared rotated/scaled instances and selected-part normalization',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'xycad-projection-test-'));
  try{
    const triangles=face([ring(5,3),ring(1,1).reverse()]);
    const transform=p=>[100+2*p[2],200+2*p[1],300-2*p[0]];
    const scene=buildAssemblyScene([{label:'assembly'},{label:'first',definition:1,geometry:()=>triangles,placement:p=>p},null,{label:'second',definition:1,geometry:()=>triangles,placement:transform},null,null],directory,'STEP','test');
    assert.equal(scene.mesh.uniqueCount,triangles.length);
    const selected=readAssemblyProjection(directory,[0,1]);
    const faces=new WeakMap(),mapped=triangles.map(t=>mapTriangle(t,transform,faces));
    const direct=buildMeshScene('test','mm',mapped);
    // Shared assembly results have the same physical units as the source.
    selected.mesh.unit='mm';
    selected.mesh.size.forEach((v,i)=>close(v,direct.mesh.size[i]));
    const a=buildOrthographic(selected.mesh,'ny'),b=buildOrthographic(direct.mesh,'ny');
    assert.equal(a.diagnostics.sourcePlanarFaces,1);
    assert.equal(a.entities.length,b.entities.length);
    for(const layer of ['FRONT-VISIBLE','FRONT-HIDDEN','TOP-VISIBLE','RIGHT-VISIBLE']){
      const first=segments(a,layer).flat(2),second=segments(b,layer).flat(2);
      assert.equal(first.length,second.length);first.forEach((v,i)=>close(v,second[i]));
    }
    const all=readAssemblyProjection(directory);assert.equal(all.mesh.planarFaces.length,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('continuous closed polylines retain hidden dash continuity in DXF and PDF',()=>{
  const drawing={...buildOrthographic(buildMeshScene('test','mm',face([ring(5,3)])).mesh),entities:[{type:'LWPOLYLINE',layer:'FRONT-HIDDEN',vertices:[[0,0],[1,0],[1,1],[0,1]],closed:true,patternContinuous:true}]};
  const entity=parseDxf(Buffer.from(writeVectorDxf(drawing))).entities[0];
  assert.equal(entity.type,'LWPOLYLINE');assert.equal(number(entity,70),129);assert.equal(name(entity,8),'FRONT-HIDDEN');
  const pdf=Buffer.concat([...writeProjectionPdf(drawing)].map(c=>Buffer.from(c)));
  const start=pdf.indexOf('stream\n')+7,end=pdf.indexOf('\nendstream',start);
  const stream=inflateSync(pdf.subarray(start,end)).toString();
  assert.match(stream,/\[[\d.]+ [\d.]+\] 0 d\n[^\n]+ m (?:[^\n]+ l ){3}h S/);
});

test('first-angle axes, labels and gaps stay aligned for all 24 manual orientations',()=>{
  for(const front of Object.keys(frontFrames))for(const turn of ['0','90','180','270']){
    const l=projectionLayout([5,40,8],front,{turn,gap:2,paper:'a3-portrait'}),[f,t,r]=l.views;
    assert.deepEqual(t.frame,[f.frame[0],-f.frame[2],f.frame[1]]);
    assert.deepEqual(r.frame,[-f.frame[2],f.frame[1],f.frame[0]]);
    assert.equal(f.shift[0],t.shift[0]);assert.equal(f.shift[1],r.shift[1]);
    assert.ok(r.shift[0]+Math.max(r.width,l.labelWidth)/2+2<=-Math.max(f.width,l.labelWidth)/2+1e-10);
    assert.ok(t.shift[1]+t.height/2+2<=f.labelPosition[1]+1e-10);
    assert.equal(l.paper.width,297);assert.equal(l.paper.height,420);
  }
  const old=projectionLayout([20,400,81],'ny'),auto=projectionLayout([20,400,81],'auto');
  assert.equal(auto.area,400*81);assert.ok(auto.scale>old.scale);
});

test('projection preserves declared physical units and unknown original coordinates',()=>{
  for(const [unit,multiplier,units] of [['mm',1,4],['cm',10,4],['in',25.4,4],[null,1,0]]){
    const d=buildOrthographic(buildMeshScene('test',unit,face([ring(5,3)])).mesh);
    const xs=segments(d,'FRONT-VISIBLE').flat(2).filter((v,i)=>i%2===0);
    close(Math.max(...xs)-Math.min(...xs),10*multiplier);assert.equal(d.units,units);
  }
});

test('projection settings reject inherited names, duplicate keys and invalid numerics',()=>{
  for(const s of ['front=__proto__','front=constructor','front=ny&front=py','paper=constructor','turn=45','gap=NaN','gap=Infinity','gap=-1','gap=10001','gap=0x10','gap=%20','seams=2','seams=0&seams=1'])assert.throws(()=>projectionSettings(new URLSearchParams(s)),s);
  assert.deepEqual(projectionSettings(new URLSearchParams('front=auto&gap=1e2')),{front:'auto',turn:'auto',paper:'auto',gap:100,seams:'0'});
});

test('hidden-line choices retain absent-view bits and explicit sidebar changes',()=>{
  const layer=(name,checked)=>({name,checkbox:{checked}});
  assert.equal(projectionHiddenMask([layer('TOP-HIDDEN',false),layer('RIGHT-HIDDEN',false)],0),0);
  assert.equal(projectionHiddenMask([layer('TOP-HIDDEN',true),layer('RIGHT-HIDDEN',false)],0),2);
  assert.equal(projectionHiddenMask([layer('TOP-HIDDEN',false),layer('RIGHT-HIDDEN',false)],7),1);
});

test('coplanar source face partitions cancel across T junctions while component contacts remain',()=>{
  const left=face([[[-2,0,-2],[0,0,-2],[0,0,2],[-2,0,2]]]);
  const right=face([[[0,0,-2],[2,0,-2],[2,0,2],[0,0,2],[0,0,0]]]);
  const draw=t=>buildOrthographic(buildMeshScene('test','mm',t).mesh);
  const interior=d=>segments(d,'FRONT-VISIBLE').filter(([a,b])=>Math.abs(a[0])+Math.abs(b[0])<1e-6);
  assert.equal(interior(draw([...left,...right])).length,0);
  assert.ok(interior(draw([{label:'a',key:1},...left,null,{label:'b',key:2},...right,null])).length>0);
  assert.ok(segments(draw([...left,...left]),'FRONT-VISIBLE').length>0,'duplicate faces do not erase the outer boundary');
});

test('closed circle projection sampling is invariant to seam phase and source frame rotation',()=>{
  const first=axes([3,0,7],[0,1,0],[1,0,0]),other=axes([3,0,7],[0,1,0],[Math.cos(.371),0,Math.sin(.371)]);
  const from=worldPoint(first,7.3,0,0),second=worldPoint(other,7.3*Math.cos(.823),7.3*Math.sin(.823),0);
  const a=projectionArcPoints(first,7.3,7.3,from,from,true,1e-6,true,.008,true);
  const b=projectionArcPoints(other,7.3,7.3,second,second,true,1e-6,true,.008,true);
  assert.equal(a.length,b.length);a.flat().forEach((v,i)=>close(v,b.flat()[i]));
});

function circle(frame,r,h,phase=0,n=48){return Array.from({length:n},(_,i)=>worldPoint(frame,r*Math.cos(phase+2*Math.PI*i/n),r*Math.sin(phase+2*Math.PI*i/n),h));}
function revolution(frame,radius,height,slope=0,projectionRings){
  const rings=[circle(frame,radius,0,.137),circle(frame,radius+slope*height,height,.137).reverse()];
  return [...faceTriangles({frame,radius,slope},rings,1e-6,false,false,projectionRings??rings)];
}

test('analytic cylinder/cone occlusion splits a rear edge at the true silhouette',()=>{
  for(const slope of [0,.5]){
    const frame=axes([0,0,0],[0,0,1],[1,0,0]),triangles=revolution(frame,2,4,slope);
    triangles.push([-5,5,2,5,5,2,5,5,5]);
    const scene=buildMeshScene('test','mm',triangles),drawing=buildOrthographic(scene.mesh),z=2-scene.mesh.origin[2];
    const hidden=horizontal(drawing,'FRONT-HIDDEN',z);assert.equal(hidden.length,1);close(hidden[0][0],-2-2*slope);close(hidden[0][1],2+2*slope);
    const visible=horizontal(drawing,'FRONT-VISIBLE',z);assert.equal(visible.length,2);
    close(visible[0][0],-5);close(visible[0][1],-2-2*slope);close(visible[1][0],2+2*slope);close(visible[1][1],5);
  }
});

test('annular plate retains its hole without ghost hidden rims or gaps in the side outline',()=>{
  const frame=axes([0,0,0],[0,1,0],[1,0,0]),bottom=[circle(frame,12,0),circle(frame,4,0).reverse()];
  const top=[circle(frame,12,2,.39),circle(frame,4,2,.39).reverse()];
  const canonical=h=>[circle(frame,12,h),circle(frame,4,h).reverse()];
  const triangles=[...faceTriangles({frame},bottom,1e-6,false,false,canonical(0)),
    ...faceTriangles({frame:{...frame,origin:[0,2,0]}},top,1e-6,false,false,canonical(2)),
    ...revolution(frame,12,2,0,[circle(frame,12,0),circle(frame,12,2).reverse()]),
    ...revolution(frame,4,2,0,[circle(frame,4,0).reverse(),circle(frame,4,2)])];
  const scene=buildMeshScene('test','mm',triangles),drawing=buildOrthographic(scene.mesh);
  assert.equal(segments(drawing,'FRONT-HIDDEN').length,0);
  const front=drawing.entities.filter(e=>e.layer==='FRONT-VISIBLE');assert.equal(front.length,2);assert(front.every(e=>e.type==='LWPOLYLINE'&&e.closed));
  const side=drawing.entities.filter(e=>e.layer==='TOP-VISIBLE');assert.equal(side.length,1);assert.equal(side[0].closed,true);assert.equal(side[0].vertices.length,4);
});

test('shared reflected and scaled curved faces preserve analytic occlusion and source positions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'xycad-curved-transform-test-'));
  try{
    const frame=axes([0,0,0],[0,0,1],[1,0,0]),triangles=revolution(frame,2,4,.5),move=p=>[10-2*p[0],20+2*p[1],30+2*p[2]];
    buildAssemblyScene([{label:'part',definition:1,geometry:()=>triangles,placement:move},null],directory,'STEP','test');
    const selected=readAssemblyProjection(directory,[0]),faces=new WeakMap(),direct=buildMeshScene('test','mm',triangles.map(t=>mapTriangle(t,move,faces)));
    assert.equal(selected.mesh.curvedFaces.length,1);assert(selected.mesh.curvedFaces[0].surface);
    const a=buildOrthographic(selected.mesh,'ny'),b=buildOrthographic(direct.mesh,'ny');
    for(const layer of ['FRONT-VISIBLE','FRONT-HIDDEN','TOP-VISIBLE','TOP-HIDDEN','RIGHT-VISIBLE','RIGHT-HIDDEN']){
      const first=segments(a,layer).flat(2),second=segments(b,layer).flat(2);assert.equal(first.length,second.length);first.forEach((v,i)=>close(v,second[i]));
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('surface partitions are optional while true silhouettes remain present',()=>{
  const frame=axes([0,0,0],[0,0,1],[1,0,0]),r=2,triangles=[];
  for(const start of [.43,.43+Math.PI]){
    const arc=h=>Array.from({length:25},(_,i)=>worldPoint(frame,r*Math.cos(start+Math.PI*i/24),r*Math.sin(start+Math.PI*i/24),h));
    triangles.push(...faceTriangles({frame,radius:r},[[...arc(0),...arc(4).reverse()]],1e-6));
  }
  const mesh=buildMeshScene('test','mm',triangles).mesh,a=buildOrthographic(mesh),b=buildOrthographic(mesh,'ny',{seams:'1'});
  const inside=d=>segments(d,'FRONT-VISIBLE').filter(([a,b])=>Math.abs(a[0]-b[0])<1e-5&&Math.abs(a[0])<1.99);
  assert.equal(inside(a).length,0);assert(inside(b).length>0);
  assert.equal(a.layout.requested.seams,'0');assert.equal(b.layout.requested.seams,'1');
  for(const d of [a,b]){const xs=segments(d,'FRONT-VISIBLE').flat(2).filter((v,i)=>i%2===0);close(Math.max(...xs)-Math.min(...xs),4);}
});
