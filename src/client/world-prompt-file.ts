export const MAX_WORLD_PROMPT_LENGTH = 12000;
export const MAX_WORLD_PROMPT_FILE_BYTES = 512 * 1024;

export type WorldPromptFile =
  | { kind: 'description'; name: string; description: string }
  | { kind: 'profile'; name: string; profile: PromptProfile };

export type PromptProfile = { id: string; version: string; engine_policy: string; world_initializer: string; intent_interpreter: string; narrator: string; npc_decision: string; gm_reasoning: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isPromptProfile(value: unknown): value is PromptProfile {
  const fields = ['id', 'version', 'engine_policy', 'world_initializer', 'intent_interpreter', 'narrator', 'npc_decision', 'gm_reasoning'];
  const object = record(value);
  return !!object && Object.keys(object).length === fields.length && fields.every(key => typeof object[key] === 'string') && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(object.id as string);
}

export function validatedWorldPrompt(value: string): string {
  const result = value.replace(/^\uFEFF/, '').trim();
  if (!result) throw new Error('提示词为空；请输入文字或选择有内容的文件。');
  if (result.length > MAX_WORLD_PROMPT_LENGTH) throw new Error(`世界描述最多 ${MAX_WORLD_PROMPT_LENGTH} 个字符，请缩短后再创建。`);
  if (result.includes('\0')) throw new Error('提示词包含无法使用的空字符。');
  return result;
}

export function appendWorldPrompt(existing: string, incoming: string): string {
  return validatedWorldPrompt(`${existing.trim()}\n\n${incoming.trim()}`);
}

export async function readWorldPromptFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<WorldPromptFile> {
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!['txt', 'md', 'markdown', 'json'].includes(extension ?? '')) throw new Error('仅支持 UTF-8 的 TXT、MD 或提示词 JSON 文件。');
  if (file.size > MAX_WORLD_PROMPT_FILE_BYTES) throw new Error('提示词文件不能超过 512 KB。');
  if (!file.size) throw new Error('文件为空，请选择有内容的提示词文件。');
  let raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/, ''); }
  catch { throw new Error('文件读取或 UTF-8 解码失败，请将文件保存为 UTF-8 后重试。'); }
  if (extension !== 'json') return { kind: 'description', name: file.name, description: validatedWorldPrompt(raw) };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('JSON 格式无效，请检查文件内容。'); }
  if (isPromptProfile(parsed)) return { kind: 'profile', name: file.name, profile: parsed };
  const object = record(parsed);
  if (!object) throw new Error('JSON 提示词必须是包含 description 或 prompt 字段的对象。');
  if ('schema_version' in object || 'framework_version' in object || 'definition' in object || 'entities' in object || 'map' in object || 'world' in object) {
    throw new Error('这是世界定义或存档，请使用启动页的「读取存档」及其现有校验流程。');
  }
  const allowed = ['type', 'title', 'description', 'prompt'];
  if (Object.keys(object).some(key => !allowed.includes(key)) || (object.type !== undefined && !['world_prompt', 'creation_prompt'].includes(String(object.type)))) {
    throw new Error('未识别的 JSON 结构；创作提示词只接受 description 或 prompt 字段。');
  }
  const value = object.description ?? object.prompt;
  if (typeof value !== 'string') throw new Error('JSON 提示词需要非空的 description 或 prompt 文本。');
  return { kind: 'description', name: file.name, description: validatedWorldPrompt(value) };
}
