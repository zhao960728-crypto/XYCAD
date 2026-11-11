import {frameMetadata} from './projection-frame.mjs';
export const frontFrames = { ny:[1,3,-2],py:[-1,3,2],px:[2,3,1],nx:[-2,3,-1],pz:[1,2,3],nz:[1,-2,-3] };
export const papers = {
  'a4-landscape':{id:'a4-landscape',width:297,height:210,name:'A4 landscape'},
  'a4-portrait':{id:'a4-portrait',width:210,height:297,name:'A4 portrait'},
  'a3-landscape':{id:'a3-landscape',width:420,height:297,name:'A3 landscape'},
  'a3-portrait':{id:'a3-portrait',width:297,height:420,name:'A3 portrait'},
};

export function projectionSettings(params) {
  const front=params.get('front')??'ny',turn=params.get('turn')??(front==='auto'?'auto':'0');
  const paper=params.get('paper')??(front==='auto'?'auto':'a4-landscape'),raw=params.get('gap');
  const gap=raw===null||raw===''?null:Number(raw);
  const seams=params.get('seams')??'0';
  for(const key of ['front','turn','paper','gap','seams'])if(params.getAll(key).length>1)throw Error('三视图参数不能重复。');
  if(!['0','1'].includes(seams))throw Error('无效的曲面分区线设置。');
  if(!Object.hasOwn(frontFrames,front)&&front!=='auto')throw Error('无效的主视方向。');
  if(!['auto','0','90','180','270'].includes(turn))throw Error('无效的视图转向。');
  if(!Object.hasOwn(papers,paper)&&!['auto','a3-auto'].includes(paper))throw Error('无效的纸张设置。');
  if(gap!==null&&(!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)||!Number.isFinite(gap)||gap<0||gap>10000))throw Error('最小间距须在 0 至 10000 之间。');
  const metadata=frameMetadata(params);
  return {front,turn,paper,gap,seams,...(Object.keys(metadata).length?{metadata}:{})};
}

function frameAt(front,turn){
  let [r,u,e]=frontFrames[front];
  for(let i=0;i<turn/90;i++)[r,u]=[u,-r];
  return [r,u,e];
}

export function projectionLayout(size,front='ny',options={}) {
  const requested=projectionSettings(new URLSearchParams({front,...Object.fromEntries(Object.entries(options).filter(([k,v])=>['turn','paper','gap','seams'].includes(k)&&v!==null&&v!==undefined))}));
  const span=Math.max(...size),labelHeight=span*.018,labelMargin=labelHeight*.45,labelWidth=labelHeight*3.2;
  const gap=Math.max(requested.gap??span*.025,span*.22);
  const directions=front==='auto'?['ny','py','px','nx','pz','nz']:[front];
  const turns=requested.turn==='auto'?[0,90,180,270]:[Number(requested.turn)];
  const pages=requested.paper==='auto'?[papers['a4-landscape'],papers['a4-portrait']]:requested.paper==='a3-auto'?[papers['a3-landscape'],papers['a3-portrait']]:[papers[requested.paper]];
  const candidates=[];
  for(const direction of directions)for(const turn of turns){
    const [r,u,e]=frameAt(direction,turn),dimension=axis=>size[Math.abs(axis)-1];
    const w=dimension(r),h=dimension(u),d=dimension(e);
    const isoWidth=(size[0]+size[1])/Math.sqrt(2),isoHeight=(size[0]+size[1])/Math.sqrt(6)+size[2]*Math.sqrt(2/3);
    const mainWidth=Math.max(w,labelWidth),sideWidth=Math.max(d,isoWidth,labelWidth);
    const sx=-(mainWidth+sideWidth)/2-gap,sy=-(h+Math.max(d,isoHeight))/2-gap-labelHeight-2*labelMargin;
    const views=[
      {layer:'FRONT',label:'正视图',frame:[r,u,e],width:w,height:h,shift:[0,0]},
      {layer:'TOP',label:'俯视图',frame:[r,-e,u],width:w,height:d,shift:[0,sy]},
      {layer:'RIGHT',label:'右视图',frame:[-e,u,r],width:d,height:h,shift:[sx,0]},
      {layer:'ISO',label:'轴测图',frame:[1,2,3],basis:[[Math.SQRT1_2,Math.SQRT1_2,0],[-1/Math.sqrt(6),1/Math.sqrt(6),Math.sqrt(2/3)],[1/Math.sqrt(3),-1/Math.sqrt(3),1/Math.sqrt(3)]],width:isoWidth,height:isoHeight,shift:[sx,sy]},
    ].map(v=>({...v,labelPosition:[v.shift[0]-labelWidth/2,v.shift[1]-v.height/2-labelMargin-labelHeight]}));
    const left=Math.min(...views.map(v=>v.shift[0]-Math.max(v.width,labelWidth)/2));
    const right=Math.max(...views.map(v=>v.shift[0]+Math.max(v.width,labelWidth)/2));
    const bottom=Math.min(...views.map(v=>v.labelPosition[1]));
    const top=Math.max(...views.map(v=>v.shift[1]+v.height/2));
    for(const paper of pages){
      const scale=Math.min((paper.width-24)/(right-left),(paper.height-42)/(top-bottom));
      candidates.push({front:direction,turn,paper,views,labelHeight,labelWidth,gap,bounds:{left,right,bottom,top},scale,area:w*h});
    }
  }
  const maxArea=Math.max(...candidates.map(c=>c.area)),maxScale=Math.max(...candidates.map(c=>c.scale));
  // Prefer an informative broad face, then paper use. Stable ties preserve the
  // conventional -Y direction and an unturned model rather than arbitrary flips.
  const score=c=>.7*(maxArea?c.area/maxArea:0)+.3*c.scale/maxScale;
  const selected=candidates.reduce((best,c)=>score(c)>score(best)+1e-9?c:best);
  return {...selected,requested:{...requested,...(options.metadata&&{metadata:frameMetadata(new URLSearchParams(options.metadata))})},automatic:front==='auto'||requested.turn==='auto'||['auto','a3-auto'].includes(requested.paper),firstAngle:true};
}
