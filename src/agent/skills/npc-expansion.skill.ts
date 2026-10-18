import type {AgentSkill} from './types.js';

/** The existing causal background generator may spawn an NPC; there is no safe standalone NPC executor yet. */
export const npcExpansionSkill:AgentSkill<never,never>={
  id:'npc_expansion',description:'Metadata for validated causal NPC emergence within background world evolution.',
  allowedTools:['read_world_state','validate_background_proposal'],
};
