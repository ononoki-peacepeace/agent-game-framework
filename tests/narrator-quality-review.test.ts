import {expect,it} from 'vitest';
import {validateNarratorQualityReview} from '../scripts/lib/narrator-quality-review.js';
const h='a'.repeat(64),packet={manifest_sha256:h,cases:[{id:'fixture',dimensions:['voice','naturalness'],records:[{file:'fixture.json',sha256:h,provenance:'authored_control_not_model_voice'}]}],pairs:[{id:'paired',left:'fixture',right:'fixture'}]};
const review=()=>({manifest_sha256:h,reviewer:{id:'synthetic-test-only',role:'human',attestation:'Synthetic validator test, not a real review'},
 cases:[{id:'fixture',record_hashes:[h],hard_gates:[true,true,true,true],ratings:[{dimension:'voice',score:2,evidence:'synthetic anchor'},
 {dimension:'naturalness',score:2,evidence:'synthetic anchor'}]}],pairs:[{id:'paired',distinguished:true,evidence:'synthetic pair'}]});
it('never converts a declared human role or passing fixture ratings into real-provider/condition evidence',()=>{
 const result=validateNarratorQualityReview(packet,review());expect(result.complete).toBe(true);expect(result.meets_declared_rubric).toBe(true);
 expect(result.controlled_cases).toEqual(['fixture']);expect(result.conditions_awarded).toEqual([]);
 expect(result.requires_external_identity_and_authorization_verification).toBe(true);
});
it.each(['hash','missing','dimension','duplicate','pair'] as const)('rejects incomplete/tampered %s review',mode=>{
 const r=review();if(mode==='hash')r.cases[0].record_hashes=['b'.repeat(64)];
 if(mode==='missing')r.cases=[];if(mode==='dimension')r.cases[0].ratings.pop();
 if(mode==='duplicate')r.cases.push(r.cases[0]);if(mode==='pair')r.pairs=[];
 expect(validateNarratorQualityReview(packet,r).complete).toBe(false);
});
it('cannot average away a fact failure or a low quality dimension',()=>{
 const r=review();r.cases[0].hard_gates[0]=false;expect(validateNarratorQualityReview(packet,r).meets_declared_rubric).toBe(false);
 r.cases[0].hard_gates[0]=true;r.cases[0].ratings[0].score=1;expect(validateNarratorQualityReview(packet,r).meets_declared_rubric).toBe(false);
});
it('leaves blank review cells invalid instead of creating automatic ratings',()=>{
 expect(()=>validateNarratorQualityReview(packet,{...review(),cases:null})).toThrow();
});
