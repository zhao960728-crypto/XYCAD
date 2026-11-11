// A2-260423: editable linework and fields, sized around the view group.
import { frameLines, frameCircles } from './projection-frame-template.mjs';

export const frameFields = ['drawingNo','partName','material','thickness','quantity','surface','unfolded','requirements','process','bendFactor','mass'];
export function frameMetadata(params) {
  const result={};
  for(const key of ['sourceName',...frameFields]) {
    if(params.getAll(key).length>1)throw Error('图框字段不能重复。');
    const value=params.get(key);
    if(value===null)continue;
    if(value.length>240||/[\x00-\x08\x0b-\x1f\x7f]/.test(value))throw Error('图框字段过长或含无效字符。');
    result[key]=value.trim();
  }
  return result;
}
const num=n=>String(Number(n.toPrecision(6)));
const units=new Map([['µm',.001],['mm',1],['cm',10],['m',1000],['in',25.4],['ft',304.8]]);
export function addProjectionFrame(drawing, scene, part) {
  const {layout}=drawing, meta=layout.requested.metadata??{};
  const b=layout.bounds, s=Math.max((b.right-b.left)/250,(b.top-b.bottom)/190,1e-9);
  const left=b.left-8*s, bottom=b.bottom-8*s;
  const divider=b.right+8*s, right=divider+62*s;
  const height=b.top-b.bottom+16*s, top=bottom+height;
  // Preserve the source's outer border, corner ticks, row divisions and symbol.
  const x=v=>v<0?left+(v+148.5)*s:divider+(v-119.42086897401117)/26.43557365998987*59*s;
  const map=([u,v])=>[u<-130?left+(u+148.5)*s:u>148?right:x(u),bottom+(v+104.59824119489367)/209.196482389787*height];
  for(const [a,b] of frameLines) {
    const point=p=>Math.abs(p[0]-148.5)<1e-5?[right,map(p)[1]]:map(p);
    drawing.entities.push({type:'LINE',layer:'FRAME',a:point(a),b:point(b)});
  }
  for(const c of frameCircles) {
    const p=map(c.a),r=c.radius*s;
    drawing.entities.push({type:'LWPOLYLINE',layer:'FRAME',closed:true,vertices:Array.from({length:48},(_,i)=>[p[0]+r*Math.cos(i*Math.PI/24),p[1]+r*Math.sin(i*Math.PI/24)])});
  }
  const text=(value,x0,y0,w,h,layer='TEXT')=>{
    value=String(value||'待核');
    const chars=Array.from(value),lines=[];let row='',used=0;
    const base=2.4*s,capacity=Math.max(4,Math.floor(w/base));
    for(const ch of chars){const width=ch.charCodeAt(0)>255?1.1:.75;if(ch==='\n'||used+width>capacity){lines.push(row);row='';used=0;}if(ch!=='\n'){row+=ch;used+=width;}}
    if(row)lines.push(row);
    const size=Math.min(base,h/(Math.max(1,lines.length)*1.45));
    lines.forEach((line,i)=>drawing.entities.push({type:'TEXT',layer,value:line,a:[x0,y0+h-size*(1.2+i*1.45)],height:size,angle:0,width:1}));
  };
  const source=(meta.sourceName??'').replace(/^.*[\\/]/,'').replace(/\.[^.]+$/,'');
  const values={...meta,drawingNo:meta.drawingNo||source,partName:meta.partName||scene.partLabel||source};
  const rows=[['图号','drawingNo',101.9547,88.7369],['零件名','partName',88.7369,75.5191],['材质','material',75.5191,68.6946],['厚度','thickness',68.6946,61.5917],['数量','quantity',61.5917,54.9623],['表面处理','surface',54.9623,48.4513],['展开尺寸','unfolded',48.4513,36.1802],['技术要求','requirements',23.4806,-52.1666],['工艺流程','process',-56.4900,-71.3244],['折弯系数','bendFactor',-71.3244,-77.4428],['质量','mass',-77.4428,-83.0943],['外形尺寸','dimensions',-83.0943,-96.3121]];
  const multiplier=units.get(scene.mesh?.unit);
  values.dimensions=multiplier?scene.mesh.size.map(n=>num(n*multiplier)).join(' × ')+' mm':'单位待核';
  for(const [label,key,y1,y2] of rows){
    const y=map([119.4209,y2])[1],h=(y1-y2)/209.196482389787*height;
    if(['unfolded','requirements','process','dimensions'].includes(key)) {
      const header=Math.min(4.5*s,h*.42);
      text(label,divider+2*s,y+h-header,55*s,header);
      text(values[key],divider+2*s,y+.5*s,55*s,Math.max(s*.5,h-header-.5*s));
    }else{
      text(label,divider+1.5*s,y+s,21*s,h-2*s);
      text(values[key],divider+25*s,y+s,32*s,h-2*s,['thickness','quantity'].includes(key)?'KEY_INFO':'TEXT');
    }
  }
  text('第一角法',divider+3*s,map([0,30])[1],24*s,4*s);
  text('日期 '+new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),divider+2*s,bottom+2*s,55*s,4*s);
  layout.contentBounds={...b};layout.bounds={left,bottom,right,top};
  layout.frame={template:'A2-260423',adaptive:true,metadata:values,sourceName:meta.sourceName??'',bounds:layout.bounds};
  return drawing;
}
