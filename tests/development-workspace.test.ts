import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { draftSlot, loadDevelopmentWorkspace, saveDevelopmentDraft, saveDevelopmentWorkspace } from '../src/client/development-workspace.js';

class MemoryStorage {
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
}

describe('development workspace continuity',()=>{
  it('restores the active task, UI state and unsent drafts per game and task',()=>{
    const storage=new MemoryStorage();
    saveDevelopmentWorkspace('game-a',{active_task_id:'task-a',dev_open:true,advanced_open:true},storage);
    saveDevelopmentDraft('game-a','task-a','已经写了五百字的修改要求',storage);
    saveDevelopmentDraft('game-a',null,'新任务草稿',storage);
    const restored=loadDevelopmentWorkspace('game-a',storage);
    expect(restored).toMatchObject({active_task_id:'task-a',dev_open:true,advanced_open:true});
    expect(restored.drafts[draftSlot('task-a')]).toBe('已经写了五百字的修改要求');
    expect(restored.drafts[draftSlot(null)]).toBe('新任务草稿');
    expect(loadDevelopmentWorkspace('game-b',storage).active_task_id).toBeNull();
  });

  it('keeps the old task draft while selecting a new workspace slot',()=>{
    const storage=new MemoryStorage();
    saveDevelopmentDraft('game','task','未提交内容',storage);
    saveDevelopmentWorkspace('game',{active_task_id:null,dev_open:true},storage);
    expect(loadDevelopmentWorkspace('game',storage).drafts.task).toBe('未提交内容');
  });

  it('the UI has automatic persistence and the three protected new-task choices',async()=>{
    const panel=await readFile('src/client/DevelopmentPanel.tsx','utf8'),system=await readFile('src/client/SystemPanel.tsx','utf8');
    expect(panel).toContain('saveDevelopmentDraft');
    expect(panel).toContain('保留草稿并新建');
    expect(panel).toContain('继续当前任务');
    expect(panel).toContain('丢弃草稿并新建');
    expect(system).toContain('loadDevelopmentWorkspace(view.game_id)');
  });
});

