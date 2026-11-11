import test from 'node:test';import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{once}from'node:events';
const body="ISO-10303-21;HEADER;ENDSEC;DATA;#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));#2=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#1))REPRESENTATION_CONTEXT('',''));#3=COORDINATES_LIST('',3,((0,0,0),(3,0,0),(0,4,0)));#4=TRIANGULATED_SURFACE_SET('',#3,3,(),(),((1,2,3)));#5=TESSELLATED_SHAPE_REPRESENTATION('Part',(#4),#2);ENDSEC;END-ISO-10303-21;";
test('async assembly loading loads a standalone preview, serves its mesh and supports cancellation',async t=>{
 const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),windowsHide:true,env:{...process.env,XYCAD_HOST:'127.0.0.1',XYCAD_PORT:'0'},stdio:['ignore','pipe','inherit']});t.after(()=>child.kill());
 const [chunk]=await once(child.stdout,'data');const base=chunk.toString().trim().split(/\s+/).at(-1);
 const r=await fetch(base+'api/preview',{method:'POST',headers:{'content-type':'application/octet-stream','x-xycad-format':'stp','x-xycad-assembly':'1',prefer:'respond-async'},body});assert.equal(r.status,202);const {job}=await r.json();
 const url=base+'api/preview-jobs/'+job.id;
 let data;for(let i=0;i<100;i++){const poll=await fetch(url);assert.equal(poll.status,200);data=await poll.json();if(data.status!=='loading')break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(data.status,'ready',data.error);assert.equal(data.scene.mesh.count,1);
 const mesh=base+'api/assembly/'+data.scene.mesh.asset+'/mesh?parts=0';assert.equal((await fetch(mesh)).status,200);
 assert.equal((await fetch(url,{method:'DELETE'})).status,200);assert.equal((await(await fetch(url)).json()).status,'cancelled');
 assert.equal((await fetch(base+'api/preview-jobs/'+crypto.randomUUID())).status,404);
});
