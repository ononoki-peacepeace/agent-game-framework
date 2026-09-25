/**
 * Create a real square avatar file from a full-body image without calling AI.
 *
 * The crop is content-aware: the character silhouette is located on a small analysis canvas, and the
 * avatar window is taken from the head/shoulder region (never the whole figure), so faces stay readable
 * in small UI avatars. Manual zoom / vertical offset can override the automatic framing.
 */
export interface AvatarCrop { x: number; y: number; size: number }
export interface CropOptions { zoom?: number; offsetY?: number }
export interface AvatarResult { file: File; crop: AvatarCrop }

const analysisMax = 192;
const output = 512;
const minSide = 48;

export async function avatarFromFullbody(file: File, options: CropOptions = {}): Promise<File> {
  return (await avatarCropFromFullbody(file, options)).file;
}

export async function avatarCropFromFullbody(file: File, options: CropOptions = {}): Promise<AvatarResult> {
  const loaded = await loadImage(file);
  try {
    const crop = autoCrop(loaded.source, loaded.width, loaded.height, options);
    return { file: await renderAvatar(loaded.source, loaded.width, loaded.height, crop, file.name), crop };
  } finally {
    loaded.close?.();
  }
}

function autoCrop(source: CanvasImageSource, width: number, height: number, options: CropOptions): AvatarCrop {
  const zoom = clamp(options.zoom ?? 1, 0.6, 2.4);
  const offsetY = clamp(options.offsetY ?? 0, -0.25, 0.25);
  const subject = detectSubject(source, width, height);
  if (!subject) {
    // Conservative fallback for flat or unreadable images: upper-centre window, head around the top edge.
    const side = Math.max(minSide, Math.min(width * 0.42, height * 0.30) / zoom);
    return { x: clamp((width - side) / 2, 0, Math.max(0, width - side)) / width, y: clamp(height * 0.03, 0, Math.max(0, height - side)) / height, size: side / Math.min(width, height) };
  }
  return cropFromSubject(subject, width, height, options);
}

/**
 * Framing rule for a located character: head, shoulders and upper chest.
 * The window is a square whose height follows the subject (not the whole canvas), so a tall full-body
 * illustration is no longer shown down to the abdomen, and the head stays near the top edge.
 */
export function cropFromSubject(subject: { x: number; y: number; width: number; height: number }, width: number, height: number, options: CropOptions = {}): AvatarCrop {
  const zoom = clamp(options.zoom ?? 1, 0.6, 2.4);
  const offsetY = clamp(options.offsetY ?? 0, -0.25, 0.25);
  const headTop = subject.y - subject.height * 0.05;
  const desired = Math.max(subject.height * 0.42, subject.width * 1.05) / zoom;
  const side = Math.max(minSide, Math.min(desired, width, height));
  const centreX = subject.x + subject.width / 2;
  const x = clamp(centreX - side / 2, 0, Math.max(0, width - side));
  const centreY = headTop + subject.height * 0.20;
  const y = clamp(centreY + offsetY * subject.height - side / 2, 0, Math.max(0, height - side));
  return { x: x / width, y: y / height, size: side / Math.min(width, height) };
}


async function renderAvatar(source: CanvasImageSource, width: number, height: number, crop: AvatarCrop, name: string) {
  const side = Math.max(minSide, Math.round(crop.size * Math.min(width, height)));
  const sx = clamp(Math.round(crop.x * width), 0, Math.max(0, width - side));
  const sy = clamp(Math.round(crop.y * height), 0, Math.max(0, height - side));
  const canvas = document.createElement('canvas');
  canvas.width = output;
  canvas.height = output;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('当前浏览器无法创建头像裁切画布');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, output, output);
  context.drawImage(source, sx, sy, side, side, 0, 0, output, output);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('头像裁切失败')), 'image/png', 0.92);
  });
  const base = name.replace(/\.[^.]+$/, '').slice(0, 80) || 'fullbody';
  return new File([blob], `${base}-auto-avatar.png`, { type: 'image/png', lastModified: Date.now() });
}

// Locate the character: background is estimated from the image corners, then rows/columns need a minimum
// coverage so stray noise or a background gradient cannot inflate the box.
function detectSubject(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, analysisMax / Math.max(width, height));
  const w = Math.max(8, Math.round(width * scale)), h = Math.max(8, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, w, h);
  let pixels: Uint8ClampedArray;
  try { pixels = context.getImageData(0, 0, w, h).data; } catch { return null; }
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
    const index = (y * w + x) * 4;
    return [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
  });
  const opaque = corners.filter(corner => corner[3] > 32);
  if (!opaque.length) return null;
  const background = [0, 1, 2].map(channel => median(opaque.map(corner => corner[channel])));
  const rows = new Uint32Array(h), columns = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const index = (y * w + x) * 4;
    if (pixels[index + 3] <= 32) continue;
    const distance = Math.abs(pixels[index] - background[0]) + Math.abs(pixels[index + 1] - background[1]) + Math.abs(pixels[index + 2] - background[2]);
    if (distance > 78) { rows[y]++; columns[x]++; }
  }
  const minRow = Math.max(1, Math.round(w * 0.02)), minColumn = Math.max(1, Math.round(h * 0.02));
  const first = (list: Uint32Array, minimum: number) => { for (let i = 0; i < list.length; i++) if (list[i] >= minimum) return i; return -1; };
  const last = (list: Uint32Array, minimum: number) => { for (let i = list.length - 1; i >= 0; i--) if (list[i] >= minimum) return i; return -1; };
  const top = first(rows, minRow), bottom = last(rows, minRow), left = first(columns, minColumn), right = last(columns, minColumn);
  if (top < 0 || bottom <= top || left < 0 || right <= left) return null;
  const toImage = (value: number) => value / scale;
  return {
    x: toImage(left), y: toImage(top),
    width: toImage(right - left + 1), height: toImage(bottom - top + 1),
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

type LoadedImage = { width: number; height: number; source: CanvasImageSource; close?: () => void };

async function loadImage(file: File): Promise<LoadedImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('无法读取全身图'));
      element.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight, source: image };
  } finally {
    URL.revokeObjectURL(url);
  }
}
