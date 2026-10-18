import {z,type ZodType} from 'zod';
import type {ModuleRegistry} from '../../core/registry.js';

export interface ToolDescriptor {
  id:string;
  description:string;
  inputSchema:ZodType;
  outputType:string;
  sideEffect:'read_only'|'world_mutation';
  authority:'model'|'core'|'transaction';
  persistentEffect:boolean;
  implementation:string;
}

/** Metadata over real domain operations; invocation remains with their existing owners. */
export class ToolCatalog {
  private readonly entries=new Map<string,ToolDescriptor>();
  register(tool:ToolDescriptor){
    if(this.entries.has(tool.id))throw Error(`Duplicate tool: ${tool.id}`);
    this.entries.set(tool.id,tool);
  }
  get(id:string){return this.entries.get(id)??null;}
  list(){return [...this.entries.values()];}
}

export function existingToolCatalog(actions:ModuleRegistry):ToolCatalog{
  const tools=new ToolCatalog();
  const add=(tool:ToolDescriptor)=>tools.register(tool);
  add({id:'read_world_state',description:'Read the current canonical world snapshot.',
    inputSchema:z.strictObject({}),outputType:'SavePackage',sideEffect:'read_only',authority:'core',
    persistentEffect:false,implementation:'GameService.current'});
  add({id:'inspect_scene',description:'Project currently visible scene facts.',
    inputSchema:z.strictObject({}),outputType:'PublicView',sideEffect:'read_only',authority:'core',
    persistentEffect:false,implementation:'GameService.project'});
  for(const [id,description] of [
    ['MOVE','Move through a registered route.'],['WAIT','Advance world time in one validated player action.'],
  ] as const){
    if(!actions.actions.has(id))continue;
    add({id:id.toLowerCase(),description,inputSchema:actions.actions.get(id).parameters,
      outputType:'PublicView + resolution receipt',sideEffect:'world_mutation',authority:'transaction',
      persistentEffect:true,implementation:`Core action ${id} via GameService.turn`});
  }
  add({id:'search_world',description:'Review known, discoverable or world-supported locations.',
    inputSchema:z.strictObject({query:z.string().min(1)}),outputType:'LocationSearch result',
    sideEffect:'world_mutation',authority:'transaction',persistentEffect:true,
    implementation:'exploreLocation + applyLocationSearch + GameService.agentTransaction'});
  add({id:'propose_natural_scene',description:'Generate a scene proposal from canonical people and context.',
    inputSchema:z.strictObject({input:z.string().min(1),partner_id:z.string().min(1)}),
    outputType:'SceneOutcome | null',sideEffect:'read_only',authority:'model',persistentEffect:false,
    implementation:'runSceneInteraction; effects settle through existing transactions'});
  add({id:'validate_background_proposal',description:'Validate causal world evolution, including a needed NPC.',
    inputSchema:z.strictObject({}),outputType:'Validated background proposal',sideEffect:'read_only',
    authority:'core',persistentEffect:false,implementation:'proposeValidatedBackground'});
  return tools;
}
