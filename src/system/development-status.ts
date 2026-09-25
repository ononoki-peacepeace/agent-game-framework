import type { DevelopmentTask } from '../extensions/tasks.js';

export type DevelopmentLifecycle = 'planning'|'waiting_for_clarification'|'waiting_for_confirmation'|'waiting_for_core_approval'|'developing'|'validating'|'paused'|'installed'|'failed'|'cancelled';
export interface DevelopmentProjection { task_id:string; task_status:DevelopmentTask['status']; lifecycle:DevelopmentLifecycle; label:string; terminal:boolean; completed:boolean }

/** DevelopmentTask is canonical; SystemSession and UI only project it through this function. */
export function developmentProjection(task:Pick<DevelopmentTask,'id'|'status'>):DevelopmentProjection {
 const projected:Record<DevelopmentTask['status'],[DevelopmentLifecycle,string,boolean]>={
  planning:['planning','正在完善',false],waiting_for_user:['waiting_for_clarification','等待你补充',false],waiting_for_core_approval:['waiting_for_core_approval','等待审阅',false],
  developing:['developing','正在制作',false],testing:['validating','正在验证',false],repairing:['validating','正在修复并验证',false],ready_for_preview:['waiting_for_confirmation','等待你确认安装',false],
  paused:['paused','已暂停',false],installed:['installed','已完成',true],failed:['failed','失败',true],cancelled:['cancelled','已取消',true],
 };
 const [lifecycle,label,terminal]=projected[task.status];
 return {task_id:task.id,task_status:task.status,lifecycle,label,terminal,completed:task.status==='installed'};
}
