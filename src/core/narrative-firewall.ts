import {GameError,type SavePackage} from './schema.js';
import type {z} from 'zod';
import {narrativeResultSchema} from '../ai/contracts.js';
import {isActivePerception} from '../agent/perception.js';
import {persistentProgressPattern} from './completion-evidence.js';

type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];
type Narrative=z.infer<typeof narrativeResultSchema>;
const mechanicalPatterns:[string,RegExp][]=[
  ['inventory',/(?:拿起|捡起|拾起|收入背包|装进口袋|交给|递给|放下|丢下|获得了|(?:收|放|装|塞)(?:进|入|到))/],
  ['position',/(?:到达|走到|进入|离开|翻过|跨过|穿过)/],
  ['evidence',/(?:发现|找到|看出|揭开).{0,30}(?:线索|证据|暗门|秘密|机关|真相|痕迹)/],
  ['injury',/(?:受伤|负伤|流血|骨折|重伤|受了伤|血从.{0,12}流)/],
  ['death',/(?:死亡|死去|断气|杀死|刺死|毙命|已经死了)/],
  ['money',/(?:钱|金币|余额|现金|银币).{0,12}(?:增加|减少|获得|失去|扣除|支付)/],
  ['state',/(?:门|锁).{0,12}(?:打开|破坏|砸开|解锁)|(?:说服|制服|击败|投降)|(?:学会|升级|提升).{0,12}(?:技能|属性)/],
  ['progress',persistentProgressPattern],
  ['random',/(?:掷出|骰出|骰点|掷得|\bd(?:20|6|100)\b|rolled?\s+\d+)/i],
];

/** Only diagnostic context for a prose-pattern rejection; never retain the full narration. */
export class NarrativePatternError extends GameError {
  constructor(
    public readonly patternKind:string,
    public readonly matchIndex:number,
    public readonly snippet:string,
  ) { super('场景描写超出了已结算的世界事实，本回合尚未提交，可以安全重试。',503); }
}

function matchedSnippet(prose:string,start:number,length:number){
  const from=Math.max(0,start-16),to=Math.min(prose.length,start+length+16);
  // Even a short narration must not be logged in full.
  const excerpt=from===0&&to===prose.length?prose.slice(start,start+length):prose.slice(from,to);
  return excerpt.replace(/\s+/g,' ').slice(0,100);
}

/** Reject prose that asserts mechanical effects absent from the committed program receipt. */
export function validateResolvedNarrative(receipt:Receipt,result:Narrative,hidden:boolean,compoundReceipts?:Receipt[]){
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
    }else if(!allowed.has(claim.kind as typeof receipt.effects[number]))throw new GameError('场景描写声称了未结算的世界变化',503);
  }
  const prose=[result.narrative,result.dialogue??''].join('\n');
  // A report of *not* finding anything is not a claim that new evidence was discovered.
  const positiveClaims=prose.replace(/(?:没有|未|没能|未能)(?:发现|找到|看出)[^。；，\n]{0,60}(?:线索|证据|暗门|秘密|机关|真相|痕迹)/g,'');
  for(const [kind,pattern] of mechanicalPatterns){
    const text=kind==='evidence'?positiveClaims:prose;
    const match=pattern.exec(text);
    if(match&&!allowed.has(kind as typeof receipt.effects[number]))
      throw new NarrativePatternError(kind,match.index,matchedSnippet(text,match.index,match[0].length));
  }
  const success=/成功|达成|得手|奏效|顺利完成/.test(prose),failure=/失败|未能|没能|未成功/.test(prose);
  if(hidden&&(success||failure))throw new GameError('场景描写泄露了尚未公开的判定结果，本回合尚未提交，可以安全重试。',503);
  if(['failure','critical_failure'].includes(receipt.outcome)&&success)throw new GameError('场景描写与程序判定相反，本回合尚未提交，可以安全重试。',503);
  if(['success','strong_success'].includes(receipt.outcome)&&failure)throw new GameError('场景描写与程序判定相反，本回合尚未提交，可以安全重试。',503);
  if((result.item_claims??[]).length||(result.stable_locations??[]).length||result.patches.length)throw new GameError('开放行动的场景描写不能自行写入实体或状态',503);
}

export function canonicalResolutionNarrative(receipt:Receipt,hidden:boolean){
  if(isActivePerception(receipt.semantic_action)){
    const discovered=receipt.canonical_facts.filter(fact=>fact.startsWith('发现已存在的证据：'));
    return discovered.length?`你仔细查看了眼前的情形。${discovered.map(fact=>fact.slice('发现已存在的证据：'.length)).join('；')}`:
      '你仔细观察了一会儿，在这次检查范围内暂时没有发现明显异常或新的线索。';
  }
  const outcome=hidden?'这次尝试已经进行，结果目前尚不可确认。':
    receipt.outcome==='partial_success'?'这次尝试取得了部分进展。':
    ['success','strong_success'].includes(receipt.outcome)?'这次尝试已完成。':'这次尝试没有达到预期。';
  const effects=receipt.effects.includes('inventory')?'已登记物品的位置随之更新。':
    receipt.effects.includes('position')?'你的位置已按实际行动更新。':'';
  return outcome+effects;
}
