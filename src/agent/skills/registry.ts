import {currentTrace} from '../../observability/trace.js';
import {failureReason} from '../../ai/failures.js';
import type {AgentSkill,SkillContext} from './types.js';
import type {ToolCatalog} from './tools.js';

export class SkillRegistry {
  private readonly entries=new Map<string,AgentSkill<any,any>>();
  constructor(readonly tools:ToolCatalog){}
  register<Request,Result>(skill:AgentSkill<Request,Result>){
    if(this.entries.has(skill.id))throw Error(`Duplicate skill: ${skill.id}`);
    for(const tool of skill.allowedTools)if(!this.tools.get(tool))throw Error(`Unknown allowed tool: ${tool}`);
    this.entries.set(skill.id,skill);
  }
  get(id:string){return this.entries.get(id)??null;}
  list(){return [...this.entries.values()].map(({id,description,allowedTools,execute})=>({
    id,description,allowedTools:[...allowedTools],executable:Boolean(execute)}));}
  async invoke<Request,Result>(id:string,request:Request,context:SkillContext):Promise<Result>{
    const skill=this.get(id);
    if(!skill)throw Error(`Unknown skill: ${id}`);
    if(!skill.execute)throw Error(`Skill is metadata-only: ${id}`);
    const trace=currentTrace();
    const before=context.save,started=performance.now();
    const timeBefore={...before.runtime.time};
    const base={skill_id:id,goal_id:context.goal_id??null,request_id:context.request_id,
      revision_before:before.state_revision,time_before:timeBefore};
    trace?.info('skill.selected',{module:'agent',metadata:{...base,allowed_tools:skill.allowedTools}});
    trace?.info('skill.started',{module:'agent',metadata:base});
    try{
      const result=await skill.execute(request,context) as Result;
      const after=await context.service.current();
      const candidate=result as {outcome?:{type?:string;kind?:string;code?:string;stage?:string;
        receipt_ids?:string[]};kind?:string;status?:string}|null;
      const outcome=candidate?.outcome;
      const metadata={...base,revision_after:after.state_revision,time_after:after.runtime.time,
        duration_ms:Math.round(performance.now()-started),outcome:outcome?.kind??candidate?.kind??candidate?.status??null,
        receipt_ids:outcome?.receipt_ids??[],failure_code:outcome?.type==='engine_failure'?outcome.code:null,
        failure_stage:outcome?.type==='engine_failure'?outcome.stage:null};
      trace?.info(outcome?.kind==='interrupted'?'skill.interrupted':'skill.completed',
        {module:'agent',metadata});
      return result;
    }catch(error){
      const after=await context.service.current().catch(()=>null);
      trace?.warn('skill.failed',{module:'agent',metadata:{...base,
        revision_after:after?.state_revision??null,time_after:after?.runtime.time??null,
        duration_ms:Math.round(performance.now()-started),outcome:'engine_failure',
        receipt_ids:[],failure_code:failureReason(error),failure_stage:'skill_execute'}});
      throw error;
    }
  }
}
