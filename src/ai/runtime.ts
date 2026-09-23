import { z } from 'zod';
import type { AIAdapter, AIRole } from './contracts.js';
import { intentResultSchema, narrativeResultSchema, worldInitializationSchema } from './contracts.js';
import { composePrompt } from './profiles.js';
import { compileWorld } from './authoring.js';
import { assert, safeParse, type Action, type SavePackage, type profileSchema } from '../core/schema.js';
import { newSave, publicView } from '../core/state.js';
import { createRegistry } from '../modules/index.js';

export class AIRuntime {
  constructor(readonly adapter: AIAdapter) {}
  private async call<T>(role: AIRole, schema: z.ZodType<T>, profile: z.infer<typeof profileSchema>, data: unknown, save?: SavePackage) {
    const fragments = save ? createRegistry(save.definition.enabled_modules).modules.all().flatMap(([, m]) => m.prompt ? [m.prompt] : []) : [];
    const result = await this.adapter.generate({ role, prompt: composePrompt(profile, role, data, fragments), schema: z.toJSONSchema(schema), threadId: save?.ai.threads[role] });
    const parsed = safeParse(schema, result.data);
    if (save && result.threadId) save.ai.threads[role] = result.threadId;
    return { parsed, threadId: result.threadId };
  }
  async initialize(description: string, profile: z.infer<typeof profileSchema>) {
    const { parsed, threadId } = await this.call('world_initializer', worldInitializationSchema, profile, { description });
    const save = newSave(compileWorld(parsed, profile));
    if (threadId) save.ai.threads.world_initializer = threadId;
    save.last_turn = { narrative: parsed.opening, speaker: null, dialogue: null, choices: [], context_actions: [] };
    return save;
  }
  async interpret(save: SavePackage, input: string) {
    const registry = createRegistry(save.definition.enabled_modules);
    const { parsed } = await this.call('intent_interpreter', intentResultSchema, save.definition.prompt_profile, {
      public_state: publicView(save), input,
      action_catalog: registry.actions.all().filter(([, a]) => (a.ui?.visibility ?? 'internal') !== 'internal').map(([type, a]) => ({ type, parameters: z.toJSONSchema(a.parameters) })),
    }, save);
    assert(!parsed.clarification, parsed.clarification ?? '行动需要澄清');
    return { type: parsed.type, ...(parsed.target_id ? { target_id: parsed.target_id } : {}), parameters: JSON.parse(parsed.parameters_json) };
  }
  async narrate(save: SavePackage, action: Action, facts: string[]) {
    const view = publicView(save);
    const { parsed } = await this.call('narrator', narrativeResultSchema, save.definition.prompt_profile, {
      public_state: view, action, facts, relationship_dimensions: save.definition.ruleset.relationship_dimensions,
      context_action_policy: {
        purpose: '为当前场景中的人物提供少量可选互动建议；只是建议，不代表玩家已经执行。',
        rules: [
          '仅对与玩家处于同一 location_id 的 character 生成建议。',
          '不要重复已注册 contextual action。',
          '需要战斗、偷窃、跟踪等硬机制的行为只有在 action_catalog 中已有对应正式 action 时才可作为硬动作；不要用软互动假装完成硬机制。',
          '软社交/角色扮演互动可以作为 context_actions，label 要短，intent 要明确。',
          '遵守 Prompt Profile 的年龄、同意、关系和世界规则。'
        ],
        action_catalog: view.actions.filter(a => a.visibility !== 'internal'),
      },
    }, save);
    const actorLocation = view.entities.find(e => e.id === view.player_id)?.components.location?.location_id;
    const validTargets = new Set(view.entities.filter(e => e.id !== view.player_id && e.components.character && e.components.location?.location_id === actorLocation).map(e => e.id));
    parsed.context_actions = parsed.context_actions.filter(x => validTargets.has(x.target_id));
    const socialTurn = ['TALK','SOCIAL_INTERACT'].includes(action.type);
    if (!socialTurn) { parsed.speaker = null; parsed.dialogue = null; parsed.patches = []; }
    else {
      if (parsed.speaker !== action.target_id || parsed.dialogue === null) { parsed.speaker = null; parsed.dialogue = null; }
      parsed.patches = parsed.patches.filter(p => p.entity_id === action.actor_id && p.target_id === action.target_id);
    }
    return parsed;
  }
}
