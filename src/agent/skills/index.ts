import {createRegistry} from '../../modules/index.js';
import type {SavePackage} from '../../core/schema.js';
import {SkillRegistry} from './registry.js';
import {existingToolCatalog} from './tools.js';
import {temporalWaitSkill} from './temporal-wait.skill.js';
import {locationExplorationSkill} from './location-exploration.skill.js';
import {naturalSceneSkill} from './natural-scene.skill.js';
import {npcExpansionSkill} from './npc-expansion.skill.js';
import {publicWorldQuerySkill} from './public-world-query.skill.js';

export function agentSkills(save:SavePackage){
  const skills=new SkillRegistry(existingToolCatalog(createRegistry(save.definition.enabled_modules)));
  skills.register(temporalWaitSkill);
  skills.register(locationExplorationSkill);
  skills.register(naturalSceneSkill);
  skills.register(publicWorldQuerySkill);
  skills.register(npcExpansionSkill);
  return skills;
}
