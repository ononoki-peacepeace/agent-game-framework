import {routinePlanSchema} from '../routine/schema.js';
import {characterContext,continuityGuidance,narrativeHealth,assertNotRefusal} from './narrative-health.js';
import {isActivePerception} from '../agent/perception.js';
import {groundingContext,validateReferences} from '../routine/grounding.js';
import { routineResultSchema, routinePolicy } from './routine.js';
import { z } from 'zod';
import type { AIAdapter, AIRole, AIResult } from './contracts.js';
import { intentResultSchema, narrativeResultSchema, worldInitializationSchema } from './contracts.js';
import { composePrompt } from './profiles.js';
import { freeformSchema, needsFreeform, knownDestination, localDestination, localDurationIntent, parseFreeformProposal } from '../core/freeform.js';
import { compileWorld, emptyWorld } from './authoring.js';
import { blankWorldIntent } from '../shared/world-intent.js';
import { contextEnvelope } from '../system/context-envelope.js';
import { behaviorFragment } from './behavior.js';
import { relationshipSummary } from '../shared/relationship.js';
import { distinctChoiceIndices } from './choice-diversity.js';
import {executableChoiceIndices} from '../core/choice-availability.js';
import { resolveEntities } from '../agent/entities.js';
import { normalizeProviderCollections,pruneUnknownKeys } from './provider-schema.js';
import { failureReason, isTruncationFailure } from './failures.js';
import { assert, safeParse, type Action, type SavePackage, type profileSchema } from '../core/schema.js';
import { newSave, publicView } from '../core/state.js';
import { createRegistry } from '../modules/index.js';
import { observe, errorText } from '../observability/index.js';
import { defaultRoleplayConfig, roleplayPolicyFragment } from '../narrative/policy.js';
import type {RoleplayConfig} from '../narrative/schema.js';
import {reviewWorldNovelty} from '../world/novelty.js';
import {WorldCandidateError,normalizeWorldCandidate,worldCandidateIssues,projectWorldRepair,projectNoveltyRepair,projectSemanticRepair,publicWorldCreationFailure,type WorldIssue} from './world-initializer-repair.js';

