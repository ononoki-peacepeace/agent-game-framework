import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve, join } from 'node:path';
import { createApp } from './app.js';
import { GameService } from './service.js';
import { JsonStore } from '../storage/json-store.js';
import { AIRuntime } from '../ai/runtime.js';
import { readProfile } from '../ai/profiles.js';
import { AIProviderManager, providerConfigSchema, readPersistedProviderConfig, type ProviderConfig } from '../ai/providers.js';
import { worldSchema, safeParse } from '../core/schema.js';

const directory = resolve(process.env.GAME_DATA_DIR ?? 'data');
await mkdir(directory, { recursive: true });
const lockPath = join(directory, 'runtime.lock');
try { const lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close(); }
catch { throw new Error(`存档目录已有运行锁 ${lockPath}。请关闭其他实例；崩溃后确认旧进程退出再删除此锁。`); }
const demo = safeParse(worldSchema, JSON.parse(await readFile(resolve(process.env.GAME_WORLD_FILE ?? 'content/worlds/town.json'), 'utf8')));
if (process.env.PROMPT_PROFILE_PATH) demo.prompt_profile = await readProfile(resolve(process.env.PROMPT_PROFILE_PATH));

const initialProvider: ProviderConfig = safeParse(providerConfigSchema, {
  provider: process.env.AI_ADAPTER ?? 'codex',
  ...(process.env.AI_ADAPTER === 'openai' && process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}),
  ...(process.env.AI_ADAPTER === 'deepseek' && process.env.DEEPSEEK_MODEL ? { model: process.env.DEEPSEEK_MODEL } : {}),
});
const persistedProvider = await readPersistedProviderConfig(directory);
const providers = new AIProviderManager(directory, persistedProvider ?? initialProvider, !!persistedProvider);
const service = new GameService(new JsonStore(directory), new AIRuntime(providers), demo);
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST?.trim() || '127.0.0.1';
const allowLan = host === '0.0.0.0' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
const app = createApp(service, undefined, providers, resolve(directory, 'assets'), { allowLan });
const server = app.listen(port, host, () => {
  console.log(`Agent Game Framework (${providers.name})`);
  console.log(`本机: http://127.0.0.1:${port}`);
  if (allowLan) {
    const urls: string[] = [];
    for (const group of Object.values(networkInterfaces())) for (const item of group ?? []) {
      if (item.family === 'IPv4' && !item.internal && privateAddress(item.address)) urls.push(`http://${item.address}:${port}`);
    }
    for (const url of [...new Set(urls)]) console.log(`局域网: ${url}`);
    console.log('LAN 模式已开启：只接受 localhost / 127.0.0.1 / RFC1918 私有 IPv4 Host。');
  }
});
function privateAddress(address: string) { return /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address); }
const shutdown = () => server.close(() => { void unlink(lockPath).finally(() => process.exit()); });
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', async error => { await unlink(lockPath); console.error(error.message); process.exitCode = 1; });
process.on('message', message => { if (message === 'shutdown') shutdown(); });
