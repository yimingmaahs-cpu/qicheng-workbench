// WebGL rows run bottom-to-top; pointer coordinates are CSS pixels from the top.
export function maskHit(pixels: Uint8Array, width: number, height: number, x: number, y: number, viewWidth: number, viewHeight: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || viewWidth<=0 || viewHeight<=0 || x<0 || y<0 || x>=viewWidth || y>=viewHeight) return false;
  const column=Math.floor(x/viewWidth*width),row=height-1-Math.floor(y/viewHeight*height);
  return pixels[(row*width+column)*4+3]>32;
}

// Reuse the GPU silhouette once per mask refresh; never rescan it for mouse moves.
export function maskTop(pixels: Uint8Array, width: number, height: number): number | undefined {
  for(let row=height-1;row>=0;row--)for(let x=0;x<width;x++)
    if(pixels[(row*width+x)*4+3]>32)return (height-1-row)/height;
  return undefined;
}
