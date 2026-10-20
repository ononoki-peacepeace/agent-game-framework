import {GameError,type SavePackage} from './schema.js';
import type {z} from 'zod';
import {narrativeResultSchema} from '../ai/contracts.js';
import {isActivePerception} from '../agent/perception.js';
import {persistentProgressPattern,interruptedActivity} from './completion-evidence.js';
import {currentMap} from './map.js';
import {publicView} from './state.js';
import {narrativeLanguageIssues} from '../ai/visible-language.js';
import {visualClaimIssues} from './perception-state.js';

type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];
type Narrative=z.infer<typeof narrativeResultSchema>;
const mechanicalPatterns:[string,RegExp][]=[
  ['inventory',/(?:拿起|捡起|拾起|收入背包|装进口袋|交给|递给|放下|丢下|获得了|(?:收|放|装|塞)(?:进|入|到)[^。；，\n]{0,16}(?:背包|背袋|口袋|衣袋|抽屉|柜子|箱子|盒子|容器)|(?:怀里|手中|手里)(?:的)?[^。；，\n]{1,16}(?:散开|掉落|滑落))/],
  ['position',/(?:到达|走到|进入|离开|翻过|跨过|穿过)/],
  ['evidence',/(?:发现|找到|看出|揭开).{0,30}(?:线索|证据|暗门|秘密|机关|真相|痕迹)/],
  ['injury',/(?:受伤|负伤|流血|骨折|重伤|受了伤|烫伤|烧伤|血从.{0,12}流)/],
  ['death',/(?:死亡|死去|断气|杀死|刺死|毙命|已经死了)/],
  ['money',/(?:钱|金币|余额|现金|银币).{0,12}(?:增加|减少|获得|失去|扣除|支付)/],
  ['state',/(?:门|锁).{0,12}(?:打开|破坏|砸开|解锁)|(?:说服|制服|击败|投降)|(?:学会|升级|提升).{0,12}(?:技能|属性)/],
  ['progress',persistentProgressPattern],
  ['random',/(?:掷出|骰出|骰点|掷得|\bd(?:20|6|100)\b|rolled?\s+\d+)/i],
];

/** Attention leaving a person is expressive behavior, not an entity MOVE. */
function attentionMovement(prefix:string){
  return /(?:视线|目光|注意力)(?:(?:一直|始终|仍然|仍|也|还|却|并|都|早已|已经|曾|暂时|从未|没有|没|未曾|尚未|不曾|不再|不|又|才|稍稍|完全|片刻|短暂|持续|悄悄|轻轻))*$/.test(prefix);
}

/** Validation only: a denial or future intention is not evidence of completed travel.
 * Scan every occurrence so a negative sentence cannot hide a later positive claim. */
function assertedPatternMatch(kind:string,pattern:RegExp,text:string){
  for(const match of text.matchAll(new RegExp(pattern.source,pattern.flags.includes('g')?pattern.flags:pattern.flags+'g'))){
    if(kind==='inventory'&&match[0]==='放下'&&/^(?:了|自己的|双|两只|一只)*(?:手臂|胳膊|双手|手|肩膀|头|腿)(?=[，,。；;！？!?]|$)/.test(text.slice(match.index+match[0].length)))continue;
    if(kind==='injury'&&/(?:没有|并未|尚未|未曾|未|不曾)$/.test(text.slice(Math.max(0,match.index-4),match.index)))continue;
    if(kind==='position'){
      const prefix=text.slice(Math.max(0,match.index-80),match.index).split(/[，,。；;！？!?\n]/).at(-1)??'';
      if(match[0]==='离开'&&attentionMovement(prefix))continue;
      if(/(?:没有|尚未|还没|并未|未曾|不曾|没能|未能|不能|不会|不愿|不想|不打算|打算|准备|想要)(?:(?:真正|实际|立即|直接|已经|曾经|成功|能够|继续|主动|变成|将要|再|就|被|去|要|会)){0,5}$/.test(prefix))continue;
    }
    return match;
  }
  return null;
}

/** Only diagnostic context for a prose-pattern rejection; never retain the full narration. */
export class NarrativePatternError extends GameError {
  constructor(public readonly patternKind:string,public readonly matchIndex:number,public readonly snippet:string,
    message='场景描写超出了已结算的世界事实，本回合尚未提交，可以安全重试。'){super(message,503);}
}
export class NarrativeClaimError extends GameError {
  constructor(readonly claimKind:string,readonly factIndex:number,readonly allowedEffects:readonly string[]){
    super(`场景描写声称了未结算的世界变化（mechanical_claims: ${claimKind}, fact_index: ${factIndex}；允许：${allowedEffects.join(',')}）`,503);
  }
}

function matchedSnippet(prose:string,start:number,length:number){
  const from=Math.max(0,start-16),to=Math.min(prose.length,start+length+16);
  // Even a short narration must not be logged in full.
  const excerpt=from===0&&to===prose.length?prose.slice(start,start+length):prose.slice(from,to);
  return excerpt.replace(/\s+/g,' ').slice(0,100);
}

