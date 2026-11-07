// Optional BDYC workflow handoff. Previewing never saves a file or starts a job.
export function createHostTools() {
  const panel=document.getElementById('host-tools'), status=document.getElementById('host-status');
  let enabled=false, current, latestExport, busy=false;
  const actions=[...panel.querySelectorAll('button')];
  function sync() { panel.hidden=!enabled; actions.forEach(b=>{b.disabled=busy||!current||(b.dataset.hostAction==='save-export'&&!latestExport);}); }
  async function request(url, body, binary=false) {
    const response=await fetch(url,{method:'POST',headers:{'content-type':binary?'application/octet-stream':'application/json'},
      body:binary?body:JSON.stringify(body),cache:'no-store'});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(data.error||'保存未完成，请检查登录状态后重试');
    return data;
  }
  async function save(entry) {
    if(entry.context?.path)return entry.context.path;
    entry.requestId??=crypto.randomUUID();
    const origin=entry.context?.source;
    const proof=origin?(entry.proof??=new File([JSON.stringify({origin,name:entry.file.name,capturedAt:entry.capturedAt,
      note:'原图或导出结果的独立副本，内容哈希见同批图纸记录；不改变原任务版本或审查状态。'},null,2)],entry.file.name+'.来源.json',{type:'application/json'})):null;
    const files=[entry.file,...(proof?[proof]:[])];
    const batch=await request('/api/preview-uploads',{requestId:entry.requestId,
      files:files.map(file=>({name:file.name,size:file.size,lastModified:file.lastModified}))});
    if(batch.status==='complete')return entry.context={path:batch.files[0].path},entry.context.path;
    for(let i=0;i<files.length;i++){
      const file=files[i],item=batch.files[i];
      for(let offset=item.received;offset<file.size;offset+=8*1024*1024){
        status.textContent='正在保存原图副本 '+Math.floor(offset*100/file.size)+'%';
        await request('/api/preview-uploads/'+batch.id+'/files/'+item.id+'?offset='+offset,file.slice(offset,offset+8*1024*1024),true);
      }
    }
    const done=await request('/api/preview-uploads/'+batch.id+'/complete',{});
    entry.context={path:done.files[0].path};return entry.context.path;
  }
  for(const button of actions)button.addEventListener('click',async()=>{
    if(busy||!current)return;
    const viewer=current,action=button.dataset.hostAction,entry=action==='save-export'?latestExport:viewer;
    const ext=entry.file.name.split('.').at(-1).toLowerCase();
    if(action==='modeling'&&!['dwg','dxf','pdf','png','jpg','jpeg'].includes(ext)){
      status.textContent='三维建模入口接收二维原图；当前模型可直接测量或生成三视图。';return;
    }
    busy=true;sync();
    try{
      if(action==='save-export')entry.context={source:await save(viewer)};
      const path=await save(entry);
      if(current!==viewer)return;
      if(action==='save'||action==='save-export'){
        status.textContent=(action==='save'?'原图':'导出')+'副本已保存到当前账号上传记录。';
        if(action==='save')history.replaceState(null,'','?'+new URLSearchParams({path}));
      }else location.href=(action==='modeling'?'/modeling/':'/'+action+'/index.html')+'?'+new URLSearchParams({source:path});
    }catch(error){status.textContent=error.message;}
    finally{busy=false;sync();}
  });
  return {enable(){enabled=true;sync();},loaded(file,context){
    if(current?.file===file)return;
    current={file,context,capturedAt:new Date().toISOString()};latestExport=undefined;status.textContent='';sync();
  },exported(blob,name,original){
    if(!current||current.file!==original)return;
    latestExport={file:new File([blob],name),context:{source:current.context?.source||current.context?.path},capturedAt:new Date().toISOString()};
    status.textContent='文件已导出，可保存副本到账号记录。';sync();
  }};
}
