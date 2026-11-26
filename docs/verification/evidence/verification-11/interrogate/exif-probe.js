// Run in the live page (preview_evaluate). Builds a 64x32 JPEG (left red, right blue) with EXIF Orientation=6.
(async () => {
  const c = new OffscreenCanvas(64, 32); const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0,0,32,32); g.fillStyle = '#00f'; g.fillRect(32,0,32,32);
  const jpg = new Uint8Array(await (await c.convertToBlob({type:'image/jpeg', quality:0.95})).arrayBuffer());
  const tiff = [0x4d,0x4d,0,0x2a,0,0,0,8, 0,1, 0x01,0x12, 0,3, 0,0,0,1, 0,6,0,0, 0,0,0,0];
  const payload = [0x45,0x78,0x69,0x66,0,0, ...tiff]; const len = payload.length + 2;
  const withExif = new Uint8Array([...jpg.slice(0,2), 0xff,0xe1,len>>8,len&255,...payload, ...jpg.slice(2)]);
  const blob = new Blob([withExif], {type:'image/jpeg'});
  const out = {ua: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]};
  for (const opts of [undefined, {imageOrientation:'none', colorSpaceConversion:'none'}, {imageOrientation:'from-image'}]) {
    const b = await createImageBitmap(blob, opts); const k = new OffscreenCanvas(b.width,b.height).getContext('2d'); k.drawImage(b,0,0); const px = k.getImageData(0,0,1,1).data;
    out[JSON.stringify(opts ?? 'default')] = `${b.width}x${b.height}, top-left pixel rgb(${px[0]},${px[1]},${px[2]})`;
  }
  const plain = await createImageBitmap(new Blob([jpg],{type:'image/jpeg'}), {imageOrientation:'none'}); out['no EXIF, none'] = `${plain.width}x${plain.height}`;
  return out;
})()
