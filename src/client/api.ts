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

export async function uploadAvatar(entityId: string, file: File, gameId: string, revision: number) {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('头像仅支持 PNG / JPEG / WebP');
  if (file.size > 5 * 1024 * 1024) throw new Error('头像不能超过 5 MB');
  const response = await fetch(`/api/avatar/${encodeURIComponent(entityId)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Game-Token': token, 'X-Game-Id': gameId, 'X-Game-Revision': String(revision) },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '头像上传失败');
  return result;
}
