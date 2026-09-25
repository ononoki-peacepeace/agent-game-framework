import type {AvatarCropMetadata} from '../shared/avatar.js';
let token = '';
export async function session() {
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error('无法连接本地游戏服务');
  const value = await response.json(); token = value.token; return value as { token: string; engine: string; provider?: { provider: string; model?: string | null; base_url?: string | null } | null };
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result as T;
}

export async function uploadAvatar(entityId: string, file: File, gameId: string, revision: number,crop?:AvatarCropMetadata) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('头像仅支持 PNG / JPEG / WebP');
  if (file.size > 5 * 1024 * 1024) throw new Error('头像不能超过 5 MB');
  const response = await fetch(`/api/avatar/${encodeURIComponent(entityId)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Game-Token': token, 'X-Game-Id': gameId, 'X-Game-Revision': String(revision),...(crop?{'X-Avatar-Crop':JSON.stringify(crop)}:{}) },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '头像上传失败');
  return result;
}

export function clientRequestId(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}

export async function uploadVisualAsset(entityId: string, slot: string, file: File, gameId: string, revision: number) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('图片仅支持 PNG / JPEG / WebP');
  if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB');
  const response = await fetch(`/api/visual/${encodeURIComponent(entityId)}/${encodeURIComponent(slot)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Game-Token': token, 'X-Game-Id': gameId, 'X-Game-Revision': String(revision) },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '人物图片上传失败');
  return result;
}
