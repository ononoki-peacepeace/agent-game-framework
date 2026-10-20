import {createHash} from 'node:crypto';
import {z} from 'zod';
import {assert,dictionary,integer,rulesSchema,type SavePackage} from '../core/schema.js';
import {validateSave} from '../core/state.js';
import {relationshipReceiptKind} from './npc-relations.js';
import type {GameService} from '../server/service.js';

const selectionSchema=dictionary(rulesSchema.shape.relationship_dimensions.valueType.shape.event_deltas.unwrap())
 .refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=100,'请明确选择要启用的关系政策');
const previewSchema=z.strictObject({version:z.literal(1),game_id:z.string().uuid(),source_revision:integer,
 source_sha256:z.string().regex(/^[a-f0-9]{64}$/),policies:selectionSchema,
 processed_receipt_ids:z.array(z.string().min(1).max(100)).max(200)});
const requestSchema=z.strictObject({game_id:z.string().uuid(),expected_revision:integer,request_id:z.string().uuid()});
export type LegacyRelationshipPolicyPreview=z.infer<typeof previewSchema>;
const sourceHash=(save:SavePackage)=>createHash('sha256').update(JSON.stringify(save)).digest('hex');

/** Explicit author data only; this function is never called by load/migration or
 * a model. It returns a small review artifact, without copying private world data. */
export function previewLegacyRelationshipPolicies(source:SavePackage,input:unknown):LegacyRelationshipPolicyPreview{
 const save=validateSave(source),selected=selectionSchema.parse(input);
 assert(save.definition.enabled_modules.includes('relationships'),'当前世界没有关系模块');
 const dimensions=save.definition.ruleset.relationship_dimensions;
 assert(Object.values(dimensions).every(dimension=>dimension.event_deltas===undefined),'此入口仅用于尚未配置事件政策的旧世界');
 assert((save.resolution_receipts??[]).every(receipt=>!receipt.result_entities?.relationship_settlement?.length||
  receipt.result_entities.relationship_settlement.includes('v1')),'存在未知版本的关系结算标记，不能自动迁移');
 const policies=Object.fromEntries(Object.entries(selected).sort(([a],[b])=>a.localeCompare(b)));
 for(const id of Object.keys(policies))assert(Object.hasOwn(dimensions,id),'不能为未知关系维度启用政策');
 const preview:LegacyRelationshipPolicyPreview={version:1,game_id:save.game_id,source_revision:save.state_revision,source_sha256:sourceHash(save),policies,
  processed_receipt_ids:(save.resolution_receipts??[]).filter(receipt=>relationshipReceiptKind(save,receipt)).map(receipt=>receipt.request_id)};
 candidate(save,preview);return preview;
}
function candidate(save:SavePackage,preview:LegacyRelationshipPolicyPreview){
 const next=structuredClone(save),processed=new Set(preview.processed_receipt_ids);
 for(const receipt of next.resolution_receipts??[])if(processed.has(receipt.request_id)){
  receipt.result_entities??={};receipt.result_entities.relationship_settlement=['v1'];
 }
 for(const [id,policy] of Object.entries(preview.policies))next.definition.ruleset.relationship_dimensions[id].event_deltas=policy;
 return validateSave(next);
}
/** Optional internal authoring API, deliberately without an HTTP route or CLI.
 * Existing transaction identity/Undo handles a response lost after the one-image commit. */
export async function activateLegacyRelationshipPolicies(service:Pick<GameService,'agentTransaction'>,
 request:{game_id:string;expected_revision:number;request_id:string},input:LegacyRelationshipPolicyPreview){
 const preview=previewSchema.parse(input),tx=requestSchema.parse(request);
 assert(tx.game_id===preview.game_id&&tx.expected_revision===preview.source_revision,'政策预览与请求身份不一致');
 return service.agentTransaction(tx,{legacy_relationship_policy_activation:preview},save=>{
  assert(sourceHash(validateSave(save))===preview.source_sha256,'政策预览后世界已改变，请重新预览');
  const expected=previewLegacyRelationshipPolicies(save,preview.policies);
  assert(JSON.stringify(expected)===JSON.stringify(preview),'政策预览内容不一致，请重新预览');
  const next=candidate(save,preview);save.definition=next.definition;save.resolution_receipts=next.resolution_receipts;
 });
}
