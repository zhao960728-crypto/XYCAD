import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { embeddedScope } from '../src/embedded-access.mjs';

test('embedded host requires a secret and isolates assembly meshes and projections by session scope', async t => {
  const token='a'.repeat(64), scopeA='b'.repeat(64), scopeB='c'.repeat(64);
  assert.equal(embeddedScope({'x-xycad-host-token':'汉'.repeat(64),'x-xycad-scope':scopeA},token),null);
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{
    env:{...process.env,XYCAD_HOST:'127.0.0.1',XYCAD_PORT:'0',XYCAD_HOST_TOKEN:token,
      XYCAD_DWG_CONVERTER:'',XYCAD_OPENAI_API_KEY:'',XYCAD_BDYC_ORIGIN:''},
    windowsHide:true,stdio:['ignore','pipe','inherit','ipc']
  });
  t.after(()=>{child.disconnect();});
  const [chunk]=await once(child.stdout,'data');
  const base=/http:\/\/127\.0\.0\.1:\d+\//.exec(String(chunk))[0];
  assert.equal((await fetch(base)).status,403);
  const headers={'x-xycad-host-token':token,'x-xycad-scope':scopeA};
  assert.equal((await fetch(base,{headers})).status,200);
  const body="ISO-10303-21;HEADER;ENDSEC;DATA;#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));#2=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#1))REPRESENTATION_CONTEXT('',''));#3=COORDINATES_LIST('',3,((0,0,0),(3,0,0),(0,4,0)));#4=TRIANGULATED_SURFACE_SET('',#3,3,(),(),((1,2,3)));#5=TESSELLATED_SHAPE_REPRESENTATION('Part',(#4),#2);ENDSEC;END-ISO-10303-21;";
  const response=await fetch(base+'api/preview',{method:'POST',headers:{...headers,
    'content-type':'application/octet-stream','x-xycad-format':'step','x-xycad-assembly':'1'},body});
  const result=await response.json();assert.equal(response.status,200,result.error);
  assert.ok(result.scene.mesh.asset);
  const asset=base+'api/assembly/'+result.scene.mesh.asset;
  for (const resource of ['/mesh?parts=0','/projection?part=0&front=pz&format=dxf']) {
    assert.equal((await fetch(asset+resource,{headers:{...headers,'x-xycad-scope':scopeB}})).status,404);
    assert.equal((await fetch(asset+resource,{headers})).status,200);
  }
});