function presenceAliases(name:string){
  return [name.replace(/\s/g,''),...name.split(/\s+/).filter(part=>part.length>=2)].filter(Boolean);
}

function presenceCount(raw:string):number|null{
  if(/^\d+$/.test(raw))return Number(raw);
  const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(Object.hasOwn(digits,raw))return digits[raw];
  const tens=/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/.exec(raw);
  return tens?(tens[1]?digits[tens[1]]:1)*10+(tens[2]?digits[tens[2]]:0):null;
}

/** A literal joined list followed by the checked predicate has plural
 * subjects. Names mentioned as listeners, possessors or objects do not. */
function jointNarrativeSubjects<T extends {components:{identity?:{name?:unknown}}}>(text:string,people:T[],predicate:RegExp){
  if(people.length<2)return [];
  const aliases=people.flatMap(person=>presenceAliases(String(person.components.identity?.name??'')))
    .sort((a,b)=>b.length-a.length).map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const name=`(?:${aliases.join('|')})`;
  const joined=new RegExp(`^(?:随后|随即|接着|然后|这时|同时)?(${name}(?:(?:以及|和|与|、|跟)${name})+)(?=(?:两人|二人|三人|四人|一行人|一起|一同|都|也|仍然|仍|依然|早已|已经|没有|尚未|还没|不曾|未曾|并未|没能|不愿|不想|不肯|不能|不会|不要|不再|打算|准备|想要|真正|实际|立即|直接|曾经|成功|能够|继续|主动|将要|迈步|再|就|被|去|要|会)*${predicate.source})`).exec(text)?.[1];
  return joined?people.filter(person=>presenceAliases(String(person.components.identity?.name??'')).some(alias=>joined.includes(alias))):[];
}

/** Current-scene prose cannot turn a player's presupposition or an old paragraph into an NPC MOVE. */
export function validateScenePresenceNarrative(save:SavePackage,prose:string,claims:readonly {entity_id:string;location_id:string}[]=[]){
  for(const claim of claims){
    const entity=save.entities.find(entity=>entity.id===claim.entity_id&&entity.components.character);
    if(!entity||entity.components.location?.location_id!==claim.location_id)
      throw new GameError('叙事人物位置声明与权威位置不一致',503);
  }
  const here=save.entities.find(entity=>entity.id===save.player_state.entity_id)?.components.location?.location_id;
  const people=save.entities.filter(entity=>entity.id!==save.player_state.entity_id&&entity.components.character);
  let subjects:typeof people=[];
  // Quoted speech can recall another time or make a character's own claim;
  // only the unquoted narration asserts the current authoritative scene.
  const unquoted=prose.replace(/[“「『][^”」』]*[”」』]/g,'');
  const sentences=unquoted.split(/[。！？\n]/);
  for(let index=0;index<sentences.length;index++){
    const sentence=sentences[index];
    const compact=sentence.replace(/\s/g,'');
    const named=people.filter(entity=>{
      const name=String(entity.components.identity?.name??'');
      return presenceAliases(name).some(alias=>compact.includes(alias));
    });
    const joint=jointNarrativeSubjects(compact,named,/(?:离开|离去|走出|走了|上去了|跨过门槛|跨出门|退出房间|站在|坐在|就在|留在)/);
    // Independently named clauses must not disappear just because the whole
    // sentence has multiple people. Keep single-subject implicit continuations
    // together; a player clause must not inherit the preceding NPC's identity.
    if((named.length>1&&joint.length!==named.length||/[，,；;](?:你|玩家)/.test(compact))&&/[，,；;]/.test(sentence)){
      sentences.splice(index+1,0,...sentence.split(/[，,；;]/));subjects=[];continue;
    }
    if(named.length===1)subjects=named;else if(named.length>1)subjects=joint;
    else if(!/^(?:随后|随即|接着|然后)?(?:她|他)/.test(compact))continue;
    if(!subjects.length)continue;
    const departed=[...compact.matchAll(/(?:离开|离去|走出|走了|上去了|跨过门槛|跨出门|退出房间)/g)].some(match=>{
      const token=match[0];
      if(token==='离开'&&attentionMovement(compact.slice(0,match.index).split(/[，,；;]/).at(-1)??''))return false;
      // "走了两步/几步" is local stepping, never evidence of leaving the scene.
      if(token==='走了'&&/^[一二两三四五六七八九十百\d]+步/.test(compact.slice(match.index+token.length)))return false;
      // A denial/intention belongs to this occurrence, not every later verb in
      // the sentence. Contrast and clause boundaries may introduce real travel.
      const prefix=compact.slice(0,match.index).split(/[，,；;]|但是|可是|随后|然后|接着|却|但/).at(-1)??'';
      const guarded=/(?:没有|尚未|还没|不曾|未曾|并未|没能|不愿|不想|不肯|不能|不会|不要|别让|不再|打算|准备|想要)(?:(?:真正|实际|立即|直接|已经|曾经|成功|能够|继续|主动|变成|将要|迈步|再|就|被|去|要|会)){0,5}$/.test(prefix)||
        /(?:如果|要是).{0,16}$/.test(prefix);
      return !guarded;
    });
    if(subjects.some(subject=>subject.components.location?.location_id===here)&&departed)throw new GameError('旁白声称在场人物已经离场，但没有权威位置变更',503);
    if(subjects.some(subject=>subject.components.location?.location_id!==here)&&/(?:站在|坐在|就在|留在)(?:这里|眼前|你身旁|你面前|原地)/.test(compact))
      throw new GameError('旁白把不在当前地点的人物描写为在场',503);
  }
  const actual=people.filter(entity=>entity.components.location?.location_id===here).length+1;
  for(const match of unquoted.matchAll(/(?:只剩下?|只有|就剩下?)(?:我们|你们|他们|她们)?([零〇一二三四五六七八九十两\d]+)(?:个)?人/g)){
    const count=presenceCount(match[1]);
    if(count!==null&&count!==actual)throw new GameError('旁白人数与权威在场名单不一致',503);
  }
}

