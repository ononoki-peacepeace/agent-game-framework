import {exploreLocation} from '../location-exploration.js';
import type {AgentSkill} from './types.js';

export const locationExplorationSkill:AgentSkill<{query:string;request_id:string;scope?:Parameters<typeof exploreLocation>[4]},
  Awaited<ReturnType<typeof exploreLocation>>>={
  id:'location_exploration',description:'Find or responsibly discover a place using existing world review and transaction rules.',
  allowedTools:['read_world_state','inspect_scene','search_world'],
  execute({query,request_id,scope},context){return exploreLocation(context.service,context.save,query,request_id,scope);},
};
