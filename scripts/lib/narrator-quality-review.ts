import {z} from 'zod';
const dimension=z.enum(['voice','rhythm','perception','naturalness','continuity']);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const reviewPacketSchema=z.object({manifest_sha256:hash,cases:z.array(z.object({id:z.string(),dimensions:z.array(dimension),
 records:z.array(z.object({file:z.string(),sha256:hash,provenance:z.string()})).min(1)})).min(1),
 pairs:z.array(z.object({id:z.string(),left:z.string(),right:z.string()}))});
const judgment=z.strictObject({dimension,score:z.number().int().min(0).max(3).nullable(),
 evidence:z.string().trim().min(1),na_reason:z.string().trim().min(1).optional()});
export const qualityReviewSchema=z.strictObject({manifest_sha256:hash,
 reviewer:z.strictObject({id:z.string().trim().min(1),role:z.enum(['developer','human','independent']),attestation:z.string().trim().min(1)}),
 cases:z.array(z.strictObject({id:z.string(),record_hashes:z.array(hash).min(1),hard_gates:z.array(z.boolean()).length(4),ratings:z.array(judgment)})),
 pairs:z.array(z.strictObject({id:z.string(),distinguished:z.boolean(),evidence:z.string().trim().min(1)}))});

/** Structural/anchored review checks, never an authentication of a human or a fixed-condition score. */
export function validateNarratorQualityReview(packetInput:unknown,reviewInput:unknown){
 const packet=reviewPacketSchema.parse(packetInput),review=qualityReviewSchema.parse(reviewInput),errors:string[]=[];
 if(packet.manifest_sha256!==review.manifest_sha256)errors.push('manifest mismatch');
 const ids=(items:{id:string}[])=>items.map(c=>c.id).sort();
 if(JSON.stringify(ids(packet.cases))!==JSON.stringify(ids(review.cases)))errors.push('case inventory mismatch');
 if(new Set(ids(review.cases)).size!==review.cases.length)errors.push('duplicate case');
 for(const expected of packet.cases){
  const found=review.cases.find(c=>c.id===expected.id);if(!found)continue;
  if(JSON.stringify([...found.record_hashes].sort())!==JSON.stringify(expected.records.map(r=>r.sha256).sort()))errors.push(`${expected.id}: record hash mismatch`);
  if(JSON.stringify(found.ratings.map(r=>r.dimension).sort())!==JSON.stringify([...expected.dimensions].sort()))errors.push(`${expected.id}: dimension inventory mismatch`);
  for(const rating of found.ratings)if(rating.score===null&&!rating.na_reason)errors.push(`${expected.id}: N/A needs reason`);
 }
 if(JSON.stringify(ids(packet.pairs))!==JSON.stringify(ids(review.pairs)))errors.push('pair inventory mismatch');
 if(new Set(ids(review.pairs)).size!==review.pairs.length)errors.push('duplicate pair');
 const rubricPass=errors.length===0&&review.cases.every(c=>c.hard_gates.every(Boolean)&&c.ratings.every(r=>r.score===null||r.score>=2))&&review.pairs.every(p=>p.distinguished);
 return {errors,complete:errors.length===0,meets_declared_rubric:rubricPass,declared_reviewer_role:review.reviewer.role,
  requires_external_identity_and_authorization_verification:true,
  controlled_cases:packet.cases.filter(c=>c.records.some(r=>r.provenance!=='authorized_real_provider')).map(c=>c.id),
  conditions_awarded:[]};
}
