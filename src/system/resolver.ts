import { randomUUID } from 'node:crypto';
import {z} from 'zod';
import type { GameService } from '../server/service.js';
import type { PublicView, Entity } from '../shared/contracts.js';
import { publicView } from '../core/state.js';
import { resolveEntities, entityLabel } from '../agent/entities.js';
import { capabilityPlanSchema, type CapabilityPlan, type GoalSpec } from './goals.js';
import { capabilityRegistry, validateCapabilityPlan, type CapabilityRegistry } from './capabilities.js';
import {personaAuthoringSchema,authoredCharacter} from '../characters/authoring.js';
import {genderValues} from '../shared/gender.js';
import {AGE_MAX} from '../shared/age.js';
import {currentTrace} from '../observability/trace.js';
import {executeGoalControl} from '../agent/executor.js';
import {openGoalControlSchema} from '../agent/plan-schema.js';

export type UniversalResolution =
  | { handled: false }
  | { handled: true; kind: 'EXECUTED'; goal: GoalSpec; plan: CapabilityPlan; message: string; view: PublicView; details?: Record<string, unknown> }
  | { handled: true; kind: 'USER_AMBIGUITY'; goal: GoalSpec | null; question: string; candidates: string[] }
  | { handled: true; kind: 'CAPABILITY_GAP'; goal: GoalSpec; plan: CapabilityPlan; missing: string[]; message: string; recoverable?:boolean }
  | { handled: true; kind: 'EXECUTION_FAILURE'; goal: GoalSpec; plan: CapabilityPlan; message: string; retryable: boolean; recoverable?:boolean; reason?: string;view?:PublicView|null;details?:Record<string,unknown> };

const goalCoverageSchema=z.strictObject({covered:z.boolean(),uncovered:z.array(z.string().min(1).max(160)).max(8)});
const creationProfileSchema=z.strictObject({
  description:z.string().max(2000).optional(),gender:z.enum(genderValues).nullable().optional(),
  age:z.number().int().min(0).max(AGE_MAX).nullable().optional(),role:z.string().max(200).optional(),
  traits:z.array(z.string().max(100)).max(10).optional(),persona:personaAuthoringSchema.partial().optional(),
});
const creationPaths=new Set(['identity.name','identity.description','identity.gender','identity.age','character.role',
  'character.traits',...Object.keys(personaAuthoringSchema.shape).map(key=>`character.${key}`)]);
function creationProfile(goal:GoalSpec){
  const profile:Record<string,unknown>={},persona:Record<string,unknown>={};
  for(const change of goal.desired_state){
    if(change.path==='identity.description')profile.description=change.value;
    else if(change.path==='identity.gender')profile.gender=change.value;
    else if(change.path==='identity.age')profile.age=change.value;
    else if(change.path==='character.role')profile.role=change.value;
    else if(change.path==='character.traits')profile.traits=change.value;
    else if(change.path.startsWith('character.'))persona[change.path.slice('character.'.length)]=change.value;
  }
  if(Object.keys(persona).length)profile.persona=persona;
  // Values originate in GoalSpec's JSON-valued desired_state and are parsed by
  // creationProfileSchema again immediately before the transaction.
  return profile as unknown as z.infer<typeof capabilityPlanSchema>['steps'][number]['input'][string];
}
function projectedEffects(plan:CapabilityPlan){
  return plan.steps.flatMap(step=>{
    if(step.capability_id!=='entity.create')return [];
    const profile=step.input.profile&&typeof step.input.profile==='object'&&!Array.isArray(step.input.profile)
      ?step.input.profile as Record<string,unknown>:{};
    const persona=profile.persona&&typeof profile.persona==='object'&&!Array.isArray(profile.persona)
      ?profile.persona as Record<string,unknown>:{};
    return [{path:'identity.name',value:step.input.name},
      ...(['description','gender','age'] as const).filter(key=>key in profile)
        .map(key=>({path:`identity.${key}`,value:profile[key]})),
      ...(['role','traits'] as const).filter(key=>key in profile)
        .map(key=>({path:`character.${key}`,value:profile[key]})),
      ...Object.entries(persona).map(([key,value])=>({path:`character.${key}`,value}))];
  });
}

export interface UniversalRequestEnvelope { request_id?: string; expected_revision?: number;game_id?:string }
export interface ExecuteOptions {
  registry?: CapabilityRegistry;
  permissions?:string[];
  executeExternal?: (step: CapabilityPlan['steps'][number]) => Promise<unknown>;
}

