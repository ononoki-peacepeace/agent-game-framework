import type {SavePackage} from './schema.js';

/** Contents need an accessible path through every containing item. The anchor's
 * own seal does not hide its exterior or prevent moving the container itself. */
export function unsealedContainerAncestors(save:SavePackage,anchor:SavePackage['entities'][number],actorId?:string){
  const holders=save.entities.filter(entity=>Number((entity.components.inventory?.items as Record<string,number>|undefined)?.[anchor.id]??0)>0);
  // A stack ID is a commodity definition and can occur in several inventories.
  // Only an explicit owning actor selects that actor's container path. Scene
  // inspection and single-entity movement retain the conservative default.
  const holder=actorId?holders.find(entity=>entity.id===actorId):holders[0];
  if((holders.length>1&&(!actorId||anchor.components.item?.stackable!==true))||(actorId&&holders.length>0&&!holder))return false;
  const placements=holder?.components.inventory?.placements as Record<string,string|null>|undefined;
  const parentOf=(entity:SavePackage['entities'][number])=>{
    if(holders.length)return placements?.[entity.id];
    const parentId=entity.components.item?.container_id;return typeof parentId==='string'?parentId:null;
  };
  const seen=new Set([anchor.id]);let parentId=parentOf(anchor);
  while(parentId){
    if(seen.has(parentId))return false;seen.add(parentId);
    const parent=save.entities.find(entity=>entity.id===parentId);
    if(parent?.components.item?.container!==true||(parent.components.item.tags as string[]|undefined)?.includes('sealed'))return false;
    parentId=parentOf(parent);
  }
  return true;
}
