import type { ComicPanel } from './types';

export const comicPanelPixelBounds = (bounds: NonNullable<ComicPanel['bounds']>, width: number, height: number) => {
  if (![bounds.x, bounds.y, bounds.width, bounds.height, width, height].every(Number.isFinite)
    || width < 1 || height < 1 || bounds.width <= 0 || bounds.height <= 0
    || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > 1.000001 || bounds.y + bounds.height > 1.000001) {
    throw new Error('图格区域无效，请先重新识别漫画或选择单幅参考图。');
  }
  const x = Math.floor(bounds.x * width);
  const y = Math.floor(bounds.y * height);
  const right = Math.min(width, Math.ceil((bounds.x + bounds.width) * width));
  const bottom = Math.min(height, Math.ceil((bounds.y + bounds.height) * height));
  if (right <= x || bottom <= y) throw new Error('图格区域为空。');
  return { x, y, width: right - x, height: bottom - y };
};

/** Crop original pixels only; it never invents a frame or removes bubble text. */
export const cropComicPanel = async (dataUrl: string, bounds: NonNullable<ComicPanel['bounds']>): Promise<Blob> => {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const area = comicPanelPixelBounds(bounds, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = area.width;
  canvas.height = area.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建漫画裁图画布。');
  context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('漫画单格裁图失败。')), 'image/png',
  ));
};