// Per-role output budgets. Structured routine output legitimately needs more room than a narrator line,
// and a truncated document is never accepted.
const outputBudget: Record<AIRole, number> = { world_initializer: 24000, intent_interpreter: 4000, narrator: 6000, gm_reasoning: 16000, routine_compiler: 24000 };
export function narrativeBudget(input:{action_type:string;fact_count:number;location_transitions:number;player_words_length:number;action_count?:number;elapsed_minutes?:number;npc_interactions?:number;observable_changes?:number;narrative_mode?:'minimal'|'standard'|'story_focused'}){
  const weight=Math.min(4,input.fact_count)+input.location_transitions*2+Math.min(3,Math.max(0,(input.action_count??1)-1))*2+
    Math.min(2,input.npc_interactions??0)+Math.min(2,Math.floor(input.player_words_length/80))+
    ((input.elapsed_minutes??0)>=5?1:0)+((input.observable_changes??0)>=3?1:0)+(input.narrative_mode==='story_focused'?1:0);
  return weight>=9?'extended':weight>=4?'long':weight>=2?'medium':'short';
}
export function narrativeCharacterLimit(level:ReturnType<typeof narrativeBudget>,outputTokens:number,mode:'minimal'|'standard'|'story_focused'='standard'){
  const desired={short:220,medium:480,long:950,extended:1450}[level]*(mode==='minimal'?.65:mode==='story_focused'?1.2:1);
  return Math.min(Math.floor(desired),Math.max(80,Math.floor((outputTokens-500)/2)));
}
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
      ? [...(save?[roleplayPolicyFragment(role,save.definition.roleplay_config??defaultRoleplayConfig())]:[]),...behaviorFragment(save, role), ...(save ? createRegistry(save.definition.enabled_modules).modules.all().flatMap(([, m]) => m.prompt ? [m.prompt] : []) : [])]
      : [];
    this.metrics.requests++;if(role==='routine_compiler')this.metrics.compiler_calls++;
    const provider=this.adapter.providerInfo?.()??{},prompt=composePrompt(profile,role,data,fragments),threadId=save?.ai.threads[threadKey],begin=performance.now();
    const tokenCap=Math.min(outputBudget[role],provider.maxOutputTokens??outputBudget[role]);
    const base={provider:provider.provider??this.adapter.name,model:provider.model??null,role,thread_id:threadId??null,prompt_chars:prompt.length,max_output_tokens:tokenCap};
    const jsonSchema = z.toJSONSchema(schema);
    observe('debug','routine.ai.request',{module:'ai',metadata:base});
    let result:AIResult|undefined,retry_count=0;
    for(let attempt=0;attempt<(retryTruncated?2:1)&&!result;attempt++){
      const attemptPrompt=attempt===0?prompt:`${prompt}\n\n${terseRetryInstruction}`;
      const started=performance.now();
      try { result = await this.adapter.generate({ role, prompt: attemptPrompt, schema: jsonSchema, threadId, signal, maxOutputTokens: tokenCap }); }
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
      const payload = pruneUnknownKeys(role==='narrator'?normalizeProviderCollections('narrator',result.data):role==='world_initializer'?normalizeWorldCandidate(result.data):result.data, jsonSchema, 'root', dropped);
      if(dropped.length)observe('warn','ai.unknown_keys_dropped',{module:'ai',metadata:{role,keys:dropped.slice(0,8)}});
      if(role==='world_initializer'){
        const issues=worldCandidateIssues(payload);
        if(issues.length)throw new WorldCandidateError(payload,issues);
      }
      parsed = safeParse(schema, payload);
    }
    catch(error){
      const duration_ms=performance.now()-begin;
      this.last={role,provider:base.provider,model:base.model,status:'failed',duration_ms,reason:'schema',usage:result.usage??null,retry_count};
      observe('error','routine.ai.failed',{module:'ai',duration_ms,metadata:{...base,thread_id:result.threadId??threadId??null,reason:'schema',retry_count,stage:'schema',detail:error instanceof WorldCandidateError?'world candidate validation':errorText(error)}});
      if(role==='narrator')throw new Error('Narrator structured result failed validation', {cause:error});
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
    const result=await this.adapter.generate({role:'intent_interpreter',schema:z.toJSONSchema(schema),maxOutputTokens:6000,prompt:'你是玩家可见状态的多目标规划器。只输出 JSON，不执行行动。以玩家这次输入的主要意图为准；之前正在交谈只是语境，不能把购买、移动、观察或物品操作改写成 TALK。购买必须保留交易完成目标，询价或交谈不能代替 BUY receipt。将每个问题/动作拆成独立 goal；跨地点行动不可把到达目的地当作后续购物或观察已完成。为每个当前世界步骤建议 operation_hint：move、purchase、presence_query、activity、talk、item_move 或 other；item_move 仅表示已登记物品的拿起或放下，item_destination 建议 held 或 scene；放入容器尚不由此候选结算。referent 写玩家可见的地点、人物或物品名称，不写内部 ID。这里只建议语义，程序会重新绑定并决定完成证据，不能填写完成状态或 receipt。玩家只给出期望结果、需要先发现世界中可用办法时使用 WORLD_GOAL；明确动作仍用 WORLD_ACTION。真实 depends_on 必须形成无环图。仅当玩家明确提出如果/假如/要是/若/只要/当…时/除非/…的话等条件才创建条件节点；目标在场、可达、身体状态属于执行检查，绝不能变成玩家条件。条件用独立 CONDITIONAL_INTENT 节点（familiar/present/observed_event/public_fact/unknown），then/else 子目标依赖它；先进入当前场景再依 NPC 是否叫住玩家行动时，进入为独立 WORLD_ACTION，observed_event 条件依赖进入，分支依赖条件；当前已公开事实（例如一扇门此刻可观察到锁着）用 public_fact，秘密或无法判定的条件用 unknown；不可把整句压成 MOVE 或丢掉条件。无法从玩家知识确定的喜欢/秘密条件用 unknown。明天/打算不是当前 WORLD_ACTION：使用 FUTURE_INTENT 或 SCHEDULED_INTENT，day_offset 明天=1 后天=2，放学后 window=after_school。世界内实际说话 WORLD_SPEECH，生活继续 CONTINUE_ROUTINE。查看/取消未来计划 LIST_FUTURE/CANCEL_FUTURE。目标 entity_id 只能来自给定公开实体。不要遗漏任何目标，不要填写结果或修改状态。'+JSON.stringify({input,public_state:view,recent_scene:recentScene??null})});
    return schema.parse(result.data);
  }
  async chooseAffordance<T>(view:import('../shared/contracts.js').PublicView,objective:string,candidates:unknown[],schema:z.ZodType<T>,progress?:unknown){
    const result=await this.adapter.generate({role:'intent_interpreter',schema:z.toJSONSchema(schema),maxOutputTokens:2000,prompt:'你在持续世界里替玩家推进一个开放目标。每轮只决定下一步：如果候选里确实有一个动作能继续推进 objective，返回 decision="act" 并给出候选中的 candidate_id；如果目标已经由 completed 里已经发生的步骤达成，返回 decision="done"；如果必须先由玩家做重大选择或缺少必要信息，返回 decision="clarify" 并写一个必要的 ambiguity 问题；如果当前世界条件明确阻塞目标，返回 decision="blocked" 并在 reason 里说明。绝不虚构地点、人物、工作、物品、规则或候选 id，也绝不重复 completed 里已经做过的同一个动作。JSON only.'+JSON.stringify({objective,current_time:view.time,player_id:view.player_id,progress:progress??null,candidates})});
    return schema.parse(result.data);
  }
  async initialize(description: string, profile: z.infer<typeof profileSchema>,roleplayConfig?:RoleplayConfig) {
    if(blankWorldIntent(description)){const save=newSave(emptyWorld(profile));save.last_turn={narrative:'',speaker:null,dialogue:null,choices:[],context_actions:[]};return save;}
    const authoringInput={
      description,
      opening_canonical_context:{day:1,time:'09:00',calendar_date:'1月1日',weekday:'周一',instruction:'opening 描写当前场景时必须与这些已固定的 canonical 值一致。不要自行设定其他开场时间、日期、星期或季节。路线若写具体分钟数，必须与本候选 routes.travel_minutes 一致；不确定时只写相对远近。'},
      roleplay_config:roleplayConfig??defaultRoleplayConfig(),
      background_authoring_policy:'对于适合长期叙事的世界，可建立 0–2 个 World Macro Arc；绝大多数长期冲突世界宜有一个，但纯日常或明确无主线的世界为 0。Macro Arc 是长期压力与因果承诺，不是最终 Boss，也不要求所有独立事件与它关联。事件种子写出 causal_basis 的七项独立因素：长期压力、行动者动机、资源约束、历史原因、社会关系、触发、意外后果；先组合因果，再形成事件。部分未来可以未定义，但已经存在的真相必须稳定。世界可信、动机成立、因果连续优先于新颖和戏剧性。禁止仅按题材复制学生会长幕后黑手、魔王复活、AI毁灭人类、好友其实是犯人等常见模板；也不要为了反套路强行反转。保留独立日常、人物事件与少量长期主轴相关事件。提交前自检 trope similarity、单一幕后来源、玩家中心化、无因果反转、人物刻板标签和与本世界已有事件重复。',
      structural_contract:'shop.cash 必须是 100–100000 的整数。discoverability.domain 是机器标识符，不是自然语言描述，格式 ^[a-zA-Z][a-zA-Z0-9_-]{0,79}$，例如 school_records、student_rumor、police_notice；证据语义保留在 description。每个有限 background_incident 的 stages 最后一个元素必须以 terminal=resolved 或 terminal=expired 结束；非末阶段 terminal=none。例如结构上可用 stages=[{id:onset,earliest_after_minutes:0,latest_after_minutes:null,required_flags:[],actor_id:null,effects:[],exposures:[],terminal:none},{id:aftermath,earliest_after_minutes:1440,latest_after_minutes:null,required_flags:[],actor_id:null,effects:[],exposures:[],terminal:resolved}]。这只是字段结构示范，不是剧情模板。',
      instruction: '玩家和每个人物都要给出 gender（只允许 male / female / nonbinary），按世界设定明确指定；只有这个世界确实没有性别概念时才填 null，不要留空，也不要靠名字或外貌猜。gender 只描述人物基本资料，不得用来决定职业、性格、能力或行为。玩家的 age 必须是整数岁数，表示世界开始时的年龄；每个人物在世界设定明确或可以合理确定时也给出 age，无法确定时填 null，绝不要根据名字、外貌或职业推断，也不要编造出生日期。age 必须与世界设定的寿命范围相容。只安装这个世界真正需要的能力（modules）。不要因为框架支持就默认安装地图/商店/装备/生活模式；省略的能力请把对应数据填 null。resolution_profile 可按题材选择 classic_d20、bell_2d6 或 percentile_d100；创建后由世界规则固定，不可每回合更换。locations/routes 只有在选择 map 时才需要给出。若选择 map，稳定、可再次进入并可交互的主要室内空间应作为带 parent_id 的地点与相应路线登记；一次性叙事方位无需建节点。'+roleplayPolicyFragment('world_initializer',defaultRoleplayConfig())+' 若 premise 存在核心谜团，在 hidden_truths 中先承诺核心答案与已经存在的关键证据；已有证据应绑定真实 location_id 或 anchor_entity_id，并填写 discoverability 的领域与难度。未能确定位置的证据保持未定位，不能被任意地点的搜索发现。普通无谜团世界可返回空数组。background_incidents 是可选的未来世界事件种子：适合持续变化的世界生成 1–3 个 dormant seed，纯空白或无合适事件可为 []；不要生成固定玩家剧情。每个 seed 的 source 为 WORLD_CREATION、created_at 为开局时间。stage 是因时间、flag 触发的世界事实状态机，不是小说章节；actor_id 只能是已给出的人物，地点必须已登记。曝光必须绑定真实地点和渠道，不能把案件自动移到玩家身边。不要生成章节表、固定结局或最终Boss。',
      module_catalog: [
        { id: 'map', name: '地图与移动', needs: 'locations/routes' },
        { id: 'characters', name: '人物' }, { id: 'relationships', name: '关系' },
        { id: 'inventory', name: '背包' }, { id: 'commerce', name: '商店与经济', needs: 'inventory' },
        { id: 'attributes', name: '属性' }, { id: 'aptitudes', name: '资质' }, { id: 'skills', name: '技能', needs: 'aptitudes' },
        { id: 'traits', name: '特质' }, { id: 'equipment', name: '装备', needs: 'inventory' },
        { id: 'quests', name: '任务' }, { id: 'routine', name: '生活模式' },
      ],
    };
    const maxRepairs=2;
    let prior:unknown=null,priorIssues:WorldIssue[]=[],revisionKind:'structure'|'novelty'|'semantic'='structure';
    for(let attempt=0;attempt<=maxRepairs;attempt++){
      const started=performance.now();
      const repairInput=attempt===0?authoringInput:{...authoringInput,original_candidate:prior,
        validation_issues:priorIssues.map(issue=>({path:issue.path,code:issue.code,current:issue.current,requirement:issue.requirement,message:issue.message})),
        instruction:authoringInput.instruction+' 这是对上一候选的受限修复。只改 validation_issues 指明的字段及其直接依赖；保留其余角色、地图、隐藏真相、事件和主题。返回完整 JSON 候选。'};
      if(attempt>0)observe('info','world_init.repair_requested',{module:'world',metadata:{retry:attempt,kind:revisionKind,issue_paths:priorIssues.map(issue=>issue.path),issue_codes:priorIssues.map(issue=>issue.code)}});
      let candidate:unknown,threadId:string|undefined;
      try{
        const response=await this.call('world_initializer',worldInitializationSchema,profile,repairInput);
        candidate=response.parsed;threadId=response.threadId;
      }catch(error){
        if(!(error instanceof WorldCandidateError))throw error;
        candidate=error.candidate;
      }
      try{
        if(attempt>0)candidate=revisionKind==='structure'?projectWorldRepair(prior,candidate,priorIssues):
          revisionKind==='novelty'?projectNoveltyRepair(prior,candidate):projectSemanticRepair(prior,candidate,priorIssues[0]?.message??'');
      }catch(error){
        observe('warn','world_init.repair_failed',{module:'world',duration_ms:performance.now()-started,metadata:{retry:attempt,category:'scope_violation',issue_paths:priorIssues.map(issue=>issue.path),reason:errorText(error)}});
        continue;
      }
      try{
        const issues=worldCandidateIssues(candidate);
        if(issues.length){
          observe('warn','world_init.validation_failed',{module:'world',duration_ms:performance.now()-started,metadata:{retry:attempt,issue_paths:issues.map(issue=>issue.path),issue_codes:issues.map(issue=>issue.code)}});
          if(attempt>0)observe('warn','world_init.repair_failed',{module:'world',metadata:{retry:attempt,category:'revalidation'}});
          prior=candidate;priorIssues=issues;revisionKind='structure';continue;
        }
        const parsed=worldInitializationSchema.parse(candidate);
        const novelty=reviewWorldNovelty(parsed);
        if(novelty.length){
          prior=parsed;priorIssues=novelty.map(issue=>({path:issue.subject_id,code:issue.kind,message:issue.reason,current:null,requirement:issue.reason}));
          revisionKind='novelty';
          observe('warn','world_init.validation_failed',{module:'world',duration_ms:performance.now()-started,metadata:{retry:attempt,issue_paths:priorIssues.map(issue=>issue.path),issue_codes:priorIssues.map(issue=>issue.code)}});
          continue;
        }
        const compiled=compileWorld(parsed,profile);
        if(roleplayConfig)compiled.roleplay_config=roleplayConfig;
        const save=newSave(compiled);
        if(threadId)save.ai.threads.world_initializer=threadId;
        save.last_turn={narrative:parsed.opening,speaker:null,dialogue:null,choices:[],context_actions:[]};
        if(attempt>0)observe('info','world_init.repair_succeeded',{module:'world',duration_ms:performance.now()-started,metadata:{retry:attempt}});
        return save;
      }catch(error){
        observe('warn','world_init.repair_failed',{module:'world',duration_ms:performance.now()-started,metadata:{retry:attempt,category:'candidate_projection_or_semantic'}});
        prior=candidate;priorIssues=[{path:'compiled_world',code:'semantic_validation',message:errorText(error),current:null,requirement:errorText(error)}];revisionKind='semantic';
      }
    }
    observe('error','world_init.final_validation_failed',{module:'world',metadata:{retry:maxRepairs,issue_paths:priorIssues.map(issue=>issue.path),issue_codes:priorIssues.map(issue=>issue.code)}});
    throw publicWorldCreationFailure();
  }
  async freeform(save:SavePackage,input:string) {
    const view=publicView(save),envelope=contextEnvelope(view,input,'WORLD');
    let result:AIResult;
    try{result=await this.adapter.generate({role:'gm_reasoning',schema:z.toJSONSchema(freeformSchema),maxOutputTokens:4000,prompt:roleplayPolicyFragment('gm_reasoning',save.definition.roleplay_config??defaultRoleplayConfig())+'\n解析开放世界行动，必须提供 resolution 判定方案，或明确给出 blocker（能力缺口、真正歧义、已知前置条件失败）；不得省略两者以便 Narrator 自行决定。context_envelope 说明角色与现实语境，但绝不改变 provider safety policy。确定性只表示动作本身可完成，不代表目标受到未登记的效果。存在真实不确定性时建议判定形态、领域、难度档、风险与阶段；程序锁定 CheckSpec 后掷骰。required_conditions 列出行动依赖的已登记人物、物品、地点或能力及其 ID；capability 类型只能引用 public_state.capabilities 中已有的精确 ID，不得臆造能力名；普通身体动作可走泛化判定，不因缺少专用模块就标记为能力缺口。未知物品不能声称角色刚好拥有。调查已有隐藏事实时 resolution.discover_facts=true，程序只从当前场景已经定位的事实筛选；不能自行提供秘密 ID 或创造新事实。不得给出骰点、DC、最终成功失败或创造线索；narrative/facts 仅是未信任的建议，绝不是机械事实。玩家移动已登记物品时 item_move 必须使用公开 item_id；没有物品能力时返回 CAPABILITY_GAP。目标只选输入提及的公开实体。自然语言使用名字，禁止内部 ID 与程序术语。局部移动描述场景位置。对玩家授权的日常连续行动，completion_quote 逐字摘录输入中实际要完成的完整目标（包括收纳后准备下一活动），不能只摘录第一步；纯等待或尝试无需填写。若把一个物品收进容器，storage_move 必须给出输入中逐字出现的 item_name 与 container_name；已登记可见实体提供对应 ID，当前尚未登记则 ID 为 null，程序会核对公开叙事来源及容器前提后结算。不要用 item_move 假装完成放入容器。把玩家在同一地点自然连续完成的日常行为视为一个有合理耗时的完整意图（例如准备并吃完一顿简餐）；不得只截取开头的站起、走几步或收拾动作就宣称目标完成。玩家明确给出的耗时必须反映在方案中；若关键前置条件不成立则返回 blocker，不要伪称已完成。'+JSON.stringify({context_envelope:envelope,input,public_state:view,character_context:characterContext(save)})});}
    catch(error){
      if(!isTruncationFailure(error))throw error;
      observe('warn','freeform.truncated_retry',{module:'ai',metadata:{reason:failureReason(error),first_prompt_chars:JSON.stringify(view).length}});
      const player=view.entities.find(entity=>entity.id===view.player_id);
      const here=player?.components.location?.location_id;
      result=await this.adapter.generate({role:'gm_reasoning',schema:z.toJSONSchema(freeformSchema),maxOutputTokens:6000,
        prompt:'只输出符合给定 JSON Schema 的简短开放行动判定。忠实于原始请求；不能执行时填写 blocker，不能编造行动已完成。保留 required_conditions、resolution 等必填字段；不要展开叙事。'+
          JSON.stringify({input,context_envelope:envelope,location:here,
            player:player?.components??null,capabilities:view.capabilities,
            local_entities:view.entities.filter(entity=>entity.components.location?.location_id===here).map(entity=>({id:entity.id,name:entity.components.identity?.name,components:entity.components})),
            locations:view.locations.map(place=>({id:place.id,name:place.name})),actions:view.actions})});
    }
    return parseFreeformProposal(normalizeProviderCollections('freeform',result.data),input);
  }
  async interpret(save: SavePackage, input: string) {
    if(isActivePerception(input))return {type:'FREEFORM_ACTION',parameters:{}};
    const hold=localDurationIntent(input,save.runtime.time,save.definition.ruleset.minutes_per_day);
    if(hold)return {type:'HOLD',parameters:hold};
    const destination=knownDestination(save,input);
    if(destination?.id===save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id)
      return {type:'FREEFORM_ACTION',parameters:{}};
    if(destination&&(!localDestination(input)||destination.name!==localDestination(input))&&!/揍|拳|踢|扔|丢|抱/.test(input))return {type:'MOVE',target_id:destination.id,parameters:{}};
    if(needsFreeform(input))return {type:'FREEFORM_ACTION',parameters:{}};
    const registry = createRegistry(save.definition.enabled_modules),view=publicView(save);
    const { parsed } = await this.call('intent_interpreter', intentResultSchema, save.definition.prompt_profile, {
      context_envelope:contextEnvelope(view,input,'WORLD'),public_state:view, input, interaction_context:view.interaction_context??null,
      instruction:'没有专用规则的普通身体动作仍可尝试，用 FREEFORM_ACTION，parameters_json 为 {}。只在玩家意图不清时澄清，不因模块缺失拒绝。',
      generic_action: {type:'FREEFORM_ACTION',parameters:{}},
      action_catalog: registry.actions.all().filter(([, a]) => (a.ui?.visibility ?? 'internal') !== 'internal').map(([type, a]) => ({ type, parameters: z.toJSONSchema(a.parameters) })),
    }, save);
    if(parsed.type==='MOVE'&&!knownDestination(save,input))return {type:'FREEFORM_ACTION',parameters:{}};
    if((!registry.actions.has(parsed.type)||(registry.actions.get(parsed.type).ui?.visibility??'internal')==='internal')&&!parsed.clarification)return {type:'FREEFORM_ACTION',parameters:{}};
    assert(!parsed.clarification, parsed.clarification ?? '行动需要澄清');
    const targetComponent=registry.actions.get(parsed.type).ui?.target_component;
    if(targetComponent&&(parsed.target_id===view.player_id||!resolveEntities(view,input).matches.some(entity=>entity.id===parsed.target_id)))return {type:'FREEFORM_ACTION',parameters:{}};
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
   async narrate(save: SavePackage, action: Action, facts: string[],receipt?:NonNullable<SavePackage['resolution_receipts']>[number],repair?:string|{reason:string;pattern_kind?:string;match_index?:number;snippet?:string;allowed_effects?:string[]},compoundReceipts?:NonNullable<SavePackage['resolution_receipts']>) {
    const view = publicView(save);
    const words=receipt?.semantic_action??String((action.parameters as {topic?:string;intent?:string;text?:string}|undefined)?.topic??(action.parameters as {intent?:string}|undefined)?.intent??'');
    const transitions=compoundReceipts?compoundReceipts.filter(step=>step.effects.includes('position')).length:
      receipt?.effects.includes('position')?1:action.type==='MOVE'?Math.max(1,facts.filter(fact=>fact.includes('移动至')).length):0;
    const elapsed=receipt?.time_cost??(action.type==='MOVE'?facts.reduce((sum,fact)=>sum+Number(fact.match(/用时\s*(\d+)\s*分钟/)?.[1]??0),0):Number((action.parameters as {minutes?:number}|undefined)?.minutes??0));
    const npcNames=view.entities.filter(entity=>entity.id!==view.player_id&&entity.components.character).map(entity=>String(entity.components.identity?.name??'')).filter(Boolean);
    const npcInteractions=Math.max(['TALK','SOCIAL_INTERACT'].includes(action.type)?1:0,npcNames.filter(name=>facts.some(fact=>fact.includes(name))).length);
    const mode=save.definition.roleplay_config?.narrative_mode??'standard';
    const budget=narrativeBudget({action_type:action.type,fact_count:facts.length,location_transitions:transitions,player_words_length:words.length,action_count:compoundReceipts?.length??Math.max(1,transitions),elapsed_minutes:elapsed,npc_interactions:npcInteractions,observable_changes:facts.length,narrative_mode:mode});
    const maxChars=narrativeCharacterLimit(budget,Math.min(outputBudget.narrator,this.adapter.providerInfo?.().maxOutputTokens??outputBudget.narrator),mode);
    const { parsed } = await this.call('narrator', narrativeResultSchema, save.definition.prompt_profile, {
      narrative_budget:{level:budget,max_narrative_characters:maxChars,approximate_target_characters:budget==='short'?Math.floor(maxChars*.45):Math.floor(maxChars*.62),guidance:(budget==='short'?'简单观察或一句回应，保持简短。':budget==='medium'?'交代行动过程、环境反馈和可见反应。':'跨场景或多步变化，请铺陈实际经过、时间感、环境反馈和已知人物的外显反应。')+`根据本次已发生的可观察变化，正文可写约 ${budget==='short'?Math.floor(maxChars*.45):Math.floor(maxChars*.62)} 字，最多 ${maxChars} 字，留足 JSON 完整结束的空间；不是字数下限，不得为篇幅制造事件、秘密或替玩家行动。`},
      world_claim_policy:{
        choices:'每个有限选项在 choice_semantics 中给出与 choices 数组相同 index 的 intent_key、immediate consequence key 与 target_id；同义且后果相同的选项只保留一个，不为凑数量添加选项。普通活动的 consequence_key 只表示活动发生，不承诺未建模的房间、任务或物品永久状态变化。涉及物品收纳的选项只能使用已登记或当前公开叙事中确实出现的原物品；必须有 inventory 能力。普通容器可由玩家选中后在结算事务中登记，不要把尚未结算的收纳写成既成事实。',
        items:'不能只在正文声称玩家持有可继续使用的物品。如果正文首次明确出现玩家持有、从容器取出或放置的普通物品，在 item_claims 中逐件列出位置；已有物品不重复创建。一次性背景碎屑无需进入背包，只有玩家关注或使用时才作为 incidental。不能提议新的证物、稀有或任务物品。若 inventory 模块不存在，item_claims 必须为空且不可声称玩家拥有未登记物品。',
        locations:'仅在 map 模块存在，且已多次出现、可再次进入且可交互的空间，才在 stable_locations 提议 parent_id 和最短已知行走分钟；一次性叙事方位不提议。不能创造隐藏地点或改写既有地图。',
      },
      public_state: view, action, facts,
      ...(receipt?.effects.includes('position')||receipt?.effects.includes('progress')||receipt?.activity||compoundReceipts?.some(step=>step.activity)?{settled_goal_visibility:{
        local_position:receipt?.effects.includes('position')?String(view.entities.find(entity=>entity.id===view.player_id)?.components.scene_position?.label??''):null,
        activity:receipt?.activity??null,
        compound_activities:compoundReceipts?.flatMap(step=>step.activity?[step.activity]:[])??[],
        progress_changes:receipt?.progress_changes??[],
        instruction:'activity 只证明角色在记录地点花费记录时间进行了该活动，可叙述过程；它不证明具体物品、位置或正式目标发生持久变化。此类变化仅能依据对应 effects 和 canonical_facts 描写。',
      }}:{}),
       ...(repair?{narrative_repair:{rejected_reason:typeof repair==='string'?repair:repair.reason,
         ...(typeof repair==='string'?{}:{rejected_pattern_kind:repair.pattern_kind??null,
           match_index:repair.match_index??null,matched_snippet:repair.snippet??null,
           allowed_effects:repair.allowed_effects??[]}),
         instruction:'上一版正文越过了程序结算边界。只根据同一 resolution_receipt.canonical_facts 和 effects 重写；不要复述被拒绝的短片段，不补造位置、物品、进度或其他 canonical mutation；保留已结算目标的可见过程。'}}:{}),
      ...(receipt?{resolution_receipt:{semantic_action:receipt.semantic_action,kind:receipt.kind,
        outcome:save.resolution_history?.find(entry=>entry.check_id===receipt.check_id)?.hidden?'unconfirmed':receipt.outcome,
        time_cost:receipt.time_cost,canonical_facts:receipt.canonical_facts,effects:receipt.effects,
        activity:receipt.activity??null,storage:receipt.storage??null,progress_changes:receipt.progress_changes??[],
        ...(compoundReceipts?{compound_steps:compoundReceipts.map(step=>({semantic_action:step.semantic_action,time_cost:step.time_cost,
          effects:step.effects,activity:step.activity??null,canonical_facts:step.canonical_facts}))}:{})},
        mechanical_claim_policy:'activity 只表示角色在 receipt.activity 指定地点、按记录时长进行了普通活动；复合行动也可引用 compound_steps 中对应的 activity。必须引用对应的“进行了活动” canonical_facts，不能表示完成具体页数、任务或其他持久变化。progress 只表示有 progress_changes 支持的持久进度，不能用 activity 代替。正文中的成功失败、物品、伤害、金钱、位置、秘密发现与随机结果，也只能改写 resolution_receipt 明确许可的事实；每条此类声明必须在 mechanical_claims 中给出对应 canonical_facts 的 fact_index。无法引用时只写动作尝试和感官环境，不要自行决定结果。'}:{}),
      character_context:characterContext(save,action.target_id), relationship_dimensions: save.definition.ruleset.relationship_dimensions,
      scene_context: {
        recent_turn: save.last_turn ?? null,
        recent_scene_history: (save.narrative_history??[]).slice(-6).map(entry=>entry.narrative.slice(0,700)),
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
          '软社交/角色扮演互动可以作为 context_actions，label 要短，intent 要明确，并填写 family（communicate/observe/approach/interact/help/use_item/follow/steal/intercept/attack）；family 是通用行为归类；若当前场景需要更贴切的一级类别，可填写 category 短名称。label 只用于点开类别后的二级具体行动，不能直接并排显示在一级。类别不是行为白名单。',
          '遵守 Prompt Profile 的年龄、同意、关系和世界规则。'
        ],
        action_catalog: view.actions.filter(a => a.visibility !== 'internal'),
      },
    }, save, undefined, parsed => ({ patch_count: parsed.patches.length, choice_count: parsed.choices.length, context_action_count: parsed.context_actions.length }));
    const actorLocation = view.entities.find(e => e.id === view.player_id)?.components.location?.location_id;
    const validTargets = new Set(view.entities.filter(e => e.id !== view.player_id && e.components.character && e.components.location?.location_id === actorLocation).map(e => e.id));
    if(parsed.interaction?.status==='active'&&!validTargets.has(parsed.interaction.target_id))parsed.interaction=null;
    parsed.context_actions = parsed.context_actions.filter(x => validTargets.has(x.target_id));
    const originalChoices=parsed.choices;
    const originalMeanings=parsed.choice_semantics??[];
    const selected=distinctChoiceIndices(originalChoices,originalMeanings,new Set(executableChoiceIndices(save,originalChoices,originalMeanings,parsed.narrative)));
    parsed.choices=selected.map(index=>originalChoices[index]);
    parsed.choice_semantics=selected.flatMap((sourceIndex,index)=>{
      const meaning=originalMeanings.find(item=>item.index===sourceIndex);
      return meaning?[{...meaning,index}]:[];
    });
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
