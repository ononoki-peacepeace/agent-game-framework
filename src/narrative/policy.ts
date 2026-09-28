import type { AIRole } from '../ai/contracts.js';
import type { RoleplayConfig } from './schema.js';
import type { z } from 'zod';
import type { lifeHorizonSchema } from './schema.js';

export const roleplayConstitution={
  version:1 as const,
  player_agency:'不得替玩家决定思想、感情、信念、主动言行或是否原谅；只描述外部可观察变化。',
  consequence_integrity:'玩家声明是行动尝试，不是成功事实；结果由能力、状态、距离、环境、正式规则和正式随机决定。',
  world_truth_stability:'玩家猜测、调查方向和叙事反转不得修改已经承诺的世界真相。',
  npc_autonomy:'NPC可以拒绝、离开、改变计划、失败、受伤或死亡，并在玩家不在场时继续行动。',
  information_boundary:'严格区分GM、NPC、玩家角色与玩家可见信息；只使用当前角色有权知道的内容。',
  quiet_life:'安静日常是合法状态，不因数个平静回合强行制造灾难。',
} as const;

export function roleplayPolicyFragment(role:AIRole,config:RoleplayConfig){
  const common=[roleplayConstitution.player_agency,roleplayConstitution.consequence_integrity,roleplayConstitution.world_truth_stability,roleplayConstitution.npc_autonomy,roleplayConstitution.quiet_life,'权威角色状态中的伤病、疲劳、疾病与年龄必须影响可行行动；不得让骨折角色下一回合无理由高速奔跑，也不得把普通小伤无理由升级为死亡。年龄是软影响，不是禁止冒险的硬阈值。'];
  if(role==='narrator')return [...common,roleplayConstitution.information_boundary,'你只叙述已经裁定的事实；不得改写判定、随机结果、NPC行动或创造关键事实。'].join('\n');
  if(role==='world_initializer')return [roleplayConstitution.world_truth_stability,'若世界 premise 包含核心谜团，应在玩家开局前给出稳定的幕后答案与证据承诺；不要写固定章节、最终Boss或结局。'].join('\n');
  if(role==='gm_reasoning')return [...common,roleplayConstitution.information_boundary,`死亡规则：${config.death_policy}。默认模式禁止无预警、无长期因果的普通随机永久死亡；玩家主动承担明显致命风险仍可死亡。`].join('\n');
  return common.join('\n');
}

export function defaultRoleplayConfig():RoleplayConfig{return {version:1,constitution_version:1,death_policy:'narrative_standard',narrative_mode:'standard',narrative_scale:'seasonal',major_arc_soft_cap:3,major_open_loop_soft_cap:5,life_horizon:{kind:'species_normal',target_age_min:70,target_age_max:100,basis:'未提供种族寿命时采用人类常见范围，仅作为叙事节奏参考'}};}
export function suggestLifeHorizon(input:{species?:string;premise?:string;rules?:string[]}):z.infer<typeof lifeHorizonSchema>{const context=[input.species,input.premise,...(input.rules??[])].filter(Boolean).join(' ');if(/永生|不老|immortal/i.test(context))return {kind:'ai_suggested',target_age_min:500,target_age_max:1000,basis:'世界设定暗示极长寿命；这是节奏范围，不是死亡年龄，也不等同于不死'};if(/精灵|长寿|elf/i.test(context))return {kind:'ai_suggested',target_age_min:200,target_age_max:300,basis:'根据长寿种族与世界设定给出的软性范围'};if(/短命|速生|goblin/i.test(context))return {kind:'ai_suggested',target_age_min:30,target_age_max:50,basis:'根据短寿种族与世界设定给出的软性范围'};if(/未来|生命延长|魔法医疗|再生/i.test(context))return {kind:'ai_suggested',target_age_min:100,target_age_max:160,basis:'根据世界科技或魔法医疗水平给出的软性范围'};return {kind:'ai_suggested',target_age_min:70,target_age_max:100,basis:'根据当前角色身份与世界规则给出的初始软性范围'};}
