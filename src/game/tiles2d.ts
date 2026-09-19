/** Shared 2D-map helpers: raster tile image cache + Web Mercator pixel math. */

export const TILE_ZOOM = 17;

const tileCache = new Map<string, HTMLImageElement>();

export function tileImg(z: number, x: number, y: number): HTMLImageElement {
  const key = `${z}/${x}/${y}`;
  let img = tileCache.get(key);
  if (!img) {
    img = new Image();
    img.src = `/api/tiles/${z}/${x}/${y}`;
    tileCache.set(key, img);
    if (tileCache.size > 800) {
      const oldest = tileCache.keys().next().value;
      if (oldest) tileCache.delete(oldest);
    }
  }
  return img;
}

export function globalPx(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n * 256,
    y: ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n * 256,
  };
}

export function metersPerPixel(lat: number, z: number): number {
  return 156543.03392 * Math.cos((lat * Math.PI) / 180) / 2 ** z;
}
