import { readSolidWorksThumbnail, readSheetPng } from './slddrw-preview.mjs';
import { readDibBitmap } from './dwg-preview.mjs';

export function savedPartImage(bytes) {
  if(bytes.length>8*1024*1024)return null;
  const png=readSheetPng(bytes);
  if(png)return {width:png.width,height:png.height,mime:'image/png',base64:bytes.toString('base64')};
  const dib=readDibBitmap(bytes);
  return dib&&{width:dib.width,height:dib.height,mime:dib.mime,base64:dib.data.toString('base64')};
}

export function savedPartScene(image,reason,details={}) {
  return {format:'SolidWorks SLDPRT · 文件保存缩略图',image,items:[],layers:[],thumbnailOnly:true,
    projectionAvailable:false,dxfAvailable:false,pdfAvailable:false,
    ...(details.configurations&&{configurations:details.configurations,selectedConfiguration:details.selectedConfiguration}),
    issues:[[reason,1],['当前仅显示原文件保存的缩略图，配置归属和模型完整性未确认。不能测量、生成三视图或据此确认制造尺寸。',1]]};
}

export function savedPartThumbnail(bytes) {
  try{return readSolidWorksThumbnail(bytes);}catch{return null;}
}
