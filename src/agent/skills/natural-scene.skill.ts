import {runSceneInteraction,type SceneRepair} from '../scene-interaction.js';
import type {PublicView} from '../../shared/contracts.js';
import type {AgentSkill} from './types.js';

export const naturalSceneSkill:AgentSkill<{view:PublicView;input:string;partner:{id:string};
  speechMode:'none'|'verbatim'|'intent'|null;repair?:SceneRepair;
  phase?:'interaction'|'arrival';speechOnly?:boolean;audienceIds?:string[]},Awaited<ReturnType<typeof runSceneInteraction>>>= {
  id:'natural_scene',description:'Propose an open scene beat against real people, relationships and player authorization.',
  allowedTools:['inspect_scene','propose_natural_scene'],
  execute({view,input,partner,speechMode,repair,phase,speechOnly,audienceIds},context){
    return runSceneInteraction(context.service,context.save,view,input,partner,speechMode,repair,phase,undefined,speechOnly,audienceIds);
  },
};