const featureWish = /(?:想|希望|需要|请)(?:加|增加|新增|开发|做)(?:一个|个|套|种)?.{0,30}(?:系统|玩法|功能|面板|页面|机制|模块)/;
const stateMutation = /(?:改成|改为|设置为|换成|设成|重命名|改名)/;
const mediaOutcome = /(?:生成|制作|画|绘制).{0,20}(?:图|头像|立绘)|(?:图|头像|立绘).{0,20}(?:生成|制作|画|绘制)/;
const recurringOutcome = /(?:每周|每天|每日|每月|周[一二三四五六日天]).{0,30}(?:去|到|在|上课|开会|工作|活动)/;
const selfNaming = /^(?:我叫|以后叫我|就叫我?|把(?:我|我的角色|玩家角色)(?:的)?名字(?:改成|改为|设为|设置为)|给玩家改名为)\s*([^，,。；;！!\s]{0,120})/;
const entityCreate = /^(?:新增|添加|创建|加入)(?:一个|一位)?\s*(?:NPC|npc|人物|角色)\s*[：:「“]?([^，,。；;！!」”]{1,120})/;
const entityDelete = /^(?:删除|移除)(?:人物|角色|NPC|npc)?\s*[「“]?([^，,。；;！!」”]{1,120})/;

/** This gate only identifies outcome-shaped requests; it never selects or executes a capability. */
export function isUniversalGoalCandidate(text: string) {
  if (featureWish.test(text)) return false;
  return stateMutation.test(text) || selfNaming.test(text.trim()) || entityCreate.test(text.trim()) || entityDelete.test(text.trim()) || mediaOutcome.test(text) || recurringOutcome.test(text) || /把她改一下|把他改一下/.test(text);
}

