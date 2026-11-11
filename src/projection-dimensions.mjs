const formatted=n=>String(Number(n.toFixed(3)));
const near=(a,b,t)=>Math.abs(a-b)<=t;
export function innermostConcentric(circles,tolerance){
  const groups=[];
  for(const circle of circles){
    const group=groups.find(g=>Math.hypot(g.center[0]-circle.center[0],g.center[1]-circle.center[1])<=tolerance);
    if(!group)groups.push({...circle,ringCount:1});
    else{group.ringCount++;if(circle.diameter<group.diameter){Object.assign(group,circle);}}
  }
  return groups;
}
function inside(p,ring){let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;
}return hit;}
// A full circular inner contour is measurable. Partial arcs and slots are not
// promoted to holes; segmented curves carry their actual approximation error.
export function circularHoles(entities,layer,span){
  const contours=entities.filter(e=>e.layer===layer&&e.type==='LWPOLYLINE'&&e.closed&&e.vertices.length>=3);
  const holes=[];
  for(const e of contours){
    const p=e.vertices;if(p.length<12)continue;
    const xs=p.map(v=>v[0]),ys=p.map(v=>v[1]),w=Math.max(...xs)-Math.min(...xs),h=Math.max(...ys)-Math.min(...ys);
    const r=(w+h)/4,c=[(Math.max(...xs)+Math.min(...xs))/2,(Math.max(...ys)+Math.min(...ys))/2];
    const tolerance=Math.max(span*1e-6,r*.006);
    if(!r||!near(w,h,tolerance*2)||p.some(v=>!near(Math.hypot(v[0]-c[0],v[1]-c[1]),r,tolerance)))continue;
    const area=ring=>Math.abs(ring.reduce((sum,v,i)=>{const q=ring[(i+1)%ring.length];return sum+v[0]*q[1]-q[0]*v[1];},0));
    if(!contours.some(other=>other!==e&&area(other.vertices)>area(p)*1.02&&p.every(point=>inside(point,other.vertices))))continue;
    if(!holes.some(h=>Math.hypot(h.center[0]-c[0],h.center[1]-c[1])<tolerance&&near(h.diameter,2*r,tolerance)))holes.push({center:c,diameter:2*r,tolerance});
  }
  return holes;
}
function boundaryHoles(mesh,view,span){
  if(!mesh?.planarFaces?.length)return null;
  const factor=new Map([['µm',.001],['mm',1],['cm',10],['m',1000],['in',25.4],['ft',304.8]]).get(mesh.unit)??1;
  const scale=Math.max(...mesh.size)*factor;
  const projected=[];
  for(const face of mesh.planarFaces){
    const rings=face.rings.map(ring=>ring.map(p=>view.frame.slice(0,2).map((axis,i)=>p[Math.abs(axis)-1]*Math.sign(axis)*scale+view.shift[i])));
    if(rings[0].length<3)continue;
    const area=Math.abs(rings[0].reduce((sum,p,i)=>{const q=rings[0][(i+1)%rings[0].length];return sum+p[0]*q[1]-p[1]*q[0];},0));
    projected.push({rings,area});
  }
  const largest=Math.max(0,...projected.map(p=>p.area));
  const result=[];
  for(const {rings,area} of projected){
    // Tiny annular fastener faces and edge-on faces cannot establish a plate hole.
    if(area<largest*.05||!area)continue;
    const entities=rings.map(vertices=>({type:'LWPOLYLINE',layer:'candidate',closed:true,vertices}));
    for(const hole of circularHoles(entities,'candidate',span))if(!result.some(other=>Math.hypot(other.center[0]-hole.center[0],other.center[1]-hole.center[1])<span*1e-5&&near(other.diameter,hole.diameter,hole.tolerance)))result.push(hole);
  }
  return result;
}
export function addProjectionDimensions(drawing,scene={}){
  const {layout,entities}=drawing,h=layout.labelHeight*.7,span=Math.max(layout.bounds.right-layout.bounds.left,layout.bounds.top-layout.bounds.bottom);
  const line=(a,b)=>entities.push({type:'LINE',layer:'DIM',a,b});
  const text=(value,a)=>entities.push({type:'TEXT',layer:'DIM',value,a,height:h,angle:0,width:1});
  function dimension(a,b,offset,vertical=false){
    const av=vertical?[a[1],a[0]]:a,bv=vertical?[b[1],b[0]]:b;
    const pos=p=>vertical?[p[1],p[0]]:p;
    if(Math.abs(bv[0]-av[0])<span*1e-7)return;
    const start=entities.length;
    line(a,pos([av[0],offset+h*.4]));line(b,pos([bv[0],offset+h*.4]));line(pos([av[0],offset]),pos([bv[0],offset]));
    const length=Math.abs(bv[0]-av[0]),arrow=Math.min(h*.65,length*.18);
    for(const [x,dir] of [[av[0],1],[bv[0],-1]])for(const sign of [-1,1])line(pos([x,offset]),pos([x+dir*arrow,offset+sign*arrow*.35]));
    const textPoint=pos([(av[0]+bv[0])/2-h,offset+h*.45]);
    text(formatted(length),textPoint);
    const graphics=entities.splice(start);
    entities.push({type:'DIMENSION',layer:'DIM',kind:'linear',a,b,base:pos([av[0],offset]),textPoint,angle:vertical?90:0,height:h,measurement:length,graphics});
  }
  const diagnostics=[];
  for(const view of layout.views.filter(v=>!v.basis)){
    const [cx,cy]=view.shift,left=cx-view.width/2,right=cx+view.width/2,bottom=cy-view.height/2,top=cy+view.height/2;
    dimension([left,top],[right,top],top+5*h);
    dimension([left,bottom],[left,top],left-5*h,true);
    const visible=circularHoles(entities,view.layer+'-VISIBLE',span),source=boundaryHoles(scene.mesh,view,span);
    const holes=innermostConcentric([...visible,...(source??[])],span*1e-5);
    diagnostics.push({view:view.layer,holes:holes.length,diameters:holes.map(v=>v.diameter),method:'innermost-concentric-circle',approximate:true});
    // Cap chains explicitly, avoiding unreadable labels on dense patterns.
    if(holes.length&&holes.length<=24){
      const unique=values=>values.sort((a,b)=>a-b).filter((v,i,all)=>!i||v-all[i-1]>span*1e-5);
      const xs=unique([left,...holes.map(v=>v.center[0]),right]),ys=unique([bottom,...holes.map(v=>v.center[1]),top]);
      for(let i=1;i<xs.length;i++)dimension([xs[i-1],top],[xs[i],top],top+2*h);
      for(let i=1;i<ys.length;i++)dimension([left,ys[i-1]],[left,ys[i]],left-2*h,true);
    }
    const callouts=[];
    for(const hole of holes){
      for(const delta of [[h*.6,0],[0,h*.6]])entities.push({type:'LINE',layer:'CENTER-MARKS',a:hole.center.map((v,i)=>v-delta[i]),b:hole.center.map((v,i)=>v+delta[i])});
      const value='Φ'+formatted(hole.diameter),w=(1+(value.length-1)*.6)*h,r=hole.diameter/2;
      const offsets=[[1,1],[-1,1],[1,-1],[-1,-1],[0,1],[0,-1],[1,0],[-1,0]];
      const candidates=offsets.map(([dx,dy])=>{
        const a=[hole.center[0]+dx*(r+h),hole.center[1]+dy*(r+h)];
        if(dx<0)a[0]-=w;else if(!dx)a[0]-=w/2;
        if(dy<0)a[1]-=h;
        const box=[a[0]-.2*h,a[1]-.2*h,a[0]+w+.2*h,a[1]+1.2*h];
        const overlap=callouts.reduce((n,b)=>n+(Math.min(b[2],box[2])>Math.max(b[0],box[0])&&Math.min(b[3],box[3])>Math.max(b[1],box[1])?1:0),0);
        const collisions=holes.filter(other=>other!==hole&&other.center[0]>box[0]-other.diameter/2&&other.center[0]<box[2]+other.diameter/2&&other.center[1]>box[1]-other.diameter/2&&other.center[1]<box[3]+other.diameter/2).length;
        return {a,box,score:overlap*2+collisions};
      });
      const selected=candidates.reduce((best,c)=>c.score<best.score?c:best);
      callouts.push(selected.box);
      const anchor=[Math.max(selected.a[0],Math.min(hole.center[0],selected.a[0]+w)),selected.a[1]-.25*h];
      const delta=anchor.map((v,i)=>v-hole.center[i]),distance=Math.hypot(...delta)||1;
      const tip=hole.center.map((v,i)=>v+delta[i]/distance*r);
      const start=entities.length;
      line(tip,anchor);text(value,selected.a);
      const direction=tip.map((v,i)=>(v-hole.center[i])/r);
      const opposite=hole.center.map((v,i)=>v-direction[i]*r);
      const graphics=entities.splice(start);
      entities.push({type:'DIMENSION',layer:'DIM',kind:'diameter',a:tip,b:opposite,base:tip,textPoint:selected.a,height:h,measurement:hole.diameter,leaderLength:Math.hypot(...anchor.map((v,i)=>v-tip[i])),graphics});
    }
  }
  // Include every annotation in the enclosing frame, leaving source geometry 1:1.
  const b={...layout.bounds};
  for(const e of entities.flatMap(e=>e.type==='DIMENSION'?e.graphics:e)){const points=e.type==='TEXT'?[e.a,[e.a[0]+Array.from(e.value).length*e.height,e.a[1]+e.height]]:e.type==='LINE'?[e.a,e.b]:e.vertices??[];
    for(const [x,y] of points){b.left=Math.min(b.left,x);b.right=Math.max(b.right,x);b.bottom=Math.min(b.bottom,y);b.top=Math.max(b.top,y);}}
  layout.bounds=b;layout.dimensions={automatic:true,nativeCadDimensions:true,style:'XYCAD_DIM',unit:drawing.units===4?'mm':'source-unit',views:diagnostics,chainHoleLimit:24};
  return drawing;
}
