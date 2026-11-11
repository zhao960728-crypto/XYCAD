import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewJobs } from '../src/preview-jobs.mjs';

test('preview jobs isolate result and cancellation by owner and clean resources once',async()=>{
  const jobs=new PreviewJobs();let cleaned=0;
  const job=jobs.create('alice',async response=>{response.writeHead(200);response.write(JSON.stringify({scene:{mesh:{count:1}}}));},async()=>{cleaned++;});
  assert.equal(jobs.get(job.id,'bob'),null);assert.equal(jobs.cancel(job.id,'bob'),false);
  await job.done;assert.equal(cleaned,1);assert.equal(jobs.get(job.id,'alice').status,'ready');
  assert.deepEqual(job.result,{scene:{mesh:{count:1}}});jobs.close();
});

test('cancelled preview frees its work slot and cannot become a successful result',async()=>{
  const jobs=new PreviewJobs();let cleaned=0;
  const job=jobs.create('alice',response=>new Promise(resolve=>response.once('close',resolve)),async()=>{cleaned++;});
  await Promise.resolve();assert(jobs.cancel(job.id,'alice'));await job.done;
  assert.equal(job.status,'cancelled');assert.equal(cleaned,1);assert.match(job.result.error,/取消/);jobs.close();
});

test('bounded preview queue keeps active jobs and reports worker errors without a scene',async()=>{
  const jobs=new PreviewJobs({limit:1});let release;
  const job=jobs.create('alice',()=>new Promise(resolve=>release=resolve),async()=>{});
  assert.throws(()=>jobs.create('bob',async()=>{},async()=>{}),/队列已满/);
  await Promise.resolve();release();await job.done;assert.equal(job.status,'failed');
  const next=jobs.create('bob',async response=>{response.writeHead(422);response.write(JSON.stringify({error:'缺少保存配置'}));},async()=>{});
  await next.done;assert.equal(next.status,'failed');assert.equal(next.result.error,'缺少保存配置');jobs.close();
});
