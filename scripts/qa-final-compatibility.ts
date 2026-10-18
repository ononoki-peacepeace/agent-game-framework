import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {validateSave,newSave} from '../src/core/state.js';
import {prepareCheck} from '../src/core/resolution.js';
import {compileWorld} from '../src/ai/authoring.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {worldCandidateIssues} from '../src/ai/world-initializer-repair.js';
const bytes=await readFile('data/current.json'),raw=JSON.parse(bytes.toString('utf8')),save=validateSave(structuredClone(raw));
const people=save.entities.filter(e=>e.id===save.player_state.entity_id||e.components.character),before=JSON.stringify(save);
const modifiers=people.map(person=>prepareCheck(save,randomUUID(),{type:'SIMPLE_CHECK',domain:'physique',band:'normal'},person.id).actor_modifier);
const bp=JSON.parse(await readFile('content/worlds/town-blueprint.json','utf8'));
bp.capability_profiles=[bp.player,...bp.characters].map((e:any,i:number)=>({entity_id:e.id,attributes:{strength:i===0?3:0,agility:i===0?0:2},skills:[],basis:'隔离验证明确登记的训练依据，非正式人物迁移'}));
const draft=worldInitializationSchema.parse(bp),world=compileWorld(draft,save.definition.prompt_profile),fresh=newSave(world);
const result={official_revision:raw.state_revision,official_sha256_before:createHash('sha256').update(bytes).digest('hex'),legacy_valid:true,
 people:people.length,attribute_holders:people.filter(e=>e.components.attributes).length,skill_holders:people.filter(e=>e.components.skills).length,
 base_modifiers:modifiers,prepare_does_not_mutate:before===JSON.stringify(save),new_world_candidate_issues:worldCandidateIssues(draft),
 new_world_people:fresh.entities.filter(e=>e.id===fresh.player_state.entity_id||e.components.character).length,
 new_world_profiles:fresh.entities.filter(e=>e.components.attributes).length,
 new_world_reload_valid:!!validateSave(JSON.parse(JSON.stringify(fresh))),
 official_sha256_after:createHash('sha256').update(await readFile('data/current.json')).digest('hex')};
await writeFile('.tmp/qa-final-compatibility.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
