import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { GameError, id, profileSchema, safeParse } from '../core/schema.js';
import { providerConfigSchema, type AIProviderManager } from '../ai/providers.js';
import { z } from 'zod';
import type { GameService } from './service.js';

export function createApp(service: GameService, clientDirectory = resolve('dist/client'), providers?: AIProviderManager, assetDirectory = resolve('data/assets')) {
  const app = express(), token = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return res.status(403).json({ error: '仅允许本机访问' });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return res.status(403).json({ error: '来源不允许' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-game-token'] !== token) return res.status(403).json({ error: '本地会话已失效，请刷新页面' });
    next();
  });
  const avatarDirectory = join(assetDirectory, 'avatars');
  app.get('/api/avatar/:avatarId', async (req, res) => {
    const avatarId = safeParse(id, req.params.avatarId);
    for (const [ext, type] of [['png','image/png'],['jpg','image/jpeg'],['webp','image/webp']] as const) {
      try { const bytes = await readFile(join(avatarDirectory, `${avatarId}.${ext}`)); res.type(type).send(bytes); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    res.status(404).json({ error: '头像不存在' });
  });
  app.post('/api/avatar/:entityId', express.raw({ type: ['image/png','image/jpeg','image/webp'], limit: '5mb' }), async (req, res) => {
    const entityId = safeParse(id, req.params.entityId);
    const gameId = String(req.headers['x-game-id'] ?? '');
    const expectedRevision = Number(req.headers['x-game-revision']);
    if (!gameId || !Number.isInteger(expectedRevision)) throw new GameError('头像上传缺少当前游戏版本信息');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) throw new GameError('请选择有效图片');
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0];
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : null;
    if (!ext) throw new GameError('头像仅支持 PNG / JPEG / WebP');
    const magicOk = ext === 'png' ? body.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) : ext === 'jpg' ? body[0]===0xff && body[1]===0xd8 && body[2]===0xff : body.subarray(0,4).toString('ascii')==='RIFF' && body.subarray(8,12).toString('ascii')==='WEBP';
    if (!magicOk) throw new GameError('图片内容与文件类型不匹配');
    const avatarId = `avatar_${randomUUID().replaceAll('-','')}`;
    await mkdir(avatarDirectory, { recursive: true });
    const path = join(avatarDirectory, `${avatarId}.${ext}`);
    await writeFile(path, body, { flag: 'wx' });
    try { res.json(await service.setAvatar(entityId, avatarId, gameId, expectedRevision)); }
    catch (error) { await unlink(path).catch(()=>undefined); throw error; }
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/session', (_req, res) => res.json({ token, engine: service.ai.adapter.name, provider: providers?.info() ?? null }));
  app.get('/api/ai/providers', (_req, res) => res.json({ current: providers?.info() ?? null, providers: providers?.list() ?? [] }));
  app.post('/api/ai/provider', (req, res) => {
    if (!providers) throw new GameError('当前构建不支持运行时切换 AI Provider');
    const config = safeParse(providerConfigSchema, req.body);
    res.json(providers.configure(config));
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.7' }));
  app.get('/api/state', async (_req, res) => res.json(await service.view()));
  app.post('/api/new', async (req, res) => {
    const body = safeParse(z.strictObject({ description: z.string().min(1).max(12000).optional(), prompt_text: z.string().min(1).max(100000).optional(), prompt_profile: profileSchema.optional() }), req.body);
    res.json(await service.newGame(body.description, body.prompt_text, body.prompt_profile));
  });
  app.post('/api/action', async (req, res) => res.json(await service.turn(req.body)));
  app.post('/api/save', async (_req, res) => res.json(await service.checkpoint()));
  app.post('/api/load', async (_req, res) => res.json(await service.load()));
  app.post('/api/import', async (req, res) => res.json(await service.import(req.body)));
  app.post('/api/export', async (_req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="agent-game-save.json"'); res.type('json').send(await service.export()); });
  app.use(express.static(clientDirectory));
  app.use((_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const malformed = error instanceof SyntaxError || (error as { type?: string })?.type === 'entity.too.large';
    const status = error instanceof GameError ? error.status : malformed ? 400 : 503;
    res.status(status).json({ error: error instanceof GameError ? error.message : malformed ? 'JSON 无效或文件超过 2 MB' : (error instanceof Error ? error.message : '操作未完成') });
  });
  return app;
}