/** Reject prose that asserts mechanical effects absent from the committed program receipt. */
export function validateResolvedNarrative(receipt:Receipt,result:Narrative,hidden:boolean,compoundReceipts?:Receipt[],scene?:SavePackage){
  if((result.item_claims??[]).length||(result.stable_locations??[]).length||result.patches.length)
    throw new GameError('开放行动的场景描写不能自行写入实体或状态',503);
  const allowed=new Set(receipt.effects);
  for(const claim of result.mechanical_claims??[]){
    if(claim.fact_index>=receipt.canonical_facts.length)throw new GameError('场景描写引用了不存在的程序事实',503);
    if(claim.kind==='activity'){
      const cited=receipt.canonical_facts[claim.fact_index];
      const matches=(compoundReceipts??[receipt]).some(step=>{
        const activity=step.activity;
        return activity?.occurred&&activity.duration_minutes===step.time_cost&&
          step.effects.includes('activity')&&step.canonical_facts.includes(cited)&&
          cited===`进行了活动：${activity.description}（${activity.duration_minutes} 分钟）。`;
      });
      if(!allowed.has('activity')||!matches)
        throw new GameError('场景描写引用了不匹配的活动凭据',503);
    }else if(claim.kind==='outcome'){
      if(hidden)throw new GameError('场景描写泄露了尚未公开的判定结果',503);
    }else if(!allowed.has(claim.kind as typeof receipt.effects[number])){
      // A citation of the canonical *absence* of damage is not new damage.
      const denial=claim.kind==='injury'&&receipt.physical_outcome&&!receipt.physical_outcome.harmed&&
        /没有结算伤害|没有造成已确认的伤害/.test(receipt.canonical_facts[claim.fact_index]);
      const movement=claim.kind==='position'&&compoundReceipts?.some(step=>step.movement_route&&step.canonical_facts.includes(receipt.canonical_facts[claim.fact_index]));
      if(!denial&&!movement)throw new NarrativeClaimError(claim.kind,claim.fact_index,receipt.effects);
    }
  }
  // Character speech can contain fears, intentions or lies. It is not an
  // authoritative assertion that those actions happened. Preserve the text.
  let body=result.narrative;
  for(const beat of result.scene_beats??[])if(beat.kind==='speech'){
    for(const [open,close] of [['“','”'],['「','」'],['『','』'],['"','"']])
      body=body.split(open+beat.utterance+close).join('');
  }
  const prose=[body,...(result.scene_beats??[]).filter(beat=>beat.kind==='narration').map(beat=>beat.text)].join('\n');
  // The aggregate inherits its final child type; earlier physical results still
  // constrain injuries and event-time perception when the last child is TALK.
  const physicalCandidates=(compoundReceipts??[receipt]).filter(step=>step.physical_outcome);
  // Repetition owns its scoped success/failure facts. Checking each raw attempt
  // against the whole paragraph would reject its truthful failed prefix.
  const repeatedAttemptIds=new Set([...physicalCandidates,receipt].flatMap(step=>step.repetition?.attempt_ids??[]));
  const physicalReceipts=physicalCandidates.filter(step=>!repeatedAttemptIds.has(step.request_id));
  if(!physicalReceipts.length&&receipt.physical_outcome)physicalReceipts.push(receipt);
  if(scene)for(const step of physicalReceipts)validatePerceptionNarrative(scene,step,result);
  if(physicalReceipts.length){
    // Abstract HP damage does not establish a particular visible wound or its
    // severity. Ordinary motion, pain and emotion remain expressive prose.
    const bodilyDetail=/(?:淤红|瘀青|淤青|红肿|肿胀|骨折|脱臼|失明|断肢|烧伤|烫伤)/g;
    for(const match of prose.matchAll(bodilyDetail)){
      if(/(?:没有|并未|尚未|未曾|不曾)$/.test(prose.slice(Math.max(0,match.index-4),match.index)))continue;
      const supported=physicalReceipts.some(step=>step.canonical_facts.some(fact=>!/[说问喊答]：“/.test(fact)&&fact.includes(match[0])));
      if(!supported)throw new NarrativePatternError('injury_detail',match.index,matchedSnippet(prose,match.index,match[0].length),
        '具体伤势表现没有对应的权威事实；抽象伤害不确认部位、伤型或永久后果');
    }
    for(const step of physicalReceipts){
      const physical=step.physical_outcome!;
      if(physical.contact)for(const match of prose.matchAll(/伸手落空|没有碰到|未能接触|没碰到/g)){
        const scopedMiss=scopedPhysicalDenial(step,prose.slice(0,match.index),'contact');
        if(!scopedMiss)throw new NarrativePatternError('contact_denial',match.index,matchedSnippet(prose,match.index,match[0].length),'叙事否认了已经结算的身体接触');
      }
      if(physical.harmed)for(const match of prose.matchAll(/毫发无伤|没有受伤|并未受伤/g))
        if(!otherInjuryDenialSubject(scene,step,prose.slice(0,match.index))&&!scopedPhysicalDenial(step,prose.slice(0,match.index),'injury'))
          throw new NarrativePatternError('injury_denial',match.index,matchedSnippet(prose,match.index,match[0].length),'叙事否认了已经结算的伤害');
    }
  }
  // A report of *not* finding anything is not a claim that new evidence was discovered.
  const positiveClaims=prose.replace(/(?:没有|未|没能|未能)(?:发现|找到|看出)[^。；，\n]{0,60}(?:线索|证据|暗门|秘密|机关|真相|痕迹)/g,'');
  // An executed environment check may canonically report no obtainable object.
  // Exact receipt-backed clauses are not a claim that execution itself failed.
  const verdictProse=receipt.environment?prose.split(/(?<=[。；])/).filter(clause=>
    !clause.trim()||!receipt.canonical_facts.some(fact=>fact.includes(clause.trim()))).join(''):prose;
  const success=/成功|达成|得手|奏效|顺利完成/.test(verdictProse),failure=/失败|未能|没能|未成功/.test(verdictProse);
  if(hidden&&(success||failure))throw new GameError('场景描写泄露了尚未公开的判定结果，本回合尚未提交，可以安全重试。',503);
  if(['failure','critical_failure'].includes(receipt.outcome)&&success)throw new GameError('场景描写与程序判定相反，本回合尚未提交，可以安全重试。',503);
  if(['success','strong_success'].includes(receipt.outcome)&&failure)throw new GameError('场景描写与程序判定相反，本回合尚未提交，可以安全重试。',503);
  for(const [kind,pattern] of mechanicalPatterns){
    let text=kind==='evidence'?positiveClaims:prose;
    if(kind==='position'&&scene&&compoundReceipts){
      // Only an explicitly identified NPC's actual route can explain their movement.
      // A player movement, anonymous movement, or an unexecuted NPC plan still fails.
      text=text.split(/(?<=[。！？\n])/).filter(sentence=>!compoundReceipts.some(step=>{
        if(!step.movement_route||step.actor_id===receipt.actor_id)return false;
        const person=scene.entities.find(e=>e.id===step.actor_id),name=String(person?.components.identity?.name??'');
        if(!name||!sentence.replace(/\s/g,'').includes(name.replace(/\s/g,''))||
          /(?:你|玩家)(?:自己|也|随后|接着|又|先|便|就)?(?:走|到达|进入|离开|跨|穿过)/.test(sentence))return false;
        try{validateMovementNarrative(step,{...result,narrative:sentence,dialogue:null},scene);return true;}catch{return false;}
      })).join('');
    }
    const match=assertedPatternMatch(kind,pattern,text);
    if(match&&!allowed.has(kind as typeof receipt.effects[number]))
      throw new NarrativePatternError(kind,match.index,matchedSnippet(text,match.index,match[0].length));
  }
}

