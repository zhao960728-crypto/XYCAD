import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';

// A preview job is scoped to the same authenticated owner as its mesh asset.
// It never creates, resumes, or changes a BDYC production task.
class JobResponse extends Writable {
  constructor(){super();this.statusCode=200;this.headersSent=false;this.chunks=[];this.bytes=0;}
  setHeader(){}
  setTimeout(){return this;}
  writeHead(status){this.statusCode=status;this.headersSent=true;return this;}
  _write(chunk,encoding,done){
    this.bytes+=chunk.length;
    if(this.bytes>16*1024*1024)return done(Error('预览状态结果超过容量。'));
    this.chunks.push(Buffer.from(chunk));done();
  }
  result(){return JSON.parse(Buffer.concat(this.chunks).toString('utf8'));}
}

export class PreviewJobs {
  constructor({limit=8,ttl=5*60_000}={}){this.limit=limit;this.ttl=ttl;this.jobs=new Map();}
  expire(){const now=Date.now();for(const [id,job]of this.jobs)if(job.expires<=now){job.response.destroy();this.jobs.delete(id);}}
  get(id,owner){this.expire();const job=this.jobs.get(id);return job?.owner===owner?job:null;}
  create(owner,work,cleanup){
    this.expire();
    if(this.jobs.size>=this.limit){const idle=[...this.jobs].find(([,j])=>j.status!=='loading');if(idle)this.jobs.delete(idle[0]);}
    if(this.jobs.size>=this.limit)throw Error('后台预览队列已满，请稍后重试。');
    const id=randomUUID(),response=new JobResponse(),started=Date.now();
    const job={id,owner,response,status:'loading',stage:'read-geometry',started,expires:started+this.ttl};
    response.on('error',()=>{});this.jobs.set(id,job);
    job.done=Promise.resolve().then(()=>work(response,job)).then(()=>{
      if(job.status==='cancelled')return;
      const result=response.result();
      job.status=response.statusCode===200&&result.scene?'ready':'failed';job.result=result;
      delete job.previewScene;
    }).catch(error=>{if(job.status!=='cancelled'){job.status='failed';job.result={error:error.message};}})
      .finally(async()=>{response.end();try{await cleanup();}catch{job.cleanupFailed=true;}finally{job.expires=Date.now()+this.ttl;}});
    return job;
  }
  cancel(id,owner){const job=this.get(id,owner);if(!job)return false;job.status='cancelled';job.result={error:'载入已取消。'};job.response.destroy();return true;}
  close(){for(const job of this.jobs.values())job.response.destroy();this.jobs.clear();}
}