const clean = (value: string) => value.trim().replace(/[。！？!?]+$/, '').replace(/^[“"'「]|[”"'」]$/g, '').trim();
const baseGoal = (text: string, overrides: Partial<GoalSpec>): GoalSpec => ({
  objective: text, targets: [], desired_state: [], desired_outputs: [], constraints: [], persistence: 'canonical',
  temporal: { at: null, recurrence: null }, dependencies: [], world_mutation: true, external_artifact: false,
  multi_step: false, ambiguity: null, ...overrides,
});

/** Offline extraction still produces a provider-neutral goal. Composition remains a separate step. */
export function deterministicGoal(text: string): GoalSpec | null {
  const directSelf=selfNaming.exec(text.trim());
  if(directSelf){const name=clean(directSelf[1]);return baseGoal(text,{targets:[{kind:'entity',reference:'我',entity_id:null}],desired_state:name?[{path:'identity.name',value:name,target_ref:'target'}]:[],desired_outputs:[{kind:'state_change',description:'玩家角色名称发生 canonical 变更'}],...(name?{}:{ambiguity:{question:'你希望使用哪个名字？也可以由我帮你选。'}})});}
  const created=entityCreate.exec(text.trim());
  if(created)return baseGoal(text,{targets:[{kind:'entity',reference:clean(created[1]),entity_id:null}],desired_outputs:[{kind:'entity_create',description:'在当前世界创建人物'}]});
  const deleted=entityDelete.exec(text.trim());
  if(deleted)return baseGoal(text,{targets:[{kind:'entity',reference:clean(deleted[1]).replace(/并清除.*$/,'').trim(),entity_id:null}],desired_outputs:[{kind:'entity_delete',description:'删除当前世界人物并清理可安全清理的引用'}]});
  const rename = text.match(/(?:把|将)?(.+?)(?:的)?(?:名字|姓名)(?:改成|改为|设置为|换成|设成)\s*(.+)$/)
    ?? text.match(/(?:把|将)?(.+?)(?:改名为|重命名为)\s*(.+)$/);
  if (rename) {
    const reference = clean(rename[1]).replace(/^把|^将/, '') || '我', name = clean(rename[2].split(/[，,。；;！!]/)[0]);
    if (!name) return baseGoal(text, { ambiguity: { question: '要把名字改成什么？' } });
    return baseGoal(text, {
      targets: [{ kind: 'entity', reference, entity_id: null }],
      desired_state: [{ path: 'identity.name', value: name, target_ref: 'target' }],
      desired_outputs: [{ kind: 'state_change', description: '目标人物名称发生 canonical 变更' }], multi_step: true,
    });
  }
  const balance=text.match(/(?:钱|余额|资金)(?:\s*从\s*-?\d+)?(?:改成|改为|设置为|设成|变成)\s*(-?\d+)/);
  if(balance){
    const amount=Number(balance[1]),prefix=text.slice(0,balance.index??0),named=prefix.match(/(?:把|将)\s*([^，。]{1,30}?)(?:身上|账户|钱包|的)?$/)?.[1]?.trim();
    const reference=/我|自己|主角|玩家角色/.test(prefix)?'我':clean(named??'')||'我';
    return baseGoal(text,{targets:[{kind:'entity',reference,entity_id:null}],desired_state:[{path:'wallet.balance',value:amount,target_ref:'target'}],desired_outputs:[{kind:'state_change',description:'目标人物已有货币余额发生 canonical 变更'}]});
  }
  if (mediaOutcome.test(text)) {
    const reference = clean(text.replace(/^(?:给|为)/, '').split(/(?:生成|制作|画|绘制)/)[0] || '我');
    return baseGoal(text, { targets: [{ kind: 'entity', reference, entity_id: null }], desired_outputs: [{ kind: 'media_asset', description: '生成图片资源' }, { kind: 'avatar_assignment', description: '将资源设置为同一人物头像' }], external_artifact: true, multi_step: true });
  }
  if (recurringOutcome.test(text)) {
    const target = text.match(/(?:让|请)(.+?)(?:每周|每天|每日|每月|周[一二三四五六日天])/)?.[1]?.trim() ?? '';
    const location = text.match(/(?:去|到|在)([^，。,.]{1,30})(?:开会|上课|工作|活动)/)?.[1]?.trim() ?? '';
    const recurrence = text.match(/(?:每周|每天|每日|每月|周[一二三四五六日天])[^，。,.]{0,20}/)?.[0] ?? '';
    return baseGoal(text, { targets: [{ kind: 'entity_query', reference: target || '未明确的人群', entity_id: null }, ...(location ? [{ kind: 'location' as const, reference: location, entity_id: null }] : [])], desired_outputs: [{ kind: 'schedule', description: '为匹配人物设置重复安排' }], persistence: 'recurring', temporal: { at: null, recurrence: recurrence || null }, multi_step: true, ambiguity: target ? null : { question: '要为哪些人物设置这个安排？' } });
  }
  if (/把她改一下|把他改一下/.test(text)) return baseGoal(text, { ambiguity: { question: '你想修改哪位人物的什么内容？' } });
  return null;
}

/** Compose by desired outcomes/state paths. Text wording is never used to choose a capability. */
export function composeCapabilityPlan(goal: GoalSpec): CapabilityPlan | null {
  if(goal.goal_control)return {goal,steps:[{step_id:'manage_goal',capability_id:`open_goal.${goal.goal_control.kind}`,
    input:{target:goal.goal_control.target},depends_on:[]}]};
  if (goal.ambiguity) return { goal, steps: [{ step_id: 'resolve_target', capability_id: 'entity.lookup', input: { reference: goal.targets[0]?.reference ?? '' }, depends_on: [] }] };
  if(goal.desired_outputs.some(item=>item.kind==='entity_create')){
    const explicitName=goal.desired_state.find(item=>item.path==='identity.name')?.value;
    return {goal,steps:[{step_id:'create_entity',capability_id:'entity.create',
      input:{name:typeof explicitName==='string'?explicitName:goal.targets[0]?.reference??'',profile:creationProfile(goal)},depends_on:[]}]};
  }
  if(goal.desired_outputs.some(item=>item.kind==='entity_delete'))return {goal,steps:[{step_id:'resolve_target',capability_id:'entity.lookup',input:{reference:goal.targets[0]?.reference??''},depends_on:[]},{step_id:'delete_entity',capability_id:'entity.delete',input:{},depends_on:['resolve_target']}]};
  const identityName = goal.desired_state.find(item => item.path === 'identity.name');
  if (identityName) return { goal, steps: [
    { step_id: 'resolve_target', capability_id: 'entity.lookup', input: { reference: goal.targets[0]?.reference ?? '' }, depends_on: [] },
    { step_id: 'rename_target', capability_id: 'entity.identity.rename', input: { name: identityName.value }, depends_on: ['resolve_target'] },
  ] };
  const walletBalance=goal.desired_state.find(item=>item.path==='wallet.balance');
  if(walletBalance)return {goal,steps:[
    {step_id:'resolve_target',capability_id:'entity.lookup',input:{reference:goal.targets[0]?.reference??''},depends_on:[]},
    {step_id:'set_balance',capability_id:'entity.wallet.balance.set',input:{amount:walletBalance.value},depends_on:['resolve_target']},
  ]};
  const entityField=goal.desired_state.find(item=>['identity.description','character.role'].includes(item.path));
  if(entityField)return {goal,steps:[{step_id:'resolve_target',capability_id:'entity.lookup',input:{reference:goal.targets[0]?.reference??''},depends_on:[]},{step_id:'update_entity',capability_id:'entity.update',input:{path:entityField.path,value:entityField.value},depends_on:['resolve_target']}]};
  if (goal.desired_outputs.some(item => item.kind === 'media_asset') && goal.desired_outputs.some(item => item.kind === 'avatar_assignment')) return { goal, steps: [
    { step_id: 'resolve_target', capability_id: 'entity.lookup', input: { reference: goal.targets[0]?.reference ?? '' }, depends_on: [] },
    { step_id: 'generate_image', capability_id: 'media.image.generate', input: { kind: 'avatar', description: goal.objective }, depends_on: ['resolve_target'] },
    { step_id: 'persist_asset', capability_id: 'asset.persist', input: {}, depends_on: ['generate_image'] },
    { step_id: 'assign_avatar', capability_id: 'character.avatar.assign', input: {}, depends_on: ['resolve_target', 'persist_asset'] },
  ] };
  if (goal.desired_outputs.some(item => item.kind === 'schedule')) {
    const location = goal.targets.find(item => item.kind === 'location');
    return { goal, steps: [
      { step_id: 'resolve_targets', capability_id: 'entity.query', input: { query: goal.targets.find(item => item.kind === 'entity_query')?.reference ?? '' }, depends_on: [] },
      ...(location ? [{ step_id: 'resolve_location', capability_id: 'location.resolve', input: { reference: location.reference }, depends_on: [] }] : []),
      { step_id: 'assign_schedule', capability_id: 'routine.schedule.assign', input: { recurrence: goal.temporal.recurrence }, depends_on: location ? ['resolve_targets', 'resolve_location'] : ['resolve_targets'] },
    ] };
  }
  return null;
}

function targetEntity(view: PublicView, plan: CapabilityPlan): { entity: Entity | null; candidates: Entity[] } {
  const target = plan.goal.targets.find(item => item.kind === 'entity');
  if (!target) return { entity: null, candidates: [] };
  if (target.entity_id) return { entity: view.entities.find(entity => entity.id === target.entity_id) ?? null, candidates: [] };
  if (/^(我|我自己|自己|我的|我的角色|主角|玩家角色)$/.test(target.reference)) return { entity: view.entities.find(entity => entity.id === view.player_id) ?? null, candidates: [] };
  const resolved = resolveEntities(view, target.reference);
  return { entity: resolved.confident ? resolved.matches[0] ?? null : null, candidates: resolved.matches };
}

/** Existing story commitments are never rewritten by an entity deletion. Return only a boolean, not secret text. */
function protectedEntityReference(save:Awaited<ReturnType<GameService['current']>>,entity:Entity){
  const name=String(entity.components.identity?.name??'');
  if(save.definition.entities.some(item=>item.id===entity.id))return true;
  const otherComponents=save.entities.filter(item=>item.id!==entity.id).map(item=>Object.fromEntries(Object.entries(item.components).filter(([key])=>key!=='relationships')));
  const protectedState=[save.definition,save.gm_state,save.narrative_state,save.narrative_history,save.future_intents,save.routine_meta,save.last_turn,save.interaction_context,save.extensions,save.action_facts,otherComponents];
  return protectedState.some(part=>{const serialized=JSON.stringify(part??null);return serialized.includes(`"${entity.id}"`)||Boolean(name&&serialized.includes(name));});
}

/** Preflight completes before any side effect. Canonical writes then share one receipt/revision transaction. */
function goalControlAuthorization(plan:CapabilityPlan,ordered:CapabilityPlan['steps']){
  const step=ordered[0],control=openGoalControlSchema.safeParse({kind:step?.capability_id.slice('open_goal.'.length),target:step?.input.target});
  const checks:{field:string;expected:unknown;actual:unknown;ok:boolean}[]=[];
  const check=(field:string,expected:unknown,actual:unknown,ok=actual===expected)=>checks.push({field,expected,actual,ok});
  check('steps.length',1,ordered.length);
  check('control.valid',true,control.success);
  check('goal.goal_control.present',true,Boolean(plan.goal.goal_control));
  check('control.kind',plan.goal.goal_control?.kind??null,control.success?control.data.kind:null);
  check('control.target',plan.goal.goal_control?.target??null,control.success?control.data.target:null);
  check('goal.desired_state.length',0,plan.goal.desired_state.length);
  // desired_outputs describes results; it is not an additional execution grant.
  // A state_change summary is bound to this *single typed control*. Keep it in
  // the plan for audit, rather than deleting it or parsing its prose for tools.
  // Other output kinds require their own operation and must not be swallowed.
  const independentOutputs=plan.goal.desired_outputs.map((output,index)=>({index,kind:output.kind})).filter(output=>output.kind!=='state_change');
  check('goal.desired_outputs.independent',[],independentOutputs,independentOutputs.length===0);
  check('goal.external_artifact',false,plan.goal.external_artifact);
  check('goal.dependencies.length',0,plan.goal.dependencies.length);
  check('goal.multi_step',false,plan.goal.multi_step);
  check('goal.play_action',[null,'other'],plan.goal.play_action??null,!plan.goal.play_action||plan.goal.play_action==='other');
  check('goal.targets.length',0,plan.goal.targets.length);
  check('goal.repetition.present',false,Boolean(plan.goal.repetition));
  check('goal.physical_intent.present',false,Boolean(plan.goal.physical_intent));
  check('goal.temporal.at',null,plan.goal.temporal.at);
  check('goal.temporal.recurrence',null,plan.goal.temporal.recurrence);
  return {control,checks,issues:checks.filter(check=>!check.ok)};
}
export async function executeUniversalPlan(service: GameService, plan: CapabilityPlan, envelope: UniversalRequestEnvelope = {}, options: ExecuteOptions = {}): Promise<UniversalResolution> {
  const save = await service.current(), view = service.project(save);
  if (plan.goal.ambiguity) return { handled: true, kind: 'USER_AMBIGUITY', goal: plan.goal, question: plan.goal.ambiguity.question, candidates: [] };
  const validation = validateCapabilityPlan(plan, view, options.registry ?? service.systemCapabilities,
    options.permissions?{permissions:options.permissions}:undefined);
  if (!validation.ok) return validation.kind === 'CAPABILITY_GAP'
    ? { handled: true, kind: 'CAPABILITY_GAP', goal: plan.goal, plan, missing: validation.missing, message: '当前能力还不能完整完成这个目标。可以先补齐缺少的能力，再由你明确决定是否创建开发任务。' }
    : { handled: true, kind: 'EXECUTION_FAILURE', goal: plan.goal, plan, message: '这次计划没有通过执行前校验，世界状态没有改变。请重新描述目标后再试。', retryable: false };
  if(envelope.game_id&&envelope.game_id!==save.game_id)return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,
    message:'游戏已切换，目标操作尚未执行。',retryable:false};
  if(validation.ordered.some(step=>step.capability_id.startsWith('open_goal.'))){
    const {control,checks,issues}=goalControlAuthorization(plan,validation.ordered);
    if(issues.length||!control.success){
      const reason_code='goal_control_authorization_mismatch';
      currentTrace()?.warn('system.goal_control.rejected',{metadata:{reason_code,issues}});
      return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,
        message:'目标管理操作与已确认授权不一致，尚未执行。',retryable:false,
        reason:reason_code,details:{reason_code,authorization_issues:issues}};
    }
    currentTrace()?.info('system.goal_control.authorized',{metadata:{kind:control.data.kind,target:control.data.target,
      checks,output_kinds:plan.goal.desired_outputs.map(output=>output.kind),output_scope:'single_goal_control_result'}});
    try{
      const result=await executeGoalControl(service,{game_id:save.game_id,expected_revision:envelope.expected_revision??save.state_revision,
        request_id:envelope.request_id??randomUUID(),input:plan.goal.objective},control.data);
      const details={goal_control:result.goal_control,outcome:result.outcome};
      currentTrace()?.info('system.goal_control.result',{metadata:details});
      if(!result.goal_control||['not_found','blocked'].includes(result.goal_control.status)||result.outcome.type==='engine_failure')
        return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,message:result.message,retryable:false,
          ...{view:result.view,details}};
      return {handled:true,kind:'EXECUTED',goal:plan.goal,plan,message:result.message,view:result.view!,details};
    }catch(error){return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,
      message:'目标操作没有取得可确认的提交结果，请查询当前目标状态；不会自动重复执行。',retryable:false,
      reason:error instanceof Error?error.message:String(error)};}
  }
  const resolved = targetEntity(view, plan);
  const creating=validation.ordered.some(step=>step.capability_id==='entity.create');
  if (!creating && plan.goal.targets.some(item => item.kind === 'entity') && !resolved.entity) {
    return { handled: true, kind: 'USER_AMBIGUITY', goal: plan.goal, question: resolved.candidates.length ? '有多个人物符合这个称呼，请指定是哪一位。' : '我还不能确定要修改哪位人物，请说出人物名字。', candidates: resolved.candidates.map(entityLabel) };
  }
  const mediaPlan=validation.ordered.some(step=>step.capability_id==='media.image.generate')&&validation.ordered.some(step=>step.capability_id==='character.avatar.assign');
  if(mediaPlan&&resolved.entity&&!options.executeExternal){
    try{
      const generated=await service.generateAvatar(resolved.entity.id,plan.goal.objective,save.game_id,envelope.expected_revision??save.state_revision);
      return {handled:true,kind:'EXECUTED',goal:plan.goal,plan,message:'已为'+entityLabel(resolved.entity)+'生成并设置了新头像。',view:generated.view,details:{asset_id:generated.artifact.asset_id,mime_type:generated.artifact.mime_type,provider:generated.artifact.provider,model:generated.artifact.model,provider_metadata:generated.artifact.metadata}};
    }catch(error){const reason=error instanceof Error?error.message:String(error);return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,message:'图片生成或头像设置没有完成，头像未修改。',retryable:/timeout|timed out|fetch|network/i.test(reason),reason};}
  }
  try {
    for (const step of validation.ordered) if (!['entity.lookup', 'entity.query', 'entity.create', 'entity.update', 'entity.delete', 'entity.identity.rename', 'entity.wallet.balance.set'].includes(step.capability_id)) {
      if (!options.executeExternal) throw new Error('capability executor unavailable');
      await options.executeExternal(step);
    }
    const mutation=validation.ordered.find(step=>['entity.create','entity.update','entity.delete'].includes(step.capability_id));
    if(mutation){
      const request={game_id:save.game_id,expected_revision:envelope.expected_revision??save.state_revision,request_id:envelope.request_id??randomUUID()};
      if(mutation.capability_id==='entity.create'){
        const name=String(mutation.input.name??plan.goal.targets[0]?.reference??'').trim();
        if(!name||name.length>120)return {handled:true,kind:'USER_AMBIGUITY',goal:plan.goal,question:'请说出要新增人物的名字。',candidates:[]};
        if(view.entities.some(entity=>entityLabel(entity)===name))return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,message:'这个名字已经属于现有人物；请先确认是否要修改现有人物。',retryable:false};
        const profile=creationProfileSchema.safeParse(mutation.input.profile??{});
        if(!profile.success)return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,
          message:'人物资料没有通过提交前校验，世界没有改变。',retryable:false,recoverable:true,
          reason:profile.error.issues.map(issue=>issue.path.join('.')==='gender'
            ?'identity.gender 只允许 male、female、nonbinary 或 null；未明确指定时保持 null'
            :`${issue.path.join('.')}:${issue.code}`).slice(0,6).join('; ')};
        const entityId=`npc_${randomUUID().replaceAll('-','').slice(0,24)}`;
        const next=await service.agentTransaction(request,{kind:'entity.create',name},draft=>{
          if(!draft.definition.enabled_modules.includes('characters'))throw Error('当前世界没有人物能力');
          if(draft.entities.length>=500)throw Error('人物数量已达到世界上限');
          const player=draft.entities.find(item=>item.id===draft.player_state.entity_id)!;
          draft.entities.push({id:entityId,type:'character',components:{identity:{name,
            description:profile.data.description??'',avatar_id:null,gender:profile.data.gender??null,age:profile.data.age??null},
            character:{...authoredCharacter(profile.data.role??'人物',profile.data.persona??{}),traits:profile.data.traits??[]},
            ...(player.components.location?{location:{location_id:String(player.components.location.location_id)}}:{})}});
        });
        return {handled:true,kind:'EXECUTED',goal:plan.goal,plan,message:`已在当前世界新增人物「${name}」。`,view:next};
      }
      if(mutation.capability_id==='entity.delete'&&resolved.entity){
        if(resolved.entity.id===view.player_id||protectedEntityReference(save,resolved.entity))return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,message:'这位人物关联已有世界设定或剧情记录，不能安全直接删除。你可以取消删除，或另行决定如何处理其后续出场；既有真相不会被改写。',retryable:false};
        const id=resolved.entity.id;
        const next=await service.agentTransaction(request,{kind:'entity.delete',id},draft=>{
          draft.entities=draft.entities.filter(item=>item.id!==id);
          for(const entity of draft.entities){const relations=entity.components.relationships as {entries?:Record<string,unknown>}|undefined;if(relations?.entries)delete relations.entries[id];}
        });
        return {handled:true,kind:'EXECUTED',goal:plan.goal,plan,message:`已删除人物「${entityLabel(resolved.entity)}」及其关系记录。`,view:next};
      }
      if(mutation.capability_id==='entity.update'&&resolved.entity){
        const path=String(mutation.input.path??''),value=String(mutation.input.value??'').trim();
        if(!['identity.description','character.role'].includes(path)||!value||value.length>1000)return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,message:'这项人物资料尚不能安全修改，世界状态没有改变。',retryable:false};
        const next=await service.agentTransaction(request,{kind:'entity.update',id:resolved.entity.id,path,value},draft=>{const entity=draft.entities.find(item=>item.id===resolved.entity!.id)!;const [component,key]=path.split('.');if(!entity.components[component])throw Error('人物缺少所需资料');entity.components[component][key]=value;});
        return {handled:true,kind:'EXECUTED',goal:plan.goal,plan,message:`已更新「${entityLabel(resolved.entity)}」的人物资料。`,view:next};
      }
    }
    const rename = validation.ordered.find(step => step.capability_id === 'entity.identity.rename');
    if (rename && resolved.entity) {
      const name = String(rename.input.name ?? plan.goal.desired_state.find(item => item.path === 'identity.name')?.value ?? '').trim();
      if (!name) return { handled: true, kind: 'USER_AMBIGUITY', goal: plan.goal, question: '要把名字改成什么？', candidates: [] };
      const request = { game_id: save.game_id, expected_revision: envelope.expected_revision ?? save.state_revision, request_id: envelope.request_id ?? randomUUID() };
      const next = await service.agentTransaction(request, { kind: 'capability_plan', objective: plan.goal.objective, steps: plan.steps.map(step => ({ step_id: step.step_id, capability_id: step.capability_id, input: step.input })) }, draft => {
        const entity = draft.entities.find(item => item.id === resolved.entity!.id);
        if (!entity?.components.identity) throw new Error('目标人物没有可修改的身份资料');
        const identity = entity.components.identity as { name: string; previous_names?: string[] };
        const old = String(identity.name ?? '');
        // Renaming keeps the identity history so an old name still resolves to this entity later.
        if (old && old !== name) identity.previous_names = [...new Set([...(identity.previous_names ?? []), old])].slice(-20);
        identity.name = name;

      });
      return { handled: true, kind: 'EXECUTED', goal: plan.goal, plan, message: `已将${entityLabel(resolved.entity)}的名字改为「${name}」。`, view: next };
    }
    const setBalance=validation.ordered.find(step=>step.capability_id==='entity.wallet.balance.set');
    if(setBalance&&resolved.entity){
      const amount=Number(setBalance.input.amount??plan.goal.desired_state.find(item=>item.path==='wallet.balance')?.value);
      if(!Number.isSafeInteger(amount)||amount<0||amount>1_000_000_000)return {handled:true,kind:'EXECUTION_FAILURE',goal:plan.goal,plan,message:'金额必须是有效的非负整数，世界状态没有改变。',retryable:false};
      const entity=view.entities.find(item=>item.id===resolved.entity!.id),balances=entity?.components.wallet?.balances as Record<string,number>|undefined;
      const mentioned=Object.entries(view.currencies).filter(([id,name])=>plan.goal.objective.includes(id)||plan.goal.objective.includes(name)).map(([id])=>id);
      const currencies=mentioned.length?mentioned:Object.keys(balances??{});
      if(!balances||currencies.length!==1||!Object.hasOwn(balances,currencies[0]))return {handled:true,kind:'USER_AMBIGUITY',goal:plan.goal,question:balances&&Object.keys(balances).length>1?'要修改哪一种货币？':'目标人物没有可修改的货币余额。',candidates:Object.keys(balances??{}).map(id=>view.currencies[id]??id)};
      const currency=currencies[0],request={game_id:save.game_id,expected_revision:envelope.expected_revision??save.state_revision,request_id:envelope.request_id??randomUUID()};
      const next=await service.agentTransaction(request,{kind:'capability_plan',objective:plan.goal.objective,steps:plan.steps.map(step=>({step_id:step.step_id,capability_id:step.capability_id,input:step.input}))},draft=>{
        const target=draft.entities.find(item=>item.id===resolved.entity!.id),wallet=target?.components.wallet as {balances:Record<string,number>}|undefined;
        if(!wallet||!Object.hasOwn(wallet.balances,currency))throw new Error('目标人物没有可修改的货币余额');wallet.balances[currency]=amount;
      });
      return {handled:true,kind:'EXECUTED',goal:plan.goal,plan,message:`已将${entityLabel(resolved.entity)}的${view.currencies[currency]??currency}余额设为 ${amount}。`,view:next};
    }
    throw new Error('plan completed without a canonical outcome');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { handled: true, kind: 'EXECUTION_FAILURE', goal: plan.goal, plan, message: '执行时遇到问题，世界状态没有按这次目标继续写入。请稍后重试。', retryable: /timeout|timed out|fetch|network|状态已更新/i.test(reason) };
  }
}