/** An entity recorded as sightless at settlement cannot be narrated as having watched
 * the action. The receipt is the record, not live state: a forced physical event ends a
 * voluntary eyes-closed state at settlement, so live state is already "open" by now (REV435).
 * This constrains generated presentation only; it never changes a settled outcome. */
export function validatePerceptionNarrative(save:SavePackage,receipt:Receipt,result:Narrative){
  const blind=new Set(receipt.physical_outcome?.sight_blocked_ids??[]);
  if(!blind.size)return;
  const vision={blocked:true,reason:'结算时没有视觉信息',transient:null} as const;
  const reject=(text:string,match:{match:string;index:number})=>{
    throw new NarrativePatternError('perception',match.index,matchedSnippet(text,match.index,match.match.length),
      '叙事让一个在结算时没有视觉信息的人物声称看见了动作过程；该人物只能凭触觉、听觉和既有认知反应');
  };
  for(const beat of result.scene_beats??[])if(beat.kind==='speech'&&blind.has(beat.speaker_id)){
    const issues=visualClaimIssues(beat.utterance,vision);
    if(issues.length)reject(beat.utterance,issues[0]);
  }
  if(result.speaker&&blind.has(result.speaker)&&result.dialogue){
    const issues=visualClaimIssues(result.dialogue,vision);
    if(issues.length)reject(result.dialogue,issues[0]);
  }
  // Narration attributes by the nearest named subject, matching presence validation.
  const people=save.entities.filter(entity=>entity.components.character);
  const prose=[result.narrative,...(result.scene_beats??[]).filter(beat=>beat.kind==='narration').map(beat=>beat.text)].join('\n');
  let subjects:typeof people=[];
  const sentences=prose.split(/[。！？\n]/);
  for(let index=0;index<sentences.length;index++){
    const sentence=sentences[index];
    const compact=sentence.replace(/\s/g,'');
    const named=people.filter(entity=>{
      const name=String(entity.components.identity?.name??'');
      return presenceAliases(name).some(alias=>compact.includes(alias));
    });
    const joint=jointNarrativeSubjects(compact,named,/(?:看|目睹|亲眼|眼睁睁|全都看见)/);
    if((named.length>1&&joint.length!==named.length||/[，,；;](?:你|玩家)/.test(compact))&&/[，,；;]/.test(sentence)){
      sentences.splice(index+1,0,...sentence.split(/[，,；;]/));subjects=[];continue;
    }
    if(named.length===1)subjects=named;else if(named.length>1)subjects=joint;
    else if(!/^(?:随后|随即|接着|然后|这时|同时)?(?:她|他)/.test(compact))continue;
    if(!subjects.some(subject=>blind.has(subject.id)))continue;
    const issues=visualClaimIssues(compact,vision);
    if(issues.length)reject(sentence,issues[0]);
  }
}

