import {z} from 'zod';
import {id,type SavePackage} from './schema.js';
import {currentMap,localHierarchyTransition,routePath} from './map.js';
import {createRegistry} from '../modules/index.js';
import type {Inventory} from '../modules/inventory.js';

export const requirementSchema=z.strictObject({
  kind:z.enum(['entity_exists','same_location','item_held','item_accessible','destination_reachable','capability']),
  subject_id:z.string().min(1).max(100),
});
export type Requirement=z.infer<typeof requirementSchema>;
export type PrerequisiteResult={status:'EXECUTABLE'|'CONDITIONALLY_EXECUTABLE'|'NOT_EXECUTABLE';
  checked:{kind:string;subject_id:string|null;satisfied:true}[];reason:string|null};

/** Pure canonical check shared by free actions and structured choice visibility. */
export function evaluateWorldPrerequisites(save:SavePackage,input:{target_id?:string|null;requirements?:Requirement[];item_move?:{item_id:string;to:'held'|'scene'|'target'}|null}):PrerequisiteResult{
  const player=save.entities.find(entity=>entity.id===save.player_state.entity_id)!;
  const here=player.components.location?.location_id?String(player.components.location.location_id):undefined;
  const inventory=(player.components.inventory as Inventory|undefined)?.items??{};
  const map=currentMap(save),locations=new Set(map.locations.map(location=>location.id));
  const checked:PrerequisiteResult['checked']=[];
  const fail=(reason:string):PrerequisiteResult=>({status:'NOT_EXECUTABLE',checked,reason});
  const test=(kind:string,subject_id:string|null,valid:boolean,reason:string)=>{
    if(!valid)return fail(reason);
    checked.push({kind,subject_id,satisfied:true as const});return null;
  };
  if(input.target_id){
    const target=save.entities.find(entity=>entity.id===input.target_id);
    const failure=test('entity_exists',input.target_id,Boolean(target),'行动目标不存在');if(failure)return failure;
    if(target?.components.character){
      const proximity=test('same_location',target.id,Boolean(here&&target.components.location?.location_id===here),'目标不在当前场景');
      if(proximity)return proximity;
    }
  }
  const requirements=[...(input.requirements??[])];
  if(input.item_move){requirements.push({kind:input.item_move.to==='held'||input.item_move.to==='scene'?'item_accessible':'item_held',subject_id:input.item_move.item_id});
    const capability=test('capability','inventory',save.definition.enabled_modules.includes('inventory'),'当前世界没有物品存取能力');if(capability)return capability;}
  for(const requirement of requirements){
    const subject=save.entities.find(entity=>entity.id===requirement.subject_id);
    let valid=false,reason='行动所需的世界条件尚未成立';
    switch(requirement.kind){
      case 'entity_exists':valid=Boolean(subject);reason='所需对象在当前世界状态中不存在';break;
      case 'same_location':valid=Boolean(here&&(locations.has(requirement.subject_id)?requirement.subject_id===here:subject?.components.location?.location_id===here));reason='所需对象不在当前场景';break;
      case 'item_held':valid=Boolean(subject?.components.item&&(inventory[subject.id]??0)>0);reason='角色没有持有所需物品';break;
      case 'item_accessible':valid=Boolean(subject?.components.item&&((inventory[subject.id]??0)>0||Boolean(here&&subject.components.location?.location_id===here)));reason='所需物品不在角色可触及的范围';break;
      case 'destination_reachable':valid=Boolean(here&&locations.has(requirement.subject_id)&&(here===requirement.subject_id||localHierarchyTransition(save,here,requirement.subject_id)||routePath(map.routes,here,requirement.subject_id)?.length));reason='目标地点当前不可到达';break;
      case 'capability':valid=createRegistry(save.definition.enabled_modules).capabilities.has(requirement.subject_id);reason='当前世界尚无执行该行动所需能力';break;
    }
    const failure=test(requirement.kind,requirement.subject_id,valid,reason);if(failure)return failure;
  }
  return {status:'EXECUTABLE',checked,reason:null};
}
