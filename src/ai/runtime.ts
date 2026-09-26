import {routinePlanSchema} from '../routine/schema.js';
import {characterContext,continuityGuidance,narrativeHealth,assertNotRefusal} from './narrative-health.js';
import {groundingContext,validateReferences} from '../routine/grounding.js';
import { routineResultSchema, routinePolicy } from './routine.js';
import { z } from 'zod';
import type { AIAdapter, AIRole, AIResult } from './contracts.js';
import { intentResultSchema, narrativeResultSchema, worldInitializationSchema } from './contracts.js';
import { composePrompt } from './profiles.js';
import { freeformSchema, needsFreeform, knownDestination, localDestination, parseFreeformProposal } from '../core/freeform.js';
import { compileWorld, emptyWorld } from './authoring.js';
import { blankWorldIntent } from '../shared/world-intent.js';
import { contextEnvelope } from '../system/context-envelope.js';
import { behaviorFragment } from './behavior.js';
import { relationshipSummary } from '../shared/relationship.js';
import { pruneUnknownKeys } from './provider-schema.js';
import { failureReason, isTruncationFailure } from './failures.js';
import { assert, safeParse, type Action, type SavePackage, type profileSchema } from '../core/schema.js';
import { newSave, publicView } from '../core/state.js';
import { createRegistry } from '../modules/index.js';
import { observe, errorText } from '../observability/index.js';

// Per-role output budgets. Structured routine output legitimately needs more room than a narrator line,
// and a truncated document is never accepted.
const outputBudget: Record<AIRole, number> = { world_initializer: 12000, intent_interpreter: 4000, narrator: 6000, gm_reasoning: 16000, routine_compiler: 24000 };
const terseRetryInstruction = '上一次响应因为长度上限被截断。请只输出必要字段：不要重复解释、不要重复计划条目、不要输出空值项，并压缩所有说明文本，同时保持 JSON Schema 合法。';
export interface AICallSummary {
  role: string; provider: string; model: string | null; status: 'ok' | 'failed';
  duration_ms: number; reason: string | null; usage: { input_tokens: number; output_tokens: number } | null; retry_count: number;
}