/** Only a uniquely named grammatical subject can scope a denial away from the
 * harmed target. Mere mentions, joint subjects and pronouns remain conservative. */
function otherInjuryDenialSubject(save:SavePackage|undefined,receipt:Receipt,prefix:string){
  if(!save)return false;
  const clause=(prefix.split(/[。！？；，,\n]/).at(-1)??'').replace(/\s/g,'');
  const subjects=save.entities.filter(entity=>entity.components.character&&
    [String(entity.components.identity?.name??'').replace(/\s/g,''),
      ...(entity.id===save.player_state.entity_id?['你','玩家']:[])].some(name=>
      name&&clause.startsWith(name)&&/^(?:自己|本人)?(?:仍然|依然|依旧|仍|却|还|也|完全|始终|一直)*$/.test(clause.slice(name.length))));
  return subjects.length===1&&subjects[0].id!==receipt.physical_outcome?.target_id;
}

/** Partial failure may be described at its real position, but never as a global denial. */
function scopedPhysicalDenial(receipt:Receipt,prefix:string,kind:'contact'|'injury'){
  if(!receipt.repetition)return false;
  const facts=receipt.canonical_facts.filter(f=>/^第\s*\d+\s*次/.test(f));
  const denied=(fact:string)=>kind==='contact'?fact.includes('未能建立接触'):fact.includes('没有结算伤害');
  const clause=prefix.split(/[。；\n]/).at(-1)??'';
  const scope=clause.match(/(?:第|前|头)([一二三四五六七八\d]+)次[^。；\n]{0,60}$/);
  const numbers:Record<string,number>={一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8};
  if(scope){const n=numbers[scope[1]]??Number(scope[1]);
    if(!(n>=1&&n<=facts.length))return false;
    return scope[0].startsWith('第')?denied(facts[n-1]):facts.slice(0,n).every(denied);}
  if(/最后[^。；\n]{0,40}$/.test(clause))return Boolean(facts.length&&denied(facts.at(-1)!));
  return /(?:有几次|其中几次|有时)[^。；\n]{0,40}$/.test(clause)&&facts.some(denied);
}

