import type {SavePackage} from '../core/schema.js';
type Receipt=NonNullable<SavePackage['resolution_receipts']>[number];

/** Presentation of an existing result, never an alternative physical resolver.
 * A failed opposed roll does not record evasion, a block or a counterattack. */
export function physicalPresentation(receipt:Receipt,hidden=false){
 const p=receipt.physical_outcome;if(!p)return null;
 return {forms:p.action_forms??[],kind:p.kind,
  contact:hidden?null:p.contact,harmed:hidden?null:p.harmed,
  control_established:hidden?null:(p.control_established??(p.kind==='restrain'&&['success','strong_success'].includes(receipt.outcome))),
  cause:null,
  boundary:'动作形式表示本次尝试的手段，不代表每一步都成功。接触、伤害、控制分别以对应字段为准；null 表示尚不可确认。没有具体原因凭据时，不把失败写成躲避、格挡、反击或环境阻挡；伤害不证明具体伤口、部位、流血或倒地。'};
}

export function physicalOutcomeProse(receipt:Receipt,name='对方',hidden=false){
 const p=physicalPresentation(receipt,hidden);if(!p)return null;
 const forms=p.forms.filter(form=>form!=='other');
 const form=forms.length===1?forms[0]:null;
 const attempt=form==='strike'?`你向${name}击去`:form==='push'?`你推向${name}`:
  form==='restrain'||!forms.length&&p.kind==='restrain'?`你伸手抓向${name}`:
  forms.length>1?`你试图对${name}${forms.map(value=>({strike:'击打',push:'推搡',restrain:'施加控制'})[value]).join('并')}`:
  `你向${name}出手`;
 if(hidden)return `${attempt}，眼下还看不清结果。`;
 if(!p.contact)return `${attempt}，但没能碰到对方。`;
 const contact=form==='strike'?`你击中了${name}`:`${attempt}，碰到了对方`;
 const control=p.control_established?`你暂时控制住了${name}。`:
  (p.kind==='restrain'||forms.includes('restrain'))?`${attempt}，碰到了对方，却没能控制住对方。`:null;
 if(p.harmed)return `${contact}，造成了伤害。${control??''}`;
 if(control)return `${control}${p.kind==='harm'?'这次接触没有造成伤害。':''}`;
 return `${contact}，但这次接触没有造成伤害。`;
}
