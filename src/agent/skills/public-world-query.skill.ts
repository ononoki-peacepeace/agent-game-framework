import {deriveWorldQuery,type TruthQueryResult} from '../truth-query.js';
import type {PublicView} from '../../shared/contracts.js';
import type {AgentSkill} from './types.js';

/** Public evidence and answer validation remain owned by the existing truth query. */
export const publicWorldQuerySkill:AgentSkill<{view:PublicView;question:string},TruthQueryResult>={
  id:'public_world_query',
  description:'Answer a world fact, inference or rule question from player-visible evidence only.',
  allowedTools:['read_world_state','inspect_scene'],
  execute({view,question},context){return deriveWorldQuery(context.service,view,question);},
};
