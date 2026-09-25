import type {AvatarCropMetadata} from '../shared/avatar.js';
let token = '';
const naturalFailure='这次请求没有成功完成，当前状态没有被修改。请检查本地服务后重试。';
const internalFailure=/Failed to fetch|TypeError|ECONNRESET|AbortError|socket hang up|HTTP\s*5\d\d|at\s+\S+\s*\(/i;
function readableError(value:unknown,fallback=naturalFailure){const text=typeof value==='string'?value:'';return text&&!internalFailure.test(text)?text:fallback;}
async function fetchJson(url:string,init:RequestInit,retryRead=false){
 let response:Response;
 for(let attempt=0;;attempt++)try{response=await fetch(url,init);break;}catch{if(retryRead&&attempt===0)continue;throw new Error(naturalFailure);}
 let result:any;try{result=await response.json();}catch{throw new Error(response.ok?'本地服务返回了无法读取的结果。':naturalFailure);}
 if(!response.ok)throw Object.assign(new Error(readableError(result?.error,'请求没有完成，当前状态没有被修改。')),{payload:result});
 return result;
}
export async function session() {
  const value=await fetchJson('/api/session',{method:'GET'},true);token=value.token;return value as { token: string; engine: string; provider?: { provider: string; model?: string | null; base_url?: string | null } | null };
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const read=body===undefined;
  return await fetchJson(`/api/${path}`, { method: read ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Game-Token': token }, ...(read ? {} : { body: JSON.stringify(body) }) },read) as T;
}

export async function uploadAvatar(entityId: string, file: File, gameId: string, revision: number,crop?:AvatarCropMetadata) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('头像仅支持 PNG / JPEG / WebP');
  if (file.size > 5 * 1024 * 1024) throw new Error('头像不能超过 5 MB');
  return fetchJson(`/api/avatar/${encodeURIComponent(entityId)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Game-Token': token, 'X-Game-Id': gameId, 'X-Game-Revision': String(revision),...(crop?{'X-Avatar-Crop':JSON.stringify(crop)}:{}) },
    body: file,
  });
}

export function clientRequestId(){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');}

export async function uploadVisualAsset(entityId: string, slot: string, file: File, gameId: string, revision: number) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('图片仅支持 PNG / JPEG / WebP');
  if (file.size > 8 * 1024 * 1024) throw new Error('图片不能超过 8 MB');
  return fetchJson(`/api/visual/${encodeURIComponent(entityId)}/${encodeURIComponent(slot)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Game-Token': token, 'X-Game-Id': gameId, 'X-Game-Revision': String(revision) },
    body: file,
  });
}