export async function resolveUniversalGoal(service: GameService, text: string, envelope: UniversalRequestEnvelope = {}, options: { external_effects_confirmed?: boolean; authoritativeGoal?:GoalSpec;capabilityScope?:'open_goals' } = {}): Promise<UniversalResolution> {
  if (!options.authoritativeGoal&&!options.capabilityScope&&!isUniversalGoalCandidate(text)) return { handled: false };
  const save = await service.current(), view = service.project(save);
  const explicit=options.authoritativeGoal??(options.capabilityScope?null:deterministicGoal(text));
  const planned = explicit?null:await service.ai.systemAgent(capabilityPlanSchema, save.definition.prompt_profile, {
    instruction: '把请求表示为 provider-neutral GoalSpec，并从 capability_catalog 组合最小有向无环计划。不要发明 capability id。目标不明确时填写 goal.ambiguity；缺能力也保留完整计划，由程序判断 availability。功能开发愿望不属于这里。Open Goal 管理需用 goal.goal_control={kind,target} 与匹配的 open_goal.query/cancel/resume 步骤；target 是实际 UUID 或明确的 current/paused，只处理一项，不混同 Quest。名字值只是字符串，不推断现实身份。',
    player_request: text,
    public_entities: view.entities.map(entity => ({ id: entity.id, name: entity.components.identity?.name ?? null, type: entity.type, role: entity.components.character?.role ?? null })),
    public_locations: view.locations.map(location => ({ id: location.id, name: location.name })),
    capability_catalog: service.systemCapabilities.digest(view.capabilities).filter(item=>!options.capabilityScope||item.id.startsWith('open_goal.')),
    open_goals:[...(save.active_goal?[{scope:'current',plan:save.active_goal.plan}]:[]),...(save.paused_goals??[]).map(item=>({scope:'paused',plan:item.plan}))].map(({scope,plan})=>({scope,id:plan.plan_id,status:plan.status})),
  }, save);
  // A syntactically explicit content mutation retains its validated route even if model planning
  // interprets nearby negation ("不要转开发任务") as a request to develop software.
  const selected = explicit ? composeCapabilityPlan(explicit) : planned;
  if (!selected) return { handled: false };
  if(options.authoritativeGoal&&selected.steps.some(step=>step.capability_id==='entity.create')){
    const missing=options.authoritativeGoal.desired_state.filter(change=>!creationPaths.has(change.path)).map(change=>change.path);
    const name=selected.steps.find(step=>step.capability_id==='entity.create')?.input.name;
    const conflictingName=options.authoritativeGoal.desired_state.some(change=>change.path==='identity.name'&&change.value!==name);
    if(missing.length||conflictingName)return {handled:true,kind:'CAPABILITY_GAP',goal:selected.goal,plan:selected,
      missing:[...missing,...(conflictingName?['identity.name:conflicting_target']:[])],
      message:'当前人物创建能力不能原子完成请求中的全部资料，世界没有改变。'};
  }
  if(options.capabilityScope&&selected.steps.some(step=>!step.capability_id.startsWith('open_goal.')))return {handled:false};
  const preflight=validateCapabilityPlan(selected,view,service.systemCapabilities);
  if(preflight.ok&&selected.steps.some(step=>step.capability_id==='media.image.generate')&&!options.external_effects_confirmed)return {handled:false};
  // An authoritative GoalSpec can contain more than the first available capability
  // actually writes. This audit may veto a partial plan, but never edits the goal or
  // grants a different operation plane. It runs before any world or external effect.
  if(options.authoritativeGoal&&preflight.ok&&!selected.goal.goal_control){
    let coverage:z.infer<typeof goalCoverageSchema>|null=null;
    let previousUncovered:string[]=[];
    for(let attempt=0;attempt<2;attempt++){
      coverage=await service.ai.systemAgent(goalCoverageSchema,save.definition.prompt_profile,{
        instruction:'只审核能力计划能否完整实现原始请求中明确要求的效果。仅依据真实 capability 的输入与效果；entity.create 的 profile 输入会在同一个事务中写入明确字段，未提供的字段才使用默认值。不要假设描述文字会自动写入未列出的字段。若只实现一部分，covered=false 并简述遗漏；若计划确实已写入所有明确字段，covered=true。不要修改目标、改选操作平面或执行动作。',
        original_user_request:text,authoritative_goal:options.authoritativeGoal,
        implemented_effects:projectedEffects(selected),
        proposed_steps:selected.steps.map(step=>({capability_id:step.capability_id,input:step.input,
          implemented_capability:service.systemCapabilities.get(step.capability_id)})),
        ...(attempt?{review:{previous_uncovered:previousUncovered,
          instruction:'重新核对所称遗漏是否已由真实 profile 输入覆盖；不要为了通过而忽略明确要求。'}}:{}),
      },{...save,ai:{threads:{}}});
      currentTrace()?.info('system.goal_coverage',{metadata:{attempt:attempt+1,covered:coverage?.covered??null,
        uncovered:coverage?.uncovered??[],revision:save.state_revision}});
      if(coverage?.covered)break;
      previousUncovered=coverage?.uncovered??[];
    }
    if(!coverage)return {handled:true,kind:'EXECUTION_FAILURE',goal:selected.goal,plan:selected,
      message:'提交前未能确认能力计划覆盖完整请求；世界没有改变。请稍后重试。',retryable:true};
    if(!coverage.covered)return {handled:true,kind:'CAPABILITY_GAP',goal:selected.goal,plan:selected,
      missing:coverage.uncovered,message:'当前能力计划只能完成目标的一部分，因此没有修改世界。',recoverable:true};
  }
  return executeUniversalPlan(service, selected, envelope);
}
