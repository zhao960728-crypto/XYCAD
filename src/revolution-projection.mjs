// Analytic occlusion for trimmed cylinders/cones. Preview mesh positions are
// intentionally unchanged; inscribed facets must not hide their own CAD rims.
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const turn=2*Math.PI;
const budget=work=>{if(++work.visits>45_000_000)throw Error('模型遮挡关系超过三视图计算预算，请拆分模型后重试。');};

export function revolutionModel(surface){
  const {frame,radius:r,slope:s,loops}=surface,{x,y,z,origin:o}=frame,det=dot(x,cross(y,z));if(!det)return null;
  const inverse=[cross(y,z),cross(z,x),cross(x,y)].map(v=>v.map(n=>n/det));
  const local=p=>inverse.map(row=>dot(row,p.map((v,i)=>v-o[i])));
  const q=[0,1,2].flatMap(i=>[0,1,2].map(j=>inverse[0][i]*inverse[0][j]+inverse[1][i]*inverse[1][j]-s*s*inverse[2][i]*inverse[2][j]));
  const linear=[0,1,2].map(i=>-2*dot(q.slice(3*i,3*i+3),o)-2*r*s*inverse[2][i]);
  const constant=o.reduce((v,n,i)=>v+n*dot(q.slice(3*i,3*i+3),o),0)+2*r*s*dot(inverse[2],o)-r*r;
  const coefficients=[...q,...linear,constant],norm=Math.hypot(...coefficients),signature=coefficients.map(v=>v/norm);
  const inverseScale=Math.max(...inverse.map(v=>Math.hypot(...v)));
  return {signature,ownsEdge(a,b,worldTolerance){
    const p=local(a),q=local(b),tolerance=Math.max(surface.tolerance??0,worldTolerance*inverseScale);
    if([p,q].some(v=>Math.abs(Math.hypot(v[0],v[1])-(r+s*v[2]))>tolerance))return false;
    const mid=p.map((v,i)=>(v+q[i])/2),radius=r+s*mid[2],chord=Math.max(surface.chord??0,tolerance);
    if(Math.abs(Math.hypot(mid[0],mid[1])-radius)>chord*1.01)return false;
    const angle=Math.atan2(mid[1],mid[0]);
    // Confirm a trim boundary, not merely two incidental points on a quadric.
    for(const loop of loops)for(let i=0;i<loop.length;i++){
      const a=loop[i],b=loop[(i+1)%loop.length],k=Math.round(((a[1]+b[1])/2-angle)/turn);
      const u=mid[2]-a[0],v=(angle+k*turn-a[1])*Math.max(Math.abs(radius),chord),dx=b[0]-a[0],dy=(b[1]-a[1])*Math.max(Math.abs(radius),chord),length=dx*dx+dy*dy;
      const t=length?Math.max(0,Math.min(1,(u*dx+v*dy)/length)):0;
      if(Math.hypot(u-t*dx,v-t*dy)<=chord*1.01)return true;
    }
    return false;
  }};
}

function roots(a,b,c){
  const scale=Math.max(Math.abs(a),Math.abs(b),Math.abs(c),1e-300);
  if(Math.abs(a)<scale*1e-14)return Math.abs(b)<scale*1e-14?[]:[-c/b];
  let d=b*b-4*a*c;
  if(d<0){if(d<-1e-13*(b*b+Math.abs(4*a*c)))return [];d=0;}
  const q=-.5*(b+(b>=0?1:-1)*Math.sqrt(d));
  return q?[q/a,c/q]:[-b/(2*a)];
}

function edgeIndex(rings,index){
  const edges=[];
  for(const ring of rings)for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length];
    edges.push({a,b,lowX:Math.min(a[0],b[0]),highX:Math.max(a[0],b[0]),lowY:Math.min(a[1],b[1]),highY:Math.max(a[1],b[1]),highZ:0});
  }
  return index(edges);
}

