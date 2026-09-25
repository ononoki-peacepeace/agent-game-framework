import {displayDiagnostic,displayText} from '../shared/display.js';
import {getLogger,isLogLevel} from '../observability/index.js';
import {handleSystemInput} from '../system/agent.js';
import {planMeta} from '../system/router.js';
import {handleAgentInput} from '../agent/executor.js';
import {toolAvailability} from '../system/tools.js';
import {RoutineJobs} from '../routine/jobs.js';
import {ExtensionHost} from '../extensions/host.js';
import {DevelopmentTasks} from '../extensions/tasks.js';
import {ExtensionDevelopment} from '../extensions/development.js';
import {extensionIntent} from '../extensions/intent.js';
import {avatarCropSchema} from '../shared/avatar.js';
import {JsonStore} from '../storage/json-store.js';
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { GameError, id, profileSchema, safeParse } from '../core/schema.js';
import { providerConfigSchema, type AIProviderManager } from '../ai/providers.js';
import { z } from 'zod';
import type { GameService } from './service.js';

export interface AppNetworkOptions { allowLan?: boolean }
// Build/process marker: lets anyone confirm which dist a running 3100 server actually loaded.
const STARTED_AT = new Date().toISOString();


const unifiedInputSchema = z.strictObject({
  request_id: z.string().uuid(),
  game_id: z.string().uuid(),
  expected_revision: z.number().int().min(0),
  input: z.string().min(1).max(12000),
});

const generatedCharacterSchema = z.strictObject({
  name: z.string().min(1).max(80),
  role: z.string().max(120).default('新认识的人物'),
  description: z.string().min(1).max(4000),
  personality: z.string().max(2000).default(''),
  scenario: z.string().max(2000).default(''),
  tags: z.array(z.string().max(80)).max(12).default([]),
  visual_prompt: z.string().max(2000).default(''),
});

type GeneratedCharacter = z.infer<typeof generatedCharacterSchema>;

function wantsCharacterGeneration(input: string) {
  const text = input.trim();
  const character = /(角色|人物|npc|陌生人|同学|老师|商人|旅人|吟游诗人|贵族|朋友|邻居|店员)/i.test(text);
  const create = /(生成|创建|新增|出现|加入|安排|放进|来一个|有一个|希望.*(?:出现|有|生成)|让.*(?:出现|来|加入))/i.test(text);
  return character && create;
}

