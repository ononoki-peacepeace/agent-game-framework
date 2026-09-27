import { describe, expect, it } from 'vitest';
import { handleSystemInput } from '../src/system/agent.js';
import { sparseSetup } from './sparse-fixture.js';

describe('player response composer', () => {
  it('keeps model response instructions internal and answers capability questions from live runtime state', async () => {
    const instruction = '用清单形式说明能力，并按类别列举，不要直接回答别的内容';
    const f = await sparseSetup(async () => ({ data: {
      understood: ['玩家想了解当前实际能力'],
      requested_change: '介绍当前能做什么',
      target_surfaces: [], unresolved: [], entities: [],
      likely_workflow: 'capability_question', side_effect_class: 'none', confidence: 0.95,
      correction: null, clarification: { needed: false, question: '', examples: [] },
      response_hint: instruction,
    } }));

    const result = await handleSystemInput(f.service, { input: '介绍一下你能做什么' });
    expect(result.message).toContain('当前启用的世界模块');
    expect(result.message).toContain('文本 AI：fixture');
    expect(result.message).toContain('图片生成 模型服务 尚未接入');
    expect(result.message).not.toContain('用清单形式');
    expect(result.message).not.toContain('按类别列举');
    expect(result.advanced).toMatchObject({ understanding_response_hint: instruction });
  });

  it('answers the same request without a model from the actual projected panels and capabilities', async () => {
    const f = await sparseSetup();
    const view = (await f.service.view())!;
    const result = await handleSystemInput(f.service, { input: '你能做什么？介绍一下功能和能力' });
    expect(result.message).toContain(view.panels[0]!.label);
    expect(result.message).toContain('当前可见面板');
    expect(result.message).toContain('图片生成 模型服务 尚未接入');
  });
});
