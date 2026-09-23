import type { AIAdapter, AIRequest } from './contracts.js';
export class MockAIAdapter implements AIAdapter {
  readonly name = 'mock';
  constructor(private initializer?: unknown) {}
  async generate(request: AIRequest) {
    const data = JSON.parse(request.prompt.split('\n\n').at(-1)!);
    if (request.role === 'world_initializer') {
      if (!this.initializer) throw new Error('Mock 模式不生成新世界，请加载演示世界或导入存档');
      return { data: this.initializer, threadId: 'mock-initializer' };
    }
    if (request.role === 'intent_interpreter') return { data: { type: 'WAIT', target_id: null, parameters_json: '{}', clarification: '离线模式请使用地图、人物、商店中的行动按钮。' } };
    return { data: { narrative: data.facts.join('\n'), speaker: data.action.type === 'TALK' ? data.action.target_id : null,
      dialogue: data.action.type === 'TALK' ? '很高兴见到你。我们可以聊聊这里的生活。' : null, choices: [], patches: [] }, threadId: 'mock-narrator' };
  }
}
