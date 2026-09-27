import { createHash } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ImageUsage = 'avatar' | 'fullbody' | 'scene' | 'other';
export interface ImageGenerationRequest {
  prompt: string;
  usage: ImageUsage;
  aspect?: 'square' | 'portrait' | 'landscape';
  entity_id?: string;
  signal?: AbortSignal;
}
export interface GeneratedImage {
  bytes: Uint8Array;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
  provider: string;
  model?: string | null;
  metadata?: Record<string, unknown>;
}
export interface ImageGenerationProvider {
  readonly id: string;
  availability(): Promise<{ available: boolean; reason: string | null }>;
  generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}
export interface PersistedImage {
  asset_id: string;
  mime_type: GeneratedImage['mime_type'];
  provider: string;
  model: string | null;
  metadata: Record<string, unknown>;
}

const extensionFor = (mime: GeneratedImage['mime_type']) => mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
function validateImage(result: GeneratedImage) {
  const bytes = Buffer.from(result.bytes);
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('图片 Provider 返回了空文件或超过 8 MB 的文件');
  const valid = result.mime_type === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
    : result.mime_type === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw new Error('图片 Provider 返回的内容与 MIME 类型不匹配');
  return bytes;
}

export class ImageAssetRuntime {
  constructor(readonly provider: ImageGenerationProvider, readonly assetDirectory: string) {}
  async available() { return this.provider.availability(); }
  async generateAndPersist(request: ImageGenerationRequest): Promise<PersistedImage> {
    const availability = await this.provider.availability();
    if (!availability.available) throw new Error(availability.reason ?? `图片 Provider ${this.provider.id} 当前不可用`);
    const generated = await this.provider.generate(request);
    const bytes = validateImage(generated), digest = createHash('sha256').update(bytes).digest('hex');
    const asset_id = `avatar_${digest.slice(0, 32)}`, extension = extensionFor(generated.mime_type);
    const directory = join(this.assetDirectory, 'avatars'), path = join(directory, `${asset_id}.${extension}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    return { asset_id, mime_type: generated.mime_type, provider: generated.provider || this.provider.id, model: generated.model ?? null, metadata: generated.metadata ?? {} };
  }
  async discard(asset: PersistedImage) {
    await unlink(join(this.assetDirectory, 'avatars', `${asset.asset_id}.${extensionFor(asset.mime_type)}`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