/** Route assertions are checked against the route actually executed, never a newly planned path. */
export function validateMovementNarrative(receipt:Receipt,result:Narrative,save:SavePackage){
  const route=receipt.movement_route;if(!route)return;
  const locations=currentMap(save).locations;
  const names=new Map(locations.map(location=>[location.id,location.name]));
  const travelled=new Set(route.location_ids);
  const prose=[result.narrative,result.dialogue??''].join('\n');
  const companionNames=(receipt.result_entities?.moved_companions??[]).map(id=>
    String(save.entities.find(entity=>entity.id===id)?.components.identity?.name??id));
  const compact=(value:string)=>value.replace(/\s/g,'');
  for(const match of prose.matchAll(/跟上来的只有([^。；，\n]{1,80})|只有([^。；，\n]{1,80})(?:跟|随|同行)/g)){
    const claim=compact(match[1]??match[2]);
    if(companionNames.some(name=>claim.includes(compact(name)))&&
      companionNames.some(name=>!claim.includes(compact(name))))
      throw new GameError('移动叙事遗漏了已结算的同行人物',503);
  }
  for(const name of companionNames){
    const mention=compact(prose).indexOf(compact(name));
    if(mention>=0&&/(?:留在原地|留在出发地|没有跟上|没跟上|没有同行|没同行)/.test(
      compact(prose).slice(mention,mention+compact(name).length+24)))
      throw new GameError('移动叙事错误宣称已同行人物留队',503);
  }
  for(const location of locations){
    if(travelled.has(location.id)||!location.name||!prose.includes(location.name))continue;
    const escaped=location.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const transition=new RegExp(`(?:途经|经过|穿过|进入|走到|到达|抵达|路过|从|离开).{0,8}${escaped}|${escaped}.{0,8}(?:途经|经过|穿过|进入|走到|到达|抵达|路过)`);
    if(transition.test(prose))throw new GameError('移动叙事声称经过未结算的地点',503);
  }
  // Exact duration claims must match an actual segment or the complete route.
  const durations=[...prose.matchAll(/(?:用时|耗时|花了|走了|经过了|合计|总共|大约|约|再走)\s*(?:约)?\s*(\d+|[一二三四五六七八九十两]+)\s*分钟/g)];
  const allowed=new Set([route.total_minutes,...route.edges.map(edge=>edge.travel_minutes)]);
  const minute=(raw:string)=>{
    if(/^\d+$/.test(raw))return Number(raw);
    const values:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    if(raw==='十')return 10;
    const parts=raw.split('十');
    if(parts.length===2)return (parts[0]?values[parts[0]]??NaN:1)*10+(parts[1]?values[parts[1]]??NaN:0);
    return values[raw]??NaN;
  };
  if(durations.some(match=>!allowed.has(minute(match[1]))))throw new GameError('移动叙事时长与权威路线不符',503);
  const origin=names.get(route.origin_id),destination=names.get(route.destination_id);
  if(!origin||!destination)throw new GameError('移动回执引用了未知地点',503);
  if(route.edges.length>1&&/(?:直接|径直|一步|抄近路).{0,24}(?:到达|抵达|进入|走到|来到)/.test(prose))
    throw new GameError('移动叙事声称了未结算的直达路线',503);
  if(/(?:推开|打开|解锁|砸开|撞开)[^。；，\n]{0,32}(?:门|闸|通道)|(?:门|闸|通道).{0,8}(?:被打开|已打开|解锁)/.test(prose)&&
    !receipt.effects.includes('state'))throw new GameError('移动叙事声称了未结算的通道状态变化',503);
}

export function canonicalMovementNarrative(receipt:Receipt,save:SavePackage){
  const route=receipt.movement_route;if(!route)return canonicalResolutionNarrative(receipt,false);
  const names=new Map(currentMap(save).locations.map(location=>[location.id,location.name]));
  const labels=route.location_ids.map(id=>names.get(id)).filter((name):name is string=>Boolean(name));
  if(labels.length!==route.location_ids.length)throw new GameError('移动回执引用了未知地点',503);
  const companions=(receipt.result_entities?.moved_companions??[]).map(id=>
    String(save.entities.find(entity=>entity.id===id)?.components.identity?.name??id));
  return `你从${labels[0]}出发，${labels.length>2?`途经${labels.slice(1,-1).join('、')}，`:''}来到${labels.at(-1)}。${companions.length?`${companions.join('、')}与你同行抵达。`:''}这段路用了${route.total_minutes}分钟。`;
}

/** Typed check history survives prose/schema failure; player wording is not a classifier. */
export function isSettledPerception(save:SavePackage,receipt:Receipt){
  return save.resolution_history?.some(check=>
    (check.check_id===receipt.check_id||check.request_id===receipt.request_id)&&check.spec.domain==='perception')??false;
}
export function canonicalPerceptionNarrative(save:SavePackage,receipt:Receipt,hidden:boolean){
  const here=save.entities.find(entity=>entity.id===receipt.actor_id)?.components.location?.location_id;
  return [currentMap(save).locations.find(location=>location.id===here)?.description,
    canonicalResolutionNarrative(receipt,hidden,true)].filter(Boolean).join('\n');
}

const itemActionTypes=new Set(['BUY','SELL','EQUIP','UNEQUIP']);
/** Only built-in Core fact formats supply item, quantity and paid amount. Never
 * infer a trade from effects or the current inventory, which may already differ. */
