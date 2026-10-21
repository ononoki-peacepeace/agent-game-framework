import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {worldSchema,profileSchema} from '../src/core/schema.js';
import {worldInitializationSchema} from '../src/ai/contracts.js';
import {compileWorld} from '../src/ai/authoring.js';
import {newSave,validateSave,publicView} from '../src/core/state.js';
import {normalizeCharacterCard} from '../src/compat/character-card.js';
const json=async(name:string)=>JSON.parse(await readFile(new URL('../content/'+name,import.meta.url),'utf8'));
it('validates the shipped public world through the actual domain and save validators',async()=>{
 const world=worldSchema.parse(await json('worlds/town.json'));
 const save=validateSave(newSave(world));expect(publicView(save).title).toBe(world.meta.title);
 expect(JSON.stringify(publicView(save))).not.toContain('GM_PRIVATE_CANARY');
});
it('validates the shipped blueprint as authoring input, including declared defaults, then compiles a valid save',async()=>{
 const raw=await json('worlds/town-blueprint.json');
 const profile=profileSchema.parse(await json('profiles/default.json'));
 const blueprint=worldInitializationSchema.parse(raw);
 const world=compileWorld(blueprint,profile);
 expect(publicView(validateSave(newSave(world))).title).toBe(raw.title);
});
it('validates the shipped profile and public character-card example through their production readers',async()=>{
 expect(profileSchema.parse(await json('profiles/default.json')).narrator).toBeTruthy();
 const card=normalizeCharacterCard(await json('examples/character-card-v2.json'));
 expect(card.source_spec).toBe('v2');expect(card.name).toBe('Mira Vale');
});
