import { it, expect, describe } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { handleSystemInput } from '../src/system/agent.js';
import { SystemPanel } from '../src/client/SystemPanel.js';
import { publicView } from '../src/core/state.js';
import { applyAssistantStyle } from '../src/ai/behavior.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { configureDefaultLogger, StructuredLogger } from '../src/observability/index.js';
import { sparseSetup } from './sparse-fixture.js';

/** A world with one named character, a full-body image and an empty canonical relationship graph. */
async function fixture() {
  const f = await sparseSetup();
  const save = await f.service.current();
  const player = save.entities.find(entity => entity.id === save.player_state.entity_id)!;
  const npc = save.entities.find(entity => entity.id !== player.id && entity.components.character)!;
  npc.components.identity.name = '伊芙琳';
  npc.components.character.role = '熟悉的学习伙伴';
  npc.components.location = structuredClone(player.components.location);
  npc.components.visual_assets = { images: { fullbody: 'evelyn_body' } };
  player.components.relationships = { entries: {} };
  save.last_turn = { narrative: '教室里的书还没有收完。', speaker: null, dialogue: null, choices: [], context_actions: [] };
  await f.store.write(save);
  return { ...f, save, npcId: npc.id, playerId: player.id, view: publicView(save) };
}

describe('System Agent: partial understanding, workflow routing and precise clarification', () => {
  it('A. a clear UI request enters development work and reuses the canonical relationship data', async () => {
    const f = await fixture();
    const r = await handleSystemInput(f.service, { input: '人物页显示好感度' });
    expect(r.category).not.toBe('UNKNOWN');
    expect(r.workflow).toBe('development_task');
    expect(r.directive).toMatchObject({ kind: 'extension_development' });
    const request = String(r.directive!.request);
    expect(request).toContain('展示位置：character_page');
    if (Object.keys(f.save.definition.ruleset.relationship_dimensions).length) expect(request).toContain('复用现有数据');
    expect(r.clarification ?? null).toBeNull();
    expect(String(r.message)).not.toContain('UNKNOWN');
    // A System request never advances the world.
    expect(await f.service.current()).toEqual(f.save);
  });

  it('B. an ambiguous display location is the only thing that gets asked about', async () => {
    const f = await fixture();
    const r = await handleSystemInput(f.service, { input: '请在地图人物状态的功能框里增加好感度' });
    const message = String(r.message);
    expect(r.clarification).toBe('which_surface');
    expect(r.pending_field).toBe('展示位置');
    expect(r.directive).toBeUndefined();
    expect(message).toContain('我理解的是');
    expect(message).toContain('涉及人物关系数据');
    expect(message).toContain('还缺一项：展示位置');
    expect(message).toContain('你可以直接回复');
    expect(message).toContain('只放人物页');
    expect(message).not.toContain('UNKNOWN');
    expect(r.session?.status).toBe('waiting_for_clarification');
    // The answer is merged into the same request instead of being re-read from scratch.
    const answered = await handleSystemInput(f.service, { input: '只放人物页', session_id: r.session!.session_id });
    expect(answered.session?.session_id).toBe(r.session?.session_id);
    expect(answered.workflow).toBe('development_task');
    expect(String(answered.directive?.request)).toContain('character_page');
    expect(String(answered.directive?.request)).not.toContain('map');
    expect(answered.session?.status).toBe('completed');
  });

  it('B2. answering a clarification continues the pending workflow instead of becoming a style correction', async () => {
    const f = await fixture();
    let understandingCalls = 0;
    const adapter = {
      name: 'answerer',
      generate: async (request: { prompt: string }) => {
        if (request.prompt.includes('表达层')) return { data: { message: '好的。' } };
        understandingCalls += 1;
        if (understandingCalls === 1) {
          return { data: { understood: ['你希望修改游戏界面的展示内容', '涉及人物关系数据'], requested_change: '在地图人物状态框里增加好感度', target_surfaces: ['map','character_page'], unresolved: [{ field: '显示范围', why: '只显示好感度还是全部关系维度会改变界面' }], entities: [], likely_workflow: 'development_task', side_effect_class: 'development', confidence: 0.6, correction: null, clarification: { needed: true, question: '还缺一项：显示范围。', examples: ['只显示好感度一项'] }, response_hint: null } };
        }
        return { data: { understood: ['已确认显示范围'], requested_change: '在人物页显示好感度', target_surfaces: ['character_page'], unresolved: [{ field: '展示内容', why: '显示一项还是多项' }], entities: [], likely_workflow: 'correction', side_effect_class: 'development', confidence: 0.85, correction: null, clarification: { needed: true, question: '还缺一项：展示内容。', examples: ['只显示好感度一项'] }, response_hint: null } };

      },
    };
    const service = new GameService(f.store, new AIRuntime(adapter as never), f.save.definition);
    const first = await handleSystemInput(service, { input: '请在地图人物状态的功能框里增加好感度' });
    expect(first.clarification).toBe('needs_detail');
    expect(first.pending_field).toBe('显示范围');
    const answered = await handleSystemInput(service, { input: '只显示好感度一项', session_id: first.session!.session_id });
    expect(answered.workflow).toBe('development_task');
    expect(answered.directive).toMatchObject({ kind: 'extension_development' });
    expect(String(answered.directive?.request)).toContain('character_page');
    expect(String(answered.message)).not.toContain('修正上一条风格配置');
    expect(answered.session?.status).toBe('completed');
  });

  it('C. a vague follow-up uses the session context instead of "please be specific"', async () => {

    const f = await fixture();
    const first = await handleSystemInput(f.service, { input: '你在每句话结尾加个“喵~”' });
    expect(first.category).toBe('BEHAVIOR_CONFIGURATION');
    const vague = await handleSystemInput(f.service, { input: '把那个东西改一下', session_id: first.session!.session_id });
    const message = String(vague.message);
    expect(vague.session?.status).toBe('waiting_for_clarification');
    expect(message).toContain('我理解的是');
    expect(message).toContain('你上一条处理的是');
    expect(message).toContain('还缺一项');
    expect(message).toContain('你可以直接回复');
    expect(message).not.toContain('我还不确定你的目标');
  });

  it('D. a correction moves the same configuration to the story scope', async () => {
    const f = await fixture();
    const asked = await handleSystemInput(f.service, { input: '每句话结尾加个“喵~”' });
    expect(asked.clarification).toBe('behavior_scope');
    const answered = await handleSystemInput(f.service, { input: '助手', session_id: asked.session!.session_id });
    expect(answered.session?.status).toBe('completed');
    expect((await f.service.current()).behavior_config).toHaveLength(1);
    const corrected = await handleSystemInput(f.service, { input: '不是游戏助手，是故事的最后一句' });
    const rules = (await f.service.current()).behavior_config;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ scope: 'narration', op: 'suffix', value: '喵~', application: 'final_sentence' });
    expect(String(corrected.message)).toContain('最后一句');
    expect(corrected.session?.status).toBe('completed');
    // narration scope never rewrites the assistant reply, and final_sentence decorates the last sentence only
    const save = await f.service.current();
    expect(applyAssistantStyle(save, '第一句。第二句。')).toBe('第一句。第二句。');
    expect(applyAssistantStyle({ ...save, behavior_config: [{ ...rules[0], scope: 'assistant' }] }, '第一句。第二句。')).toBe('第一句。第二句喵~。');
  });

  it('E. the System surface has a single entry until a development workflow starts', async () => {
    const f = await fixture();
    const html = renderToStaticMarkup(createElement(SystemPanel, { view: f.view, busy: false, act: () => {} }));
    expect(html).toContain('你想让系统做什么？');
    expect(html).not.toContain('你希望增加或修改什么？');
    expect(html).not.toContain('开始开发');
    expect(html).toContain('高级 / 开发详情');
    expect(html).toContain('已安装功能');
  });

  it('F. an avatar request is an asset workflow, never extension development and never a fake generation', async () => {
    const f = await fixture();
    const r = await handleSystemInput(f.service, { input: '给伊芙琳生成一个符合她设定的人物头像。' });

    expect(r.category).not.toBe('UNKNOWN');
    expect(r.workflow).toBe('media_asset');
    expect(r.directive?.kind).toBe('open_crop_editor');
    expect(r.advanced).toMatchObject({ entity_id: f.npcId, capability_gap: 'media.image_generation' });
    expect(String(r.message)).toContain('没有可用的图片生成功能');

    expect(String(r.message)).toContain('不会假装');
    expect(String(r.message)).not.toContain('已经生成好了');
    expect(String(r.message)).not.toContain('extension');

  });

  it('I. partial understanding keeps what it knows and never shows internal words', async () => {
    const f = await fixture();
    const r = await handleSystemInput(f.service, { input: '嗯……那个东西你懂的吧' });
    const message = String(r.message);
    expect(r.session?.status).toBe('waiting_for_clarification');
    expect(message).toContain('我理解的是');
    expect(message).toContain('还缺一项');
    expect(message).toContain('你可以直接回复');
    for (const leak of ['UNKNOWN','tool_id','schema','capability_gap']) expect(message).not.toContain(leak);
    expect(r.understanding?.understood?.length ?? 0).toBeGreaterThan(0);
  });

  it('I4. an understood request that matches no single tool is answered, never dismissed', async () => {
    const f = await fixture();
    const adapter = {
      name: 'unmapped',
      generate: async (request: { prompt: string }) => {
        if (request.prompt.includes('表达层')) return { data: { message: '好的。' } };
        return { data: { understood: ['你希望调整人物页上的关系信息显示方式'], requested_change: '只显示好感度', target_surfaces: ['character_page'], unresolved: [], entities: [], likely_workflow: 'module_management', side_effect_class: 'none', confidence: 0.8, correction: null, clarification: null, response_hint: null } };
      },
    };
    const service = new GameService(f.store, new AIRuntime(adapter as never), f.save.definition);
    const r = await handleSystemInput(service, { input: '只放人物页，只显示好感度一项' });
    expect(String(r.message)).toContain('你希望调整人物页上的关系信息显示方式');
    expect(String(r.message)).not.toContain('我还不确定你的目标');
    expect(r.session?.status).toBe('completed');
  });

  it('I3. a null session id is a fresh request, not a validation error', async () => {

    const f = await fixture();
    const r = await handleSystemInput(f.service, { input: '这个界面太挤了。', session_id: null as unknown as undefined });
    expect(r.category).toBe('PRODUCT_FEEDBACK');
    expect(String(r.message)).toContain('已记录这条反馈');
  });

  it('I2. an already-clear request stays deterministic with no extra model call', async () => {

    const f = await fixture();
    const r = await handleSystemInput(f.service, { input: '这个界面太挤了。' });
    expect(r.category).toBe('PRODUCT_FEEDBACK');
    expect(f.calls.filter(call => call.role === 'gm_reasoning')).toHaveLength(0);
  });
});