function nameHint(input: string) {
  const patterns = [/(?:叫|名叫|名字(?:叫|是)?)\s*[“\"「『]?([^，。；、\n”\"」』]{1,24})/, /[“\"「『]([^”\"」』]{1,24})[”\"」』]\s*(?:这个|的)?(?:角色|人物|npc)/i];
  for (const pattern of patterns) { const match = input.match(pattern); if (match?.[1]?.trim()) return match[1].trim(); }
  return '';
}

function fallbackCharacter(input: string, revision: number): GeneratedCharacter {
  const hinted = nameHint(input);
  return {
    name: hinted || `新角色 ${revision + 1}`,
    role: '由玩家导演指令加入世界的人物',
    description: `该人物由玩家的世界指令创建。创建要求：${input.trim()}`,
    personality: '未指定的性格、经历和关系应在后续实际互动与世界运行中逐步形成，不自动获得与玩家的特殊关系。',
    scenario: '在玩家当前所在场景进入世界。',
    tags: ['world-directive'],
    visual_prompt: '',
  };
}

async function characterFromDirective(service: GameService, input: string, view: NonNullable<Awaited<ReturnType<GameService['view']>>>) {
  const fallback = fallbackCharacter(input, view.revision);
  const adapter = service.ai?.adapter as unknown as { name?: string; generate?: (request: unknown) => Promise<unknown> };
  if (!adapter?.generate || adapter.name === 'mock') return fallback;
  const currentLocation = view.locations.find(location => location.id === String(view.entities.find(entity => entity.id === view.player_id)?.components.location?.location_id));
  const existingNames = view.entities.filter(entity => entity.components.identity).map(entity => String(entity.components.identity?.name ?? entity.id)).slice(0, 80);
  const prompt = [
    '你是持续世界游戏的角色生成器。玩家此刻给的是世界/导演指令，不是玩家角色本人做出的行动。',
    '只生成一个适合当前世界的新人物。不要替玩家建立亲密关系，不要改写已有角色或既有事实。',
    `世界：${view.title}`,
    `世界简介：${view.description}`,
    `当前地点：${currentLocation?.name ?? '未知'}${currentLocation?.description ? ` — ${currentLocation.description}` : ''}`,
    `已有人物名（避免重复）：${existingNames.join('、')}`,
    `玩家指令：${input.trim()}`,
    'visual_prompt 只描述角色外观，强调与已有角色在发色、发型、服饰、体型、年龄气质和姿势上有辨识度；它只是未来图像生成的提示，不代表图片已经生成。',
  ].join('\n');
  try {
    const raw = await adapter.generate({ role: 'gm_reasoning', prompt, schema: generatedCharacterSchema });
    const candidate = (raw && typeof raw === 'object' && 'data' in raw) ? (raw as { data: unknown }).data : raw;
    const parsed = generatedCharacterSchema.safeParse(candidate);
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function characterCardFromDraft(draft: GeneratedCharacter, directive: string) {
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: draft.name,
      description: `${draft.role}\n\n${draft.description}`.trim(),
      personality: draft.personality,
      scenario: draft.scenario,
      first_mes: '', mes_example: '', creator_notes: `Created from world directive: ${directive}`,
      system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: draft.tags,
      creator: 'Agent Game Framework', character_version: '1.0',
      extensions: { agent_game_framework: { generated_from_world_directive: true, visual_prompt: draft.visual_prompt } },
    },
  };
}

function requestHostname(hostHeader: string) {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return host.replace(/:\d+$/, '');
}
function privateLanIPv4(hostname: string) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}
function allowedHost(hostHeader: string, allowLan: boolean) {
  const hostname = requestHostname(hostHeader);
  return hostname === 'localhost' || hostname === '127.0.0.1' || (allowLan && privateLanIPv4(hostname));
}


export function createApp(service: GameService, clientDirectory = resolve('dist/client'), providers?: AIProviderManager, assetDirectory = resolve('data/assets'), network: AppNetworkOptions = {}) {
  const app = express(), token = randomBytes(32).toString('hex'), allowLan = network.allowLan === true;
  const jobs=new RoutineJobs(service,service.storage instanceof JsonStore?service.storage.directory:undefined);
  const extensions=new ExtensionHost(service,resolve(service.storage instanceof JsonStore?service.storage.directory:join(assetDirectory,'..'),'extensions'));
  const development=new ExtensionDevelopment(extensions);
  const developmentTasks=new DevelopmentTasks(development);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host ?? '';
    if (!allowedHost(host, allowLan)) return res.status(403).json({ error: allowLan ? '仅允许本机或私有局域网地址访问' : '仅允许本机访问' });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== host.toLowerCase()) return res.status(403).json({ error: '来源不允许' });
      } catch { return res.status(403).json({ error: '来源不允许' }); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-game-token'] !== token) return res.status(403).json({ error: '本地会话已失效，请刷新页面' });
    next();
  });
  const avatarDirectory = join(assetDirectory, 'avatars');
  const visualDirectory = join(assetDirectory, 'visuals');
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
    try { const crop=req.headers['x-avatar-crop']?safeParse(avatarCropSchema,JSON.parse(String(req.headers['x-avatar-crop']))):undefined;res.json(await service.setAvatar(entityId, avatarId, gameId, expectedRevision,crop)); }
    catch (error) { await unlink(path).catch(()=>undefined); throw error; }
  });
  app.post('/api/avatar/:entityId/clear', express.json({ limit: '16kb' }), async (req, res) => {
    const entityId = safeParse(id, req.params.entityId);
    const body = safeParse(z.strictObject({ game_id: z.string().uuid(), expected_revision: z.number().int().min(0) }), req.body);
    const before = await service.view();
    if (!before) throw new GameError('当前没有已载入的世界');
    const entity = before.entities.find(item => item.id === entityId);
    if (!entity) throw new GameError('人物不存在');
    const oldAvatarId = typeof entity.components.identity?.avatar_id === 'string' ? entity.components.identity.avatar_id : '';
    const setter = service.setAvatar.bind(service) as unknown as (entityId:string, avatarId:string|null, gameId:string, expectedRevision:number)=>Promise<unknown>;
    const next = await setter(entityId, null, body.game_id, body.expected_revision);
    if (oldAvatarId) for (const ext of ['png','jpg','webp']) await unlink(join(avatarDirectory, `${oldAvatarId}.${ext}`)).catch(()=>undefined);
    res.json(next);
  });

  app.get('/api/visual/:assetId', async (req, res) => {
    const assetId = safeParse(id, req.params.assetId);
    for (const [ext, type] of [['png','image/png'],['jpg','image/jpeg'],['webp','image/webp']] as const) {
      try { const bytes = await readFile(join(visualDirectory, `${assetId}.${ext}`)); res.type(type).send(bytes); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    res.status(404).json({ error: '人物图片不存在' });
  });
  app.post('/api/visual/:entityId/:slot', express.raw({ type: ['image/png','image/jpeg','image/webp'], limit: '8mb' }), async (req, res) => {
    const entityId = safeParse(id, req.params.entityId);
    const slot = safeParse(id, req.params.slot);
    const gameId = String(req.headers['x-game-id'] ?? '');
    const expectedRevision = Number(req.headers['x-game-revision']);
    if (!gameId || !Number.isInteger(expectedRevision)) throw new GameError('人物图片上传缺少当前游戏版本信息');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) throw new GameError('请选择有效图片');
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0];
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : null;
    if (!ext) throw new GameError('人物图片仅支持 PNG / JPEG / WebP');
    const magicOk = ext === 'png' ? body.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) : ext === 'jpg' ? body[0]===0xff && body[1]===0xd8 && body[2]===0xff : body.subarray(0,4).toString('ascii')==='RIFF' && body.subarray(8,12).toString('ascii')==='WEBP';
    if (!magicOk) throw new GameError('图片内容与文件类型不匹配');
    const assetId = `visual_${randomUUID().replaceAll('-','')}`;
    await mkdir(visualDirectory, { recursive: true });
    const path = join(visualDirectory, `${assetId}.${ext}`);
    await writeFile(path, body, { flag: 'wx' });
    try { res.json(await service.setVisualAsset(entityId, slot, assetId, gameId, expectedRevision)); }
    catch (error) { await unlink(path).catch(()=>undefined); throw error; }
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/session', (_req, res) => res.json({ token, engine: service.ai.adapter.name, provider: providers?.info() ?? null }));
  app.get('/api/ai/providers', (_req, res) => res.json({ current: providers?.info() ?? null, providers: providers?.list() ?? [] }));
  app.post('/api/ai/provider', async (req, res) => {
    if (!providers) throw new GameError('当前构建不支持运行时切换 AI Provider');
    const body = safeParse(z.strictObject({
      provider: providerConfigSchema.shape.provider,
      api_key: providerConfigSchema.shape.api_key,
      model: providerConfigSchema.shape.model,
      base_url: providerConfigSchema.shape.base_url,
      persist: z.boolean().optional(),
    }), req.body);
    const { persist = false, ...config } = body;
    res.json(await service.exclusive(()=>providers.configure(safeParse(providerConfigSchema, config), { persist })));
  });
  app.post('/api/ai/provider/forget', async (_req, res) => {
    if (!providers) throw new GameError('当前构建不支持运行时切换 AI Provider');
    res.json(await providers.forgetPersisted());
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.16', started_at: STARTED_AT, pid: process.pid, entry: process.argv[1] ?? null }));

  app.get('/api/logs', async (req, res) => {
    const logger = getLogger(), limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 800);
    const level = isLogLevel(req.query.level) ? req.query.level : undefined;
    const module = typeof req.query.module === 'string' ? req.query.module : undefined;
    const event = typeof req.query.event === 'string' ? req.query.event : undefined;
    const job_id = typeof req.query.job_id === 'string' ? req.query.job_id : undefined;
    const selected = (entry: { level: string; module: string; event: string }) => (!level || entry.level === level) && (!module || entry.module === module) && (!event || entry.event === event);
    const buffered = logger.entries({ level, module, event, job_id, limit });
    const entries = buffered.length ? buffered : (await logger.readHistory(limit)).filter(selected).slice(-limit);
    res.json({ level: logger.level, file: logger.filePath(), entries, traces: logger.traces(20) });
  });
  app.get('/api/state', async (_req, res) => res.json(await service.view()));
  app.post('/api/new', async (req, res) => {
    const body = safeParse(z.strictObject({ description: z.string().min(1).max(12000).optional(), prompt_text: z.string().min(1).max(100000).optional(), prompt_profile: profileSchema.optional() }), req.body);
    res.json(await service.newGame(body.description, body.prompt_text, body.prompt_profile));
  });
  app.post('/api/input', async (req, res) => {
    const body = safeParse(unifiedInputSchema, req.body);
    const ext=extensionIntent(body.input);if(ext){if(ext.kind==='extension_open'){const installed=(await extensions.list()).find(e=>e.manifest.template===ext.template&&e.can_open);if(installed){res.json({...ext,extension_id:installed.id});return;}throw new GameError('此场景没有已启用的对应扩展；请先开发安装，并到适用地点游玩');}res.json(ext);return;}
    const routineText=body.input.trim();
    if(!/而且|然后|并且|同时|顺便/.test(routineText)&&/^(?:继续(?:按.*(?:计划|安排))?(?:生活|日常)|继续按计划生活|就这样正常生活下去|按照原来的安排继续)/.test(routineText)){
      const save=await service.current(),routine=save.entities.find(e=>e.id===save.player_state.entity_id)?.components.routine;
      if(!routine?.pattern||routine.pattern==='未设置'){const view=await service.view();res.json({...view,notices:['尚未设置生活模式；可以先在右侧保存长期计划，也可以正常逐回合游戏。']});return;}
      res.status(202).json(await jobView(await jobs.start({request_id:body.request_id,game_id:body.game_id,expected_revision:body.expected_revision,action:{type:'CONTINUE_ROUTINE',parameters:{}}})));return;
    }
    // Meta requests never run as world actions: point the player at the System surface instead.
    {const current=await service.view();
     const meta=current?planMeta(body.input,current.capabilities):null;
     if(meta&&meta.category!=='UNKNOWN'&&meta.category!=='IN_WORLD_INPUT'){current!.notices.push('这看起来是游戏外请求，请在右侧「系统」面板中提交；它不会推进世界，也不会被当作角色台词。');res.json(current);return;}
     // In-world agent: queries and navigation are answered read-only (no turn, no time, no event RNG).
     if(current&&!wantsCharacterGeneration(body.input)){res.json(await handleAgentInput(service,body,(request)=>jobs.start(request)));return;}}
    if (!wantsCharacterGeneration(body.input)) { res.json(await service.turn(body)); return; }
    const view = await service.view();
    if (!view) throw new GameError('当前没有已载入的世界');
    const draft = await characterFromDirective(service, body.input, view);
    const card = characterCardFromDraft(draft, body.input);
    res.json(await service.importCharacterCard(card, body.game_id, body.expected_revision));
  });
  const jobView=async(job:Awaited<ReturnType<RoutineJobs['get']>>)=>{if(!job)return null;const view=await service.view();if(view&&view.game_id!==job.game_id)return null;return {...job,message:displayDiagnostic(job.message,view?.entities??[],view?.locations??[])};};
  app.post('/api/routine/run',async(req,res)=>res.status(202).json(await jobView(await jobs.start(req.body))));
  app.get('/api/routine/jobs',async(_req,res)=>res.json(await jobView(await jobs.get())));
  app.get('/api/routine/jobs/:id',async(req,res)=>res.json(await jobView(await jobs.get(req.params.id))));
  app.post('/api/routine/jobs/:id/cancel',async(req,res)=>res.json(await jobView(await jobs.cancel(req.params.id))));
  app.post('/api/calendar',async(req,res)=>res.json(await service.configureCalendar(req.body.calendar,req.body.game_id,req.body.expected_revision)));
  app.post('/api/routine/tasks/:id/acknowledge',async(req,res)=>{
    const body=safeParse(z.strictObject({game_id:z.string().uuid(),expected_revision:z.number().int().min(0),outcome:z.enum(['completed','cancelled']).default('completed')}),req.body);
    res.json(await service.acknowledgeTask(req.params.id,body.game_id,body.expected_revision,body.outcome));
  });

  app.post('/api/action', async (req, res) => {
    if(['START_ROUTINE','CONTINUE_ROUTINE'].includes(req.body?.action?.type)){res.status(202).json(await jobs.start(req.body));return;}
    res.json(await service.turn(req.body));
  });
  app.get('/api/modules',async(_req,res)=>res.json(await service.modules()));
  app.get('/api/system/tools',async(_req,res)=>{const info=await service.modules();res.json(toolAvailability(info.capabilities));});
  app.post('/api/system',async(req,res)=>{
    if(req.body.development_task_id){
      const task=await developmentTasks.revise(String(req.body.development_task_id),String(req.body.input??''));
      return res.json({category:'EXTENSION_REQUEST',tool_id:'extension.create',side_effect_level:'development',needs_confirmation:false,message:task.message,directive:{kind:'extension_development',task_id:task.id,request:task.original_request}});
    }
    const result=await handleSystemInput(service,req.body);
    if(result.directive?.kind==='extension_development'){
      const task=await developmentTasks.start({request_id:randomUUID(),request:String(result.directive.request)});
      result.directive.task_id=task.id;result.message=task.message;
      if(result.session)result.session.development_job_id=task.id;
    }
    res.json(result);
  });
  app.get('/api/development/tasks',async(_req,res)=>res.json(await developmentTasks.list()));
  app.post('/api/development/tasks',async(req,res)=>res.status(202).json(await developmentTasks.start(req.body)));
  app.get('/api/development/tasks/:id',async(req,res)=>res.json(await developmentTasks.get(req.params.id)));
  app.post('/api/development/tasks/:id/revise',async(req,res)=>res.json(await developmentTasks.revise(req.params.id,String(req.body.request??''))));
  app.post('/api/development/tasks/:id/resume',async(req,res)=>res.json(await developmentTasks.resume(req.params.id)));
  app.post('/api/development/tasks/:id/cancel',async(req,res)=>res.json(await developmentTasks.cancel(req.params.id)));
  app.post('/api/development/tasks/:id/approve-core',async(req,res)=>res.json(await developmentTasks.approveCore(req.params.id,req.body.confirmed)));
  app.post('/api/development/tasks/:id/install',async(req,res)=>res.json(await developmentTasks.install(req.params.id,req.body)));
  app.post('/api/modules/:command',async(req,res)=>res.json(await service.manageModule(req.body,safeParse(z.enum(['enable','disable','remove']),req.params.command))));
  app.get('/api/extensions',async(_req,res)=>res.json(await extensions.list()));
  app.get('/api/extensions/development',async(_req,res)=>res.json(await development.get()));
  app.post('/api/extensions/development',async(req,res)=>res.status(202).json(await development.start(req.body)));
  app.post('/api/extensions/development/:id/cancel',async(req,res)=>res.json(await development.cancel(req.params.id)));
  app.post('/api/extensions/development/:id/install',async(req,res)=>res.json(await development.install(req.params.id,req.body)));
  app.post('/api/extensions/:id/action',async(req,res)=>res.json(await extensions.act(req.params.id,req.body)));
  app.post('/api/extensions/:id/:command',async(req,res)=>res.json(await extensions.manage(req.params.id,req.body,safeParse(z.enum(['enable','disable','rollback','uninstall']),req.params.command))));
  app.post('/api/save', async (_req, res) => res.json(await service.checkpoint()));
  app.post('/api/load', async (_req, res) => res.json(await service.load()));
  app.post('/api/import', async (req, res) => res.json(await service.import(req.body)));
  app.post('/api/character-card/import', async (req, res) => {
    const body = safeParse(z.strictObject({ game_id: z.string().uuid(), expected_revision: z.number().int().min(0), card: z.unknown() }), req.body);
    res.json(await service.importCharacterCard(body.card, body.game_id, body.expected_revision));
  });
  app.post('/api/export', async (_req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="agent-game-save.json"'); res.type('json').send(await service.export()); });
  app.use(express.static(clientDirectory));
  app.use((_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(async (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const malformed = error instanceof SyntaxError || (error as { type?: string })?.type === 'entity.too.large';
    const status = error instanceof GameError ? error.status : malformed ? 400 : 503;
    const publicState=await service.view().catch(()=>null);
    const human=(text:string)=>displayDiagnostic(text,publicState?.entities??[],publicState?.locations??[]);
    res.status(status).json({ error: human( error instanceof GameError ? error.message : malformed ? 'JSON 无效或文件超过 2 MB' : (error instanceof Error ? error.message : '操作未完成')) });
  });
  return app;
}