function itemActionNarrative(receipt:Receipt,hidden:boolean){
  if(!itemActionTypes.has(receipt.semantic_action)||hidden||receipt.outcome!=='success'||receipt.kind!=='DETERMINISTIC')return null;
  for(const fact of receipt.canonical_facts){
    if(receipt.semantic_action==='BUY'||receipt.semantic_action==='SELL'){
      const verb=receipt.semantic_action==='BUY'?'购买':'出售';
      const match=new RegExp(`^${verb} ([1-9]\\d*) × ([\\s\\S]+)，金额 (\\d+) ([\\s\\S]+)。$`).exec(fact);
      if(match)return receipt.semantic_action==='BUY'?
        `你买下了${match[1]}件${match[2]}，付了${match[3]}${match[4]}。`:
        `你卖出了${match[1]}件${match[2]}，收到了${match[3]}${match[4]}。`;
    }
    if(receipt.semantic_action==='EQUIP'){
      const match=/^装备 ([\s\S]+) 到 [a-zA-Z0-9_-]+。$/.exec(fact);
      if(match)return `你装备好了${match[1]}。`;
    }
    if(receipt.semantic_action==='UNEQUIP'){
      const match=/^卸下 ([\s\S]+)。$/.exec(fact);
      if(match)return `你卸下了${match[1]}。`;
    }
  }
  return null;
}

function activityActionNarrative(receipt:Receipt,hidden:boolean){
  const activity=receipt.activity;
  if(!hidden&&interruptedActivity(receipt)&&receipt.time_cost===0)return '你停了下来，这段活动尚未开始。';
  if(hidden||receipt.kind!=='DETERMINISTIC'||receipt.outcome!=='success'||!activity?.occurred||
    !receipt.effects.includes('activity')||activity.duration_minutes!==receipt.time_cost||
    !receipt.canonical_facts.includes(`进行了活动：${activity.description}（${activity.duration_minutes} 分钟）。`))return null;
  if(interruptedActivity(receipt)){
    const label=activity.description.replace(/(?:[0-9零一二两三四五六七八九十百]+|半)\s*个?\s*(?:小时|分钟)[。！!]?$/u,'').trim();
    return `你进行着「${label||activity.description}」这段活动，过了${receipt.time_cost}分钟便停了下来。`;
  }
  // The receipt proves this activity interval, never the completion of a larger goal.
  return `你进行了「${activity.description}」这段活动，持续了${receipt.time_cost}分钟。`;
}

/** Multi-step grounded degradation: a compound turn must never collapse into one
 * generic completion line. Present each settled step's confirmed facts in order,
 * without inventing any world state beyond the committed receipts. */
export function canonicalCompoundNarrative(save:SavePackage,hidden:boolean,steps:Receipt[]){
  const lines=steps.map((step,index)=>{
    const facts=(step.canonical_facts??[]).filter(fact=>
      !fact.startsWith('尝试行动：')&&!fact.startsWith('本次行动经过 '));
    const name=String(save.entities.find(entity=>entity.id===step.target_id)?.components.identity?.name??'对方');
    // The aggregate inherits its last step's type; render the actual child
    // receipts before using generic facts so preceding speech is not lost.
    const text=step.physical_outcome?physicalNarrativeFallback(save,step,hidden).narrative:
      step.movement_route?canonicalMovementNarrative(step,save):
      isSettledPerception(save,step)?canonicalPerceptionNarrative(save,step,hidden):
      step.semantic_action==='TALK'?`你向${name}开了口。`:
      step.semantic_action==='WAIT'?canonicalResolutionNarrative(step,hidden):
      step.semantic_action==='HOLD'?canonicalResolutionNarrative(step,hidden):
      itemActionTypes.has(step.semantic_action)?canonicalResolutionNarrative(step,hidden):
      activityActionNarrative(step,hidden)??
      (facts.length?facts.join(' '):canonicalResolutionNarrative(step,hidden));
    return `${index+1}、${text}`;
  });
  return lines.join('\n');
}

