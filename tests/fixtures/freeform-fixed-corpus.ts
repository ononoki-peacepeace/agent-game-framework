import type {parseFreeformProposal} from '../../src/core/freeform.js';
type FreeformProposal=ReturnType<typeof parseFreeformProposal>;

export const freeformCorpus=[
 {id:'contact-injury',input:'尝试打击林舟',kind:'physical',rolls:[.99,.01,.99,.01],outcome:'success',contact:true,harmed:true,
  text:'这次接触已经成立，林舟受伤了。'},
 {id:'contact-miss',input:'尝试打击林舟',kind:'physical',rolls:[.01,.99],outcome:'critical_failure',contact:false,harmed:false,
  text:'本次没能建立接触，没有结算伤害。'},
 {id:'contact-only',input:'尝试打击林舟',kind:'physical',rolls:[.99,.01,.01,.99],outcome:'partial_success',contact:true,harmed:false,
  text:'这次接触已经成立，但没有造成伤害。'},
 {id:'pickup-success',input:'拿起纸片',kind:'pickup',rolls:[.99],outcome:'success',held:true,text:'你拿起纸片。'},
 {id:'pickup-failure',input:'拿起纸片',kind:'pickup',rolls:[.01],outcome:'critical_failure',held:false,text:'这次没有拿起纸片。'},
 {id:'ordinary-activity',input:'整理已有记录两分钟',kind:'activity',rolls:[],outcome:'success',text:'你整理了一会儿已有记录。'},
] as const;
export type FreeformCorpusSample=typeof freeformCorpus[number];
export function corpusProposal(sample:FreeformCorpusSample):FreeformProposal{
 const base:FreeformProposal={narrative:'候选行动',minutes:sample.kind==='activity'?2:1,target_id:sample.kind==='physical'?'npc_lin':null,
  facts:[],relationship:null,resolution:{type:sample.kind==='physical'?'OPPOSED_CHECK':sample.kind==='pickup'?'SIMPLE_CHECK':'DETERMINISTIC',
   domain:sample.kind==='physical'?'physique':'general',opposition_domain:sample.kind==='physical'?'agility':null,
   band:'normal',visibility:'public',stakes:'固定跨世界尝试',stages:sample.kind==='physical'?[{id:'contact',band:'normal'},{id:'injury',band:'normal'}]:[],evidence_ids:[]}};
 return {...base,...(sample.kind==='physical'?{physical_action:{kind:'harm' as const,source_quote:sample.input,contact_stage_id:'contact',
  injury_stage_id:'injury',harm_level:'minor' as const,surprise_attempt:false,mechanism:'direct_force' as const,hazard_source:null}}:{}),
  ...(sample.kind==='pickup'?{item_move:{item_id:'qa_paper',to:'held' as const,position_label:null}}:{})};
}
