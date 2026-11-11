import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {projectionLayout,projectionSettings} from '../src/projection-layout.mjs';
import {addProjectionDimensions,innermostConcentric} from '../src/projection-dimensions.mjs';
import {addProjectionFrame} from '../src/projection-frame.mjs';
import {writeVectorDxf} from '../src/dxf-write.mjs';
import {writeProjectionPdf} from '../src/projection-pdf.mjs';
import {parseDxf,name,number} from '../src/dxf-parser.mjs';

const circle=(x,y,r)=>({type:'LWPOLYLINE',layer:'FRONT-VISIBLE',closed:true,vertices:Array.from({length:96},(_,i)=>[x+r*Math.cos(i*Math.PI/48),y+r*Math.sin(i*Math.PI/48)])});
function sample(size=[100,10,40],metadata={sourceName:'测试零件.step'}){
 const layout=projectionLayout(size,'ny',{metadata});
 const drawing={layout,units:4,entities:[{type:'LWPOLYLINE',layer:'FRONT-VISIBLE',closed:true,vertices:[[-50,-20],[50,-20],[50,20],[-50,20]]},circle(-25,0,6),circle(-25,0,3),circle(25,0,3)]};
 addProjectionDimensions(drawing);addProjectionFrame(drawing,{mesh:{unit:'mm',size}},'');return drawing;
}
test('concentric circles keep only the innermost diameter at each center',()=>{
 const circles=[{center:[0,0],diameter:10},{center:[.00001,0],diameter:4},{center:[0,0],diameter:6},{center:[20,0],diameter:4}];
 assert.deepEqual(innermostConcentric(circles,.001).map(c=>c.diameter),[4,4]);
 const drawing=sample(),dims=drawing.entities.filter(e=>e.kind==='diameter');
 assert.equal(dims.length,2);dims.forEach(d=>assert.ok(Math.abs(d.measurement-6)<1e-8));
 // Each label stays beside its own hole rather than in a remote callout bank.
 dims.forEach(d=>{const center=d.a.map((v,i)=>(v+d.b[i])/2);assert.ok(Math.hypot(...d.textPoint.map((v,i)=>v-center[i]))<15);});
 assert.ok(!drawing.entities.some(e=>e.layer==='DIM'&&e.type!=='DIMENSION'));
});
test('adaptive frame encloses annotations, preserves metadata and does not retain template sample data',()=>{
 const a=sample(),b=sample([1000,100,400],{sourceName:'另一个零件.step',quantity:'12',material:'T2紫铜'});
 assert.ok(b.layout.bounds.right-b.layout.bounds.left>a.layout.bounds.right-a.layout.bounds.left);
 assert.equal(b.layout.frame.metadata.quantity,'12');assert.equal(b.layout.frame.metadata.dimensions,'1000 × 100 × 400 mm');
 const values=a.entities.filter(e=>e.type==='TEXT').map(e=>e.value).join('\n');
 assert.match(values,/待核/);assert.doesNotMatch(values,/A2-260423/);
 for(const e of a.entities.flatMap(e=>e.graphics??e))for(const p of e.vertices??[e.a,e.b].filter(Boolean)){
  const f=a.layout.bounds;assert.ok(p[0]>=f.left-1e-6&&p[0]<=f.right+1e-6&&p[1]>=f.bottom-1e-6&&p[1]<=f.top+1e-6);
 }
});
test('DXF contains native dimensions with editable measurements and a named dimension style',async()=>{
 const drawing=sample(),bytes=writeVectorDxf(drawing),doc=parseDxf(bytes);
 const dims=doc.entities.filter(e=>e.type==='DIMENSION');assert.ok(dims.length>8);
 assert.ok(dims.every(e=>name(e,3)==='XYCAD_DIM'&&name(e,1)==='<>'));
 assert.ok(dims.some(e=>(number(e,70)&7)===3));assert.ok(dims.some(e=>number(e,50)===90));
 const python=process.platform==='win32'?'python':'python3';
 try{execFileSync(python,['-c','import ezdxf'],{stdio:'ignore',windowsHide:true});}catch{return;}
 const folder=await mkdtemp(join(tmpdir(),'xycad-native-dim-'));
 try{
  const file=join(folder,'native.dxf');await writeFile(file,bytes);
  const result=execFileSync(python,['-c',`import ezdxf,sys,json
d=ezdxf.readfile(sys.argv[1]); a=d.audit(); assert not a.errors and not a.fixes
es=list(d.modelspace().query('DIMENSION'))
for e in es: assert abs(e.get_measurement()-e.dxf.actual_measurement)<1e-6
vertical=next(e for e in es if e.dxf.get('angle',0)==90)
before=vertical.get_measurement(); p=vertical.dxf.defpoint3; vertical.dxf.defpoint3=(p.x,p.y+7,p.z)
assert abs(vertical.get_measurement()-before-7)<1e-6
vertical.render(); assert len(d.blocks[vertical.dxf.geometry])>0
assert not d.audit().errors
print(json.dumps({'count':len(es),'editable':True}))`,file],{encoding:'utf8',windowsHide:true});
  assert.equal(JSON.parse(result).editable,true);
 }finally{await rm(folder,{recursive:true,force:true});}
});
test('all orientations include a rigid orthogonal isometric view with no dimension duplication',()=>{
 for(const front of ['ny','py','nx','px','nz','pz'])for(const turn of ['0','90','180','270']){
  const layout=projectionLayout([30,10,20],front,{turn}),iso=layout.views.find(v=>v.layer==='ISO');assert.ok(iso);
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)assert.ok(Math.abs(iso.basis[i].reduce((s,v,k)=>s+v*iso.basis[j][k],0)-(i===j?1:0))<1e-12);
 }
 const d=sample();assert.equal(d.layout.dimensions.views.length,3);
 assert.ok(Buffer.concat(writeProjectionPdf(d)).subarray(0,8).toString().startsWith('%PDF'));
});
test('metadata validation rejects duplicates and control characters',()=>{
 for(const q of ['material=a&material=b','quantity=%00','partName='+ 'x'.repeat(241)])assert.throws(()=>projectionSettings(new URLSearchParams(q)));
});