export class AIRuntime {
  readonly metrics={requests:0,compiler_calls:0,ai_wait_ms:0,input_tokens:0,output_tokens:0,usage_available:false};
  // Most recent provider call, for the Routine panel ("最近一次 AI: DeepSeek / failed / 12s / reason…").
  last: AICallSummary | null = null;
  constructor(readonly adapter: AIAdapter) {}
  private async call<T>(role: AIRole, schema: z.ZodType<T>, profile: z.infer<typeof profileSchema>, data: unknown, save?: SavePackage, signal?:AbortSignal, describe?:(parsed:T)=>Record<string,unknown>, threadKey: string = role, includeFragments = true, retryTruncated = true) {
    const fragments = includeFragments
      ? [...behaviorFragment(save, role), ...(save ? createRegistry(save.definition.enabled_modules).modules.all().flatMap(([, m]) => m.prompt ? [m.prompt] : []) : [])]
      : [];
    this.metrics.requests++;if(role==='routine_compiler')this.metrics.compiler_calls++;
    const provider=this.adapter.providerInfo?.()??{},prompt=composePrompt(profile,role,data,fragments),threadId=save?.ai.threads[threadKey],begin=performance.now();
    const base={provider:provider.provider??this.adapter.name,model:provider.model??null,role,thread_id:threadId??null,prompt_chars:prompt.length,max_output_tokens:outputBudget[role]};
    const jsonSchema = z.toJSONSchema(schema);
    observe('debug','routine.ai.request',{module:'ai',metadata:base});
    let result:AIResult|undefined,retry_count=0;
    for(let attempt=0;attempt<(retryTruncated?2:1)&&!result;attempt++){
      const attemptPrompt=attempt===0?prompt:`${prompt}\n\n${terseRetryInstruction}`;
      const started=performance.now();
      try { result = await this.adapter.generate({ role, prompt: attemptPrompt, schema: jsonSchema, threadId, signal, maxOutputTokens: outputBudget[role] }); }
      catch(error){
        const duration_ms=performance.now()-started,reason=failureReason(error);
        this.metrics.ai_wait_ms+=duration_ms;
        observe('error','provider.error',{module:'ai',duration_ms,metadata:{...base,aborted:signal?.aborted===true,reason,detail:errorText(error)}});
        this.last={role,provider:base.provider,model:base.model,status:'failed',duration_ms,reason,usage:null,retry_count};
        if(retryTruncated&&attempt===0&&isTruncationFailure(error)&&!signal?.aborted){
          retry_count=1;
          observe('warn','routine.ai.retry',{module:'ai',duration_ms,metadata:{...base,reason,attempt:2,note:'使用更紧凑的指令重试一次'}});
          continue;
        }
        observe('error','routine.ai.failed',{module:'ai',duration_ms,metadata:{...base,reason,retry_count,stage:'provider'}});
        throw error;
      }
      this.metrics.ai_wait_ms+=performance.now()-started;
    }
    if(!result)throw new Error('AI 调用没有返回结果');
    signal?.throwIfAborted();
    if(result.usage){this.metrics.usage_available=true;this.metrics.input_tokens+=result.usage.input_tokens;this.metrics.output_tokens+=result.usage.output_tokens;}
    let parsed:T;
    try {
      const dropped:string[]=[];
      const payload = pruneUnknownKeys(result.data, jsonSchema, 'root', dropped);
      if(dropped.length)observe('warn','ai.unknown_keys_dropped',{module:'ai',metadata:{role,keys:dropped.slice(0,8)}});
      parsed = safeParse(schema, payload);
    }
    catch(error){
      const duration_ms=performance.now()-begin;
      this.last={role,provider:base.provider,model:base.model,status:'failed',duration_ms,reason:'schema',usage:result.usage??null,retry_count};
      observe('error','routine.ai.failed',{module:'ai',duration_ms,metadata:{...base,thread_id:result.threadId??threadId??null,reason:'schema',retry_count,stage:'schema',detail:errorText(error)}});
      throw error;
    }
    if (save && result.threadId) save.ai.threads[threadKey] = result.threadId;
    const duration_ms=performance.now()-begin;
    this.last={role,provider:base.provider,model:base.model,status:'ok',duration_ms,reason:null,usage:result.usage??null,retry_count};
    observe('info','routine.ai.response',{module:'ai',duration_ms,metadata:{...base,thread_id:result.threadId??threadId??null,success:true,recovered:result.recovered===true,retry_count,usage:result.usage??null,usage_available:!!result.usage,...(describe?describe(parsed):{})}});
    return { parsed, threadId: result.threadId };
  }
  /**
   * Out-of-game System Agent understanding: one bounded, schema-bound call on its own thread, with no
   * narration style or module prompt fragments. Returns null when the provider cannot answer (missing,
   * failed or schema mismatch) so the System surface degrades to deterministic requirement extraction
   * instead of failing the player's request.
   */
  async systemAgent<T>(schema: z.ZodType<T>, profile: z.infer<typeof profileSchema>, data: unknown, save: SavePackage): Promise<T | null> {

    try { const { parsed } = await this.call('gm_reasoning', schema, profile, data, save, undefined, undefined, 'system_agent', false); return parsed; }
    catch (error) { observe('warn','system.understanding.unavailable',{module:'system',metadata:{reason:errorText(error).slice(0,240)}}); return null; }
  }
  async planGoals(view:import('../shared/contracts.js').PublicView,input:string,schema:z.ZodType,recentScene?:unknown){

    // No SavePackage, GM state, world prompt profile or previous thread is passed to the planner.
    const result=await this.adapter.generate({role:'intent_interpreter',schema:z.toJSONSchema(schema),maxOutputTokens:6000,prompt:'你是玩家可见状态的多目标规划器。只输出 JSON，不执行行动。将每个问题/动作拆成独立 goal。真实 depends_on 必须形成无环图。仅当玩家明确提出如果/假如/要是/若/只要/当…时/除非等条件才创建条件节点；目标在场、可达、身体状态属于执行检查，绝不能变成玩家条件。条件用独立 CONDITIONAL_INTENT 节点（familiar/present/unknown），then/else 子目标依赖它；无法从玩家知识确定的喜欢/秘密条件用 unknown。明天/打算不是当前 WORLD_ACTION：使用 FUTURE_INTENT 或 SCHEDULED_INTENT，day_offset 明天=1 后天=2，放学后 window=after_school。世界内实际说话 WORLD_SPEECH，生活继续 CONTINUE_ROUTINE。查看/取消未来计划 LIST_FUTURE/CANCEL_FUTURE。目标 entity_id 只能来自给定公开实体。不要遗漏任何目标，不要填写结果或修改状态。'+JSON.stringify({input,public_state:view,recent_scene:recentScene??null})});
    return schema.parse(result.data);
  }
  async initialize(description: string, profile: z.infer<typeof profileSchema>) {
    if(blankWorldIntent(description)){const save=newSave(emptyWorld(profile));save.last_turn={narrative:'',speaker:null,dialogue:null,choices:[],context_actions:[]};return save;}
    const { parsed, threadId } = await this.call('world_initializer', worldInitializationSchema, profile, {
      description,
      instruction: '只安装这个世界真正需要的能力（modules）。不要因为框架支持就默认安装地图/商店/装备/生活模式；省略的能力请把对应数据填 null。locations/routes 只有在选择 map 时才需要给出。',
      module_catalog: [
        { id: 'map', name: '地图与移动', needs: 'locations/routes' },
        { id: 'characters', name: '人物' }, { id: 'relationships', name: '关系' },
        { id: 'inventory', name: '背包' }, { id: 'commerce', name: '商店与经济', needs: 'inventory' },
        { id: 'attributes', name: '属性' }, { id: 'aptitudes', name: '资质' }, { id: 'skills', name: '技能', needs: 'aptitudes' },
        { id: 'traits', name: '特质' }, { id: 'equipment', name: '装备', needs: 'inventory' },
        { id: 'quests', name: '任务' }, { id: 'routine', name: '生活模式' },
      ],
    });

    const save = newSave(compileWorld(parsed, profile));
    if (threadId) save.ai.threads.world_initializer = threadId;
    save.last_turn = { narrative: parsed.opening, speaker: null, dialogue: null, choices: [], context_actions: [] };
    return save;
  }
  async freeform(save:SavePackage,input:string) {
    const view=publicView(save),envelope=contextEnvelope(view,input,'WORLD');
    const result=await this.adapter.generate({role:'gm_reasoning',schema:z.toJSONSchema(freeformSchema),maxOutputTokens:4000,prompt:'裁定玩家行动尝试与公开可观察后果。context_envelope 说明角色与现实语境，但绝不改变 provider safety policy。只能生成非数值伤情事实（facts 最多 4 条，每条不超过 300 字）、1至5分钟及最多一项小幅关系变化；没有关系能力则relationship=null。不得编造HP、战斗轮次、地点节点、秘密或世界规则。目标只选输入提及的公开实体；行动未必成功。自然语言使用名字，禁止内部ID与程序术语。局部移动描述场景位置。'+JSON.stringify({context_envelope:envelope,input,public_state:view,character_context:characterContext(save)})});
    const proposal=parseFreeformProposal(result.data);
    try{assertNotRefusal(proposal);}catch(error){observe('warn','narration.safety_degraded',{module:'ai',metadata:{reason:failureReason(error)}});proposal.narrative='行动尝试已经结算，具体经过略去。';}
    const refined=await this.refineNarrative(save,{narrative:proposal.narrative,dialogue:null,speaker:null,choices:[],context_actions:[],patches:[],interaction:null},proposal.facts,proposal.target_id??undefined);
    return {...proposal,narrative:refined.narrative};
  }
  async interpret(save: SavePackage, input: string) {
    const destination=knownDestination(save,input);
    if(destination&&(!localDestination(input)||destination.name!==localDestination(input))&&!/揍|拳|踢|扔|丢|抱/.test(input))return {type:'MOVE',target_id:destination.id,parameters:{}};
    if(needsFreeform(input))return {type:'FREEFORM_ACTION',parameters:{}};
    const registry = createRegistry(save.definition.enabled_modules),view=publicView(save);
    const { parsed } = await this.call('intent_interpreter', intentResultSchema, save.definition.prompt_profile, {
      context_envelope:contextEnvelope(view,input,'WORLD'),public_state:view, input, interaction_context:view.interaction_context??null,
      instruction:'没有专用规则的普通身体动作仍可尝试，用 FREEFORM_ACTION，parameters_json 为 {}。只在玩家意图不清时澄清，不因模块缺失拒绝。',
      generic_action: {type:'FREEFORM_ACTION',parameters:{}},
      action_catalog: registry.actions.all().filter(([, a]) => (a.ui?.visibility ?? 'internal') !== 'internal').map(([type, a]) => ({ type, parameters: z.toJSONSchema(a.parameters) })),
    }, save);
    if((!registry.actions.has(parsed.type)||(registry.actions.get(parsed.type).ui?.visibility??'internal')==='internal')&&!parsed.clarification)return {type:'FREEFORM_ACTION',parameters:{}};
    assert(!parsed.clarification, parsed.clarification ?? '行动需要澄清');
    return { type: parsed.type, ...(parsed.target_id ? { target_id: parsed.target_id } : {}), parameters: JSON.parse(parsed.parameters_json) };
  }
  async compileRoutine(save:SavePackage,signal?:AbortSignal) {
    const player=save.entities.find(e=>e.id===save.player_state.entity_id)!;
    const profile={...save.definition.prompt_profile,engine_policy:save.definition.prompt_profile.engine_policy.split('【当前旧档检查点】')[0]};
    const routine=player.components.routine as {pattern?:string;supplements?:string[];pattern_revision?:number};
    const source=[String(routine.pattern??'').trim(),...(routine.supplements??[]).map(item=>`补充说明：${item}`)].join('\n');
    const context=groundingContext(save);
    const { parsed } = await this.call('routine_compiler',routinePlanSchema,profile,{
      instruction:[
        '仅编译原始生活计划，绝不推进时间或生成已发生的历史。',
        '只选择 activity_catalog 中已有活动，不创造收益规则；内部引用用 ID，自然语言必须用 display name。一个睡眠/课程是一个事件段，不按小时拆分。',
        '优先级：明确的已接受日期事件 > 世界已注册 routine rule（含 duration，绝不能被玩家的近似说法覆盖） > 已保存固定安排 > 玩家的近似措辞 > 推断默认值。',
        '缺失的具体时间必须自行推断并写入 applied_assumptions：使用 activity_catalog 的 duration、已知课程/班次、daypart 默认窗口（上午 08:00-12:00、下午 13:00-17:00、晚上 18:00-21:00、放学后 16:00-20:00、约半天 09:00-15:00）以及 travel time。不要因为可以推断的时间细节请求 clarification。',
        '只有当冲突真正无法推断、且会改变玩家意图时才返回 clarification（例如同一时段两项互斥承诺）；clarification 只写一段简短说明。',
        '输出必须紧凑：不要重复同一活动，不要输出解释性长文，不要为每天重复列相同条目之外的内容。',
      ].join('\n'),
      pattern:source,
      pattern_revision:routine.pattern_revision??0,
      activity_catalog:save.definition.routine_rules?.activities??[],
      accepted_commitments:(save.routine_meta?.scheduled_tasks??[]).filter(task=>!task.resolved).map(task=>({id:task.id,label:task.label,window:task.window,at:task.at,end_at:task.end_at??null,duration:task.duration_label??null})),
      entities:context.facts.map(fact=>({id:fact.id,name:fact.name,location:fact.location})),
      daypart_defaults:{morning:'08:00-12:00',afternoon:'13:00-17:00',evening:'18:00-21:00',after_school:'16:00-20:00',half_day:'约半天'},
      current_time:save.runtime.time,
    },save,signal,parsed=>({block_count:parsed.blocks.length,clarification:Boolean(parsed.clarification),assumptions:parsed.applied_assumptions.length}));
    return {...parsed,source_revision:routine.pattern_revision??0};
  }
  async sparseEvent(save:SavePackage,maxMinutes:number,activityId:string,signal?:AbortSignal,randomResults:unknown[]=[],plannedSegment?:unknown,availableCandidates?:string[]) {
    const schema=routineResultSchema.extend({references:z.strictObject({entity_ids:z.array(z.string()),task_ids:z.array(z.string()),activity_ids:z.array(z.string())})});
    const profile={...save.definition.prompt_profile,engine_policy:save.definition.prompt_profile.engine_policy.split('【当前旧档检查点】')[0]};
    const context=groundingContext(save);
    const {parsed}=await this.call('gm_reasoning',schema,profile,{routine_policy:routinePolicy+'\n这是开放事件而非普通生活。所有既有人物/任务/项目/活动必须在references里声明，必须来自给定canonical context；不得凭空增加历史。自然语言只使用人物显示名，禁止内部ID。',canonical_context:context,canonical_state:{time:save.runtime.time},activity_id:activityId,available_candidate_ids:availableCandidates??null,plan:save.entities.find(e=>e.id===save.player_state.entity_id)!.components.routine.plan,max_minutes:maxMinutes,random_results:randomResults,planned_segment:plannedSegment??null},save,signal,parsed=>({interrupt:parsed.interrupt,activity_count:parsed.activities.length,check_count:parsed.checks.length}));
    validateReferences(save,parsed.references);
    assert(parsed.references.activity_ids.includes(activityId),'AI 未引用正在处理的活动');
    assert(parsed.activities.every(a=>a.participants.every(id=>parsed.references.entity_ids.includes(id))),'AI 活动人物缺少来源引用');
    if(availableCandidates)assert(parsed.activities.every(a=>a.participants.every(id=>id===save.player_state.entity_id||availableCandidates.includes(id))),'AI 社交人物不在本次可用候选中');
    return parsed;
  }
  async routine(save: SavePackage, maxMinutes: number, randomResults: unknown[] = [], plannedSegment?: unknown) {
    const player = save.entities.find(e => e.id === save.player_state.entity_id)!;
    const { parsed } = await this.call('gm_reasoning', routineResultSchema, save.definition.prompt_profile, {
      routine_policy: routinePolicy,
      canonical_state: { definition:save.definition, entities:save.entities, gm_state:save.gm_state, event_state:save.event_state, time:save.runtime.time, map_state:save.map_state, last_turn:save.last_turn },
      routine:player.components.routine, max_minutes:maxMinutes, random_results:randomResults, planned_segment:plannedSegment ?? null,
    }, save, undefined, parsed => ({ interrupt: parsed.interrupt, activity_count: parsed.activities.length, check_count: parsed.checks.length }));
    return parsed;
  }
  async narrate(save: SavePackage, action: Action, facts: string[]) {
    const view = publicView(save);
    const { parsed } = await this.call('narrator', narrativeResultSchema, save.definition.prompt_profile, {
      public_state: view, action, facts, character_context:characterContext(save,action.target_id), relationship_dimensions: save.definition.ruleset.relationship_dimensions,
      scene_context: {
        recent_turn: save.last_turn ?? null,
        recent_actions: (save.action_facts ?? []).slice(-3).map(entry => ({facts: entry.facts, target_id: entry.target_id, time: entry.time})),
        player_words: (action.parameters as {topic?:string;intent?:string;text?:string}|undefined)?.topic
          ?? (action.parameters as {intent?:string}|undefined)?.intent
          ?? (action.parameters as {text?:string}|undefined)?.text
          ?? null,
        target: (() => { const target = action.target_id ? view.entities.find(entity => entity.id === action.target_id) : undefined; return target ? {name: String(target.components.identity?.name ?? target.id), role: String(target.components.character?.role ?? ''), relationship: relationshipSummary(view, target).text} : null; })(),
        guidance: 'NPC 的反应必须来自当前场景与最近发生的事件；可以拒绝、沉默、被他人阻止或已经离开；只使用公开可见信息，不得泄露 GM 隐藏状态。',
      },
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
    }, save, undefined, parsed => ({ patch_count: parsed.patches.length, choice_count: parsed.choices.length, context_action_count: parsed.context_actions.length }));
    const actorLocation = view.entities.find(e => e.id === view.player_id)?.components.location?.location_id;
    const validTargets = new Set(view.entities.filter(e => e.id !== view.player_id && e.components.character && e.components.location?.location_id === actorLocation).map(e => e.id));
    if(parsed.interaction?.status==='active'&&!validTargets.has(parsed.interaction.target_id))parsed.interaction=null;
    parsed.context_actions = parsed.context_actions.filter(x => validTargets.has(x.target_id));
    const socialTurn = ['TALK','SOCIAL_INTERACT'].includes(action.type);
    if (!socialTurn) { parsed.speaker = null; parsed.dialogue = null; parsed.patches = []; }
    else {
      if (parsed.speaker !== action.target_id || parsed.dialogue === null) { parsed.speaker = null; parsed.dialogue = null; }
      parsed.patches = parsed.patches.filter(p => p.entity_id === action.actor_id && p.target_id === action.target_id);
    }
    assertNotRefusal(parsed);
    return this.refineNarrative(save,parsed,facts,action.target_id);
  }
  private async refineNarrative(save:SavePackage,first:z.infer<typeof narrativeResultSchema>,facts:string[],targetId?:string){
    const health=narrativeHealth(save,first,facts);if(!health.detected)return first;
    observe('warn','narrative.degeneration_detected',{module:'ai',metadata:health});
    try{
      const {parsed}=await this.call('narrator',narrativeResultSchema,save.definition.prompt_profile,{
        instruction:continuityGuidance+' 只改写表达，禁止重复上一轮内容。不得增加、撤销或改变给定事实、数值、关系结果或行动。patches 必须为空。',
        style_directives:behaviorFragment(save,'narrator'),fixed_outcome:{facts,first},character_context:characterContext(save,targetId),health,
      },undefined,undefined,undefined,'narrator',false,false);
      assertNotRefusal(parsed);
      observe('info','narrative.regenerated',{module:'ai',metadata:{...narrativeHealth(save,parsed,facts),attempt:1}});
      // Regeneration cannot add enrichment, choices, targets or actions. Only prose is replaced.
      return {...first,narrative:parsed.narrative,dialogue:first.speaker&&parsed.speaker===first.speaker?parsed.dialogue:first.dialogue};
    }catch(error){observe('warn','narrative.regeneration_failed',{module:'ai',metadata:{reason:failureReason(error),attempt:1}});return first;}
  }
}