export function canonicalResolutionNarrative(receipt:Receipt,hidden:boolean,perception=false){
  if(receipt.environment&&!hidden)return receipt.canonical_facts.join(' ');
  if(receipt.semantic_action==='WAIT'&&!hidden&&receipt.kind==='DETERMINISTIC'&&receipt.outcome==='success')
    return receipt.time_cost===0?'你停了下来。':
      interruptedActivity(receipt)?`你等了${receipt.time_cost}分钟便停了下来。`:`你等了${receipt.time_cost}分钟。`;
  if(receipt.physical_outcome){
    const physical=receipt.physical_outcome;
    return !physical.contact?'这次强制动作没能建立接触，没有造成已确认的伤害。':
      physical.harmed?'你的动作造成了已经确认的伤害，对方的身体状态随之改变。':
      physical.kind==='restrain'&&(physical.control_established??['success','strong_success'].includes(receipt.outcome))?'你暂时控制住了对方，这次没有造成已确认的伤害。':
        '你接触到了对方，但进一步的动作没有得手，这次没有造成已确认的伤害。';
  }
  if(perception||isActivePerception(receipt.semantic_action)){
    const discovered=receipt.canonical_facts.filter(fact=>fact.startsWith('发现已存在的证据：'));
    return discovered.length?`你仔细查看了眼前的情形。${discovered.map(fact=>fact.slice('发现已存在的证据：'.length)).join('；')}`:
      hidden?'你仔细查看了当前区域。眼前能确认的仍是已经看见的情形。':
        '你仔细观察了一会儿，在这次检查范围内暂时没有发现明显异常或新的线索。';
  }
  if(receipt.semantic_action==='HOLD'&&!hidden&&receipt.kind==='DETERMINISTIC'&&receipt.outcome==='success'){
    const fact=receipt.canonical_facts.map(text=>/^在当前位置持续进行「([\s\S]+)」，实际经过 (\d+) 分钟(，因需要处理的事情而暂停|。)$/.exec(text))
      .find(match=>match&&Number(match[2])===receipt.time_cost);
    if(fact)return receipt.time_cost===0?`你停了下来，尚未继续「${fact[1]}」。`:
      `你留在原处继续「${fact[1]}」，${fact[3]==='。'?`这段活动持续了${receipt.time_cost}分钟。`:`过了${receipt.time_cost}分钟便停了下来。`}`;
    // Long Core facts can be truncated; elapsed time alone never proves the
    // named activity or a larger goal was completed.
    if(interruptedActivity(receipt))return receipt.time_cost>0?
      `你留在原处，过了${receipt.time_cost}分钟便停了下来。`:'你停了下来，这段活动尚未开始。';
    return receipt.time_cost>0?`你留在原处，过了${receipt.time_cost}分钟。`:'你停了下来。';
  }
  const itemNarrative=itemActionNarrative(receipt,hidden);if(itemNarrative)return itemNarrative;
  const activityNarrative=activityActionNarrative(receipt,hidden);if(activityNarrative)return activityNarrative;
  const outcome=hidden?'这次尝试已经进行，结果目前尚不可确认。':
    receipt.outcome==='partial_success'?'这次尝试取得了部分进展。':
    ['success','strong_success'].includes(receipt.outcome)?'这次尝试已完成。':'这次尝试没有达到预期。';
  const effects=receipt.effects.includes('inventory')?'已登记物品的位置随之更新。':
    receipt.effects.includes('position')?'你的位置已按实际行动更新。':'';
  return outcome+effects;
}

/** Grounded degradation: reuse public scenery and already validated NPC speech,
 * never invent a new reaction, escape, injury or item for dramatic effect. */
export function physicalNarrativeFallback(save:SavePackage,receipt:Receipt,hidden:boolean,related:Receipt[]=[]){
  const actor=save.entities.find(entity=>entity.id===receipt.actor_id);
  const target=save.entities.find(entity=>entity.id===receipt.target_id);
  const name=String(target?.components.identity?.name??'对方');
  const physical=receipt.physical_outcome!;
  const action=physical.contact?`你的动作触及了${name}。${physical.harmed?'这次动作确实造成了伤害。':
    physical.control_established?'接触之后，你暂时维持住了控制。':'但接下来的动作没有达到预期；本次没有新增已确认的伤害。'}`:
    `你对${name}发起了尝试，这一次未能建立接触。`;
  const attempts=related.filter(r=>receipt.repetition?.attempt_ids.includes(r.request_id)&&r.physical_outcome);
  const sequence=attempts.map((r,i)=>{const p=r.physical_outcome!;
    return `第${i+1}次尝试，${!p.contact?'你没能触及对方':p.harmed?'你的动作触及对方，造成了已确认的伤害':p.control_established?'你触及对方，维持住了控制':'你触及对方，但没有造成新的已确认伤害'}。`;}).join('');
  const departures=related.filter(r=>r.actor_id!==receipt.actor_id&&r.movement_route?.location_ids[0]===actor?.components.location?.location_id&&
    r.movement_route?.location_ids.at(-1)!==actor?.components.location?.location_id).map(r=>
      `${String(save.entities.find(e=>e.id===r.actor_id)?.components.identity?.name??'在场的人')}离开了这里。`).join('');
  const prose=[hidden?canonicalResolutionNarrative(receipt,true):sequence||action,
    receipt.repetition?`这段尝试持续了${receipt.repetition.elapsed_seconds}秒，随后停下。`:null,departures||null]
    .filter(Boolean).join('\n\n');
  const beats:NonNullable<SavePackage['last_turn']>['scene_beats']=[{kind:'narration',text:prose.slice(0,1200)}];
  const blind=new Set(physical.sight_blocked_ids??[]);
  for(const id of physical.witness_ids){
    const speech=save.npc_agent_state?.[id]?.last_decisions.findLast(entry=>entry.event_ref===`reaction:${receipt.request_id}`)?.speech;
    if(!speech||narrativeLanguageIssues({narrative:'',dialogue:speech},publicView(save)).length)continue;
    // Degradation reuses stored speech, so it must clear the same perception bar as
    // live narration; speech recorded before this rule existed is still unvalidated.
    if(blind.has(id)&&visualClaimIssues(speech,{blocked:true,reason:'结算时没有视觉信息',transient:null}).length)continue;
    beats.push({kind:'speech',speaker_id:id,utterance:speech.slice(0,1000)});
  }
  return {narrative:prose,scene_beats:beats};
}