function crossesBox(node,a,b){
  let lo=0,hi=1;
  for(let i=0;i<2;i++){
    const min=i?node.lowY:node.lowX,max=i?node.highY:node.highX,d=b[i]-a[i];
    if(!d){if(a[i]<min||a[i]>max)return false;continue;}
    const x=(min-a[i])/d,y=(max-a[i])/d;lo=Math.max(lo,Math.min(x,y));hi=Math.min(hi,Math.max(x,y));if(hi<lo)return false;
  }
  return true;
}

function inside(index,p,work){
  let parity=false;const stack=[index];
  while(stack.length){
    const node=stack.pop();budget(work);
    if(node.highX<p[0]||node.lowY>p[1]||node.highY<p[1])continue;
    if(node.children){stack.push(...node.children);continue;}
    for(const {a,b} of node.triangles){
      budget(work);
      if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])parity=!parity;
    }
  }
  return parity;
}

export function revolutionInView(face,axes,signs,index){
  const {frame,radius,slope,loops}=face.surface,{x,y,z,origin}=frame;
  const det=dot(x,cross(y,z));if(!det)return null;
  const inverse=[cross(y,z),cross(z,x),cross(x,y)].map(v=>v.map(n=>n/det));
  const local=p=>inverse.map(row=>dot(row,p.map((v,i)=>v-origin[i])));
  const unproject=p=>{const v=[];for(let i=0;i<3;i++)v[axes[i]]=p[i]*signs[i];return v;};
  const eye=[0,0,0];eye[axes[2]]=signs[2];const ray=inverse.map(row=>dot(row,eye));
  const bounds={lowX:Infinity,highX:-Infinity,lowY:Infinity,highY:-Infinity,highZ:-Infinity};
  let low=Infinity,high=-Infinity,angleLow=Infinity,angleHigh=-Infinity;
  for(const loop of loops)for(const [h,a] of loop){low=Math.min(low,h);high=Math.max(high,h);angleLow=Math.min(angleLow,a);angleHigh=Math.max(angleHigh,a);}
  for(const h of [low,high])for(let i=0;i<3;i++){
    const axis=axes[i],center=(origin[axis]+z[axis]*h)*signs[i],r=Math.abs(radius+slope*h)*Math.hypot(x[axis],y[axis]);
    if(i===0){bounds.lowX=Math.min(bounds.lowX,center-r);bounds.highX=Math.max(bounds.highX,center+r);}
    if(i===1){bounds.lowY=Math.min(bounds.lowY,center-r);bounds.highY=Math.max(bounds.highY,center+r);}
    if(i===2)bounds.highZ=Math.max(bounds.highZ,center+r);
  }
  const projected=face.rings.map(ring=>ring.map(p=>axes.map((a,i)=>p[a]*signs[i])));
  return {...bounds,revolution:true,local:p=>local(unproject(p)),ray,radius,slope,low,high,angleLow,angleHigh,
    uvIndex:edgeIndex(loops,index),boundaryIndex:edgeIndex(projected,index),loops,
    point:(h,a)=>axes.map((axis,i)=>(origin[axis]+z[axis]*h+(radius+slope*h)*(x[axis]*Math.cos(a)+y[axis]*Math.sin(a)))*signs[i])};
}

export function revolutionSilhouettes(face,work){
  const [x,y,z]=face.ray,length=Math.hypot(x,y),target=face.slope*z;
  if(length<1e-14||Math.abs(target)>length*(1+1e-12))return [];
  const center=Math.atan2(y,x),offset=Math.acos(Math.max(-1,Math.min(1,target/length))),result=[];
  for(const base of [center-offset,center+offset]){
    const from=Math.ceil((face.angleLow-base)/turn-1e-12),to=Math.floor((face.angleHigh-base)/turn+1e-12);
    for(let k=from;k<=to;k++){
      const angle=base+k*turn,cuts=[face.low,face.high];
      for(const ring of face.loops)for(let i=0;i<ring.length;i++){
        budget(work);const a=ring[i],b=ring[(i+1)%ring.length];
        if((a[1]>angle)!==(b[1]>angle))cuts.push(a[0]+(b[0]-a[0])*(angle-a[1])/(b[1]-a[1]));
      }
      cuts.sort((a,b)=>a-b);
      for(let i=1;i<cuts.length;i++)if(cuts[i]>cuts[i-1]&&inside(face.uvIndex,[(cuts[i]+cuts[i-1])/2,angle],work))result.push([face.point(cuts[i-1],angle),face.point(cuts[i],angle)]);
    }
  }
  return result;
}

