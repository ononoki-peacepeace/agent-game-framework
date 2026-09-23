import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AIProviderManager, readPersistedProviderConfig } from '../src/ai/providers.js';

it('persists provider selection server-side and restores it after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agf-provider-'));
  try {
    const manager = new AIProviderManager(dir, { provider: 'mock' });
    const info = await manager.configure({
      provider: 'deepseek',
      api_key: 'local-test-secret',
      model: 'deepseek-flash',
    }, { persist: true });

    expect(info.provider).toBe('deepseek');
    expect(info.persisted).toBe(true);
    expect(info.api_key_configured).toBe(true);
    expect(info).not.toHaveProperty('api_key');

    const stored = await readPersistedProviderConfig(dir);
    expect(stored).toEqual({ provider: 'deepseek', api_key: 'local-test-secret', model: 'deepseek-flash' });

    const raw = await readFile(join(dir, 'secrets', 'ai-provider.json'), 'utf8');
    expect(raw).toContain('local-test-secret');

    const restored = new AIProviderManager(dir, stored!, true);
    expect(restored.info()).toMatchObject({ provider: 'deepseek', persisted: true, api_key_configured: true, saved_provider: 'deepseek' });

    await restored.forgetPersisted();
    expect(restored.info().saved_provider).toBeNull();
    expect(await readPersistedProviderConfig(dir)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
