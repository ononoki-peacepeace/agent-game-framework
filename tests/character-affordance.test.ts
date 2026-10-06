import {expect,it} from 'vitest';
import {groupAffordances} from '../src/client/affordances.js';
import type {ContextActionSuggestion,PublicActionMeta} from '../src/shared/contracts.js';
const action=(type:string,label:string):PublicActionMeta=>({type,label,visibility:'contextual',target_component:'character'});
it('groups concrete dialogue suggestions under one communication family',()=>{
 const suggestions:ContextActionSuggestion[]=[
  {target_id:'npc',label:'聊档案',intent:'问问档案'},{target_id:'npc',label:'聊工作',intent:'问问工作'},
  {target_id:'npc',label:'聊学舍',intent:'打听学舍'},{target_id:'npc',label:'聊最近的事',intent:'闲聊'},
 ];
 const groups=groupAffordances([action('INSPECT','观察'),action('APPROACH','接近'),action('INTERACT','互动')],suggestions);
 expect(groups.map(group=>group.label)).toEqual(['交流']);
 expect(groups.find(group=>group.label==='交流')?.items.map(item=>item.label)).toEqual(suggestions.map(item=>item.label));
});
it('exposes supported follow and attack families without turning them into a whitelist',()=>{
 const groups=groupAffordances([action('FOLLOW','跟踪'),action('ATTACK','攻击')],[{target_id:'thief',label:'保持距离跟踪',intent:'悄悄尾随',family:'follow'}]);
 expect(groups.map(group=>group.label)).toEqual(['跟踪']);expect(groups[0].items).toHaveLength(2);
 expect(groupAffordances([action('FOLLOW','跟踪'),action('ATTACK','攻击')],[],true).map(group=>group.label)).toEqual(['跟踪','攻击']);
});
