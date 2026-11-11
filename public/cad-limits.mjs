export const MiB = 1024 * 1024;
export const meshExtensions = ['stl', '3mf', 'stp', 'step', 'sldprt', 'x_t', 'x_b', 'obj', 'ply', 'off'];
export const formatHints = ['slddrw', ...meshExtensions];
export const uploadExtensions = ['dxf', 'dwg', 'dwt', 'dwfx', 'exb', ...formatHints];
export const uploadHint = uploadExtensions.map(extension => extension.toUpperCase()).join(' / ');
export const projectionHiddenLayers = ['FRONT-HIDDEN', 'TOP-HIDDEN', 'RIGHT-HIDDEN'];
export const projectionTriangleLimit = 200_000;

export function projectionHiddenMask(layers,requested=7){
  let mask=requested;
  for(const {name,checkbox} of layers){
    const index=projectionHiddenLayers.indexOf(name);if(index<0)continue;
    if(checkbox.checked)mask|=1<<index;else mask&=~(1<<index);
  }
  return mask;
}