describe('Character-panel speech and honest System expression', () => {
  it('G. optional enrichment cannot discard the narration and the narrator sees the current scene', async () => {
    const logger = configureDefaultLogger(new StructuredLogger({ directory: null, level: 'debug' }));
    const f = await fixture();
    const prompts: string[] = [];
    const adapter = {
      name: 'narrator-probe',
      generate: async (request: { role: string; prompt: string }) => {
        prompts.push(request.prompt);
        return { data: { narrative: '她停下脚步，肩膀绷了一下，没有回头。', speaker: null, dialogue: null, choices: [], context_actions: [], patches: [{ op: 'relationship_delta', entity_id: f.playerId, target_id: f.npcId, dimension: 'affinity', delta: 1 }] }, threadId: 'narrator-thread' };
      },
    };
    const service = new GameService(f.store, new AIRuntime(adapter as never), f.save.definition);
    try {
      const view = await service.turn({ game_id: f.save.game_id, expected_revision: f.save.state_revision, request_id: randomUUID(), action: { type: 'TALK', target_id: f.npcId, parameters: { topic: '怎么，这就跑了？灰溜溜的' } } });
      expect(view.last_turn?.narrative).toBe('她停下脚步，肩膀绷了一下，没有回头。');
      expect(String(view.last_turn?.narrative)).not.toContain('交谈，话题：');
      expect(logger.entries({ event: 'enrichment.dropped' })).toHaveLength(1);
      expect(logger.entries({ event: 'enrichment.dropped' })[0].metadata).toMatchObject({ op: 'relationship_delta' });
      const prompt = prompts.at(-1)!;
      expect(prompt).toContain('scene_context');
      expect(prompt).toContain('怎么，这就跑了');
      expect(prompt).toContain('教室里的书还没有收完');
      expect(((await service.current()).entities.find(entity => entity.id === f.playerId)!.components.relationships?.entries ?? {})).toEqual({});
    } finally { configureDefaultLogger(new StructuredLogger({ directory: null })); }
  });

  it('G2. a real narration failure falls back to prose, never to the tool summary', async () => {
    const logger = configureDefaultLogger(new StructuredLogger({ directory: null, level: 'debug' }));
    const f = await fixture();
    const adapter = { name: 'broken-narrator', generate: async () => { throw Error('provider unavailable'); } };
    const service = new GameService(f.store, new AIRuntime(adapter as never), f.save.definition);
    try {
      const view = await service.turn({ game_id: f.save.game_id, expected_revision: f.save.state_revision, request_id: randomUUID(), action: { type: 'TALK', target_id: f.npcId, parameters: { topic: '怎么，这就跑了？灰溜溜的' } } });
      const narrative = String(view.last_turn?.narrative ?? '');
      expect(narrative).not.toContain('交谈，话题：');
      expect(narrative).not.toContain('affinity');
      expect(narrative).toContain('伊芙琳');
      expect(logger.entries({ event: 'narration.failed' })).toHaveLength(1);
      // the deterministic action still committed short time
      expect((await service.current()).runtime.time).not.toEqual(f.save.runtime.time);
    } finally { configureDefaultLogger(new StructuredLogger({ directory: null })); }
  });

  it('H. a failed expression call keeps the real result and never rolls it back', async () => {
    const f = await fixture();
    const before = await f.service.current();
    const done = await handleSystemInput(f.service, { input: '我不需要生活模式了。' });
    expect(String(done.message)).toContain('已停用');
    const after = await f.service.current();
    expect(after.definition.enabled_modules).not.toContain('routine');
    expect(after.state_revision).toBeGreaterThan(before.state_revision);
    expect(done.expression).toBe('template');
  });

  it('H2. the model may phrase a real result, and the operation still stands', async () => {
    const f = await fixture();
    const adapter = {
      name: 'expressive',
      generate: async (request: { role: string; prompt: string }) => {
        if (request.prompt.includes('表达层')) return { data: { message: '生活模式已经关掉了，世界时间没有变化。' } };
        throw Error('no understanding call expected on this path');
      },
    };
    const service = new GameService(f.store, new AIRuntime(adapter as never), f.save.definition);
    const done = await handleSystemInput(service, { input: '我不需要生活模式了。' });
    expect(done.expression).toBe('model');
    expect(done.message).toBe('生活模式已经关掉了，世界时间没有变化。');
    expect((await service.current()).definition.enabled_modules).not.toContain('routine');
  });
});