export function revolutionHiddenIntervals(face,start,end,work,depthTolerance,onSurface=false){
  const a=face.local(start),b=face.local(end),d=b.map((v,i)=>v-a[i]),v=face.ray,r=face.radius,s=face.slope;
  const A=v[0]**2+v[1]**2-(s*v[2])**2;
  const B0=2*(a[0]*v[0]+a[1]*v[1]-(r+s*a[2])*s*v[2]);
  const Bd=2*(d[0]*v[0]+d[1]*v[1]-s*d[2]*s*v[2]);
  const C0=a[0]**2+a[1]**2-(r+s*a[2])**2;
  const C1=2*(a[0]*d[0]+a[1]*d[1]-(r+s*a[2])*s*d[2]);
  const C2=d[0]**2+d[1]**2-(s*d[2])**2;
  const cuts=[0,1];
  for(const t of [...roots(C2,C1,C0),...roots(Bd*Bd-4*A*C2,2*B0*Bd-4*A*C1,B0*B0-4*A*C0)])if(t>0&&t<1)cuts.push(t);
  const dx=end[0]-start[0],dy=end[1]-start[1],stack=[face.boundaryIndex];
  while(stack.length){
    const node=stack.pop();budget(work);if(!crossesBox(node,start,end))continue;
    if(node.children){stack.push(...node.children);continue;}
    for(const {a:p,b:q} of node.triangles){
      budget(work);const ex=q[0]-p[0],ey=q[1]-p[1],det=dx*ey-dy*ex;if(Math.abs(det)<1e-18)continue;
      const x=p[0]-start[0],y=p[1]-start[1],t=(x*ey-y*ex)/det,u=(x*dy-y*dx)/det;
      if(t>0&&t<1&&u>=-1e-10&&u<=1+1e-10)cuts.push(t);
    }
  }
  function hidden(t){
    budget(work);const p=a.map((v,i)=>v+t*d[i]);
    if(onSurface){
      const length=Math.hypot(p[0],p[1]),radius=r+s*p[2];
      if(length&&radius>=0){p[0]*=radius/length;p[1]*=radius/length;}
    }
    const B=onSurface?2*(p[0]*v[0]+p[1]*v[1]-(r+s*p[2])*s*v[2]):B0+Bd*t;
    const C=onSurface?0:C0+C1*t+C2*t*t;
    for(const depth of roots(A,B,C)){
      if(!(depth>depthTolerance))continue;
      const h=p[2]+depth*v[2];if(h<face.low-1e-10||h>face.high+1e-10||r+s*h<0)continue;
      const angle=Math.atan2(p[1]+depth*v[1],p[0]+depth*v[0]);
      const from=Math.ceil((face.angleLow-angle)/turn-1e-12),to=Math.floor((face.angleHigh-angle)/turn+1e-12);
      for(let k=from;k<=to;k++)if(inside(face.uvIndex,[h,angle+k*turn],work))return true;
    }
    return false;
  }
  cuts.sort((a,b)=>a-b);const result=[];
  for(let i=1;i<cuts.length;i++){
    const low=cuts[i-1],high=cuts[i];if(high-low<1e-10)continue;
    // Trim boundaries are sampled, so refine any detected change with the
    // analytic ray predicate rather than inherit a faceted depth transition.
    const points=[low+(high-low)*1e-7,...[.25,.5,.75].map(t=>low+(high-low)*t),high-(high-low)*1e-7];
    const flags=points.map(hidden);let cursor=low,state=flags[0];
    for(let j=1;j<points.length;j++)if(flags[j]!==state){
      let l=points[j-1],h=points[j];for(let n=0;n<30&&h-l>1e-10;n++){const m=(l+h)/2;if(hidden(m)===state)l=m;else h=m;}
      const at=(l+h)/2;if(state)result.push([cursor,at]);cursor=at;state=flags[j];
    }
    if(state)result.push([cursor,high]);
  }
  return result;
}
