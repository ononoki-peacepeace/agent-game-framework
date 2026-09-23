import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createApp } from './app.js';
import { GameService } from './service.js';
import { JsonStore } from '../storage/json-store.js';
import { AIRuntime } from '../ai/runtime.js';
import { readProfile } from '../ai/profiles.js';
import { AIProviderManager, providerConfigSchema, type ProviderConfig } from '../ai/providers.js';
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
const providers = new AIProviderManager(directory, initialProvider);
const service = new GameService(new JsonStore(directory), new AIRuntime(providers), demo);
const app = createApp(service, undefined, providers, resolve(directory, 'assets')), port = Number(process.env.PORT ?? 3100);
const server = app.listen(port, '127.0.0.1', () => console.log(`Agent Game Framework (${providers.name}) http://127.0.0.1:${port}`));
const shutdown = () => server.close(() => { void unlink(lockPath).finally(() => process.exit()); });
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', async error => { await unlink(lockPath); console.error(error.message); process.exitCode = 1; });
process.on('message', message => { if (message === 'shutdown') shutdown(); });
