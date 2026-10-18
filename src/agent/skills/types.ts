import type {SavePackage} from '../../core/schema.js';
import type {GameService} from '../../server/service.js';

export interface SkillContext {
  service:GameService;
  save:SavePackage;
  request_id:string;
  goal_id?:string|null;
}

/** A high-level adapter over existing services. Core remains the only writer of world state. */
export interface AgentSkill<Request,Result> {
  id:string;
  description:string;
  allowedTools:readonly string[];
  execute?:(request:Request,context:SkillContext)=>Promise<Result>;
}
