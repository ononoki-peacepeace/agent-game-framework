// Run against an isolated copy, never writes the supplied save.
import {readFile} from 'node:fs/promises';
import {dirname,basename} from 'node:path';
import {worldImage,worldKeys} from '../src/core/turn-history.js';
import {validateSave} from '../src/core/state.js';
import {JsonStore} from '../src/storage/json-store.js';
const path=process.argv[2];
if(!path||basename(path)!=='current.json'||dirname(path).replaceAll('\\','/').toLowerCase().endsWith('/game/data'))throw Error('Supply isolated current.json');
const text=await readFile(path,'utf8'),save=validateSave(JSON.parse(text));
function legacyImage(){const copy=structuredClone(save) as any;for(const key of Object.keys(copy))if(!(worldKeys as readonly string[]).includes(key))delete copy[key];delete copy.runtime.receipts;for(const entity of copy.entities){delete entity.components.visual_assets;if(entity.components.identity)delete entity.components.identity.avatar_id;}return copy;}
async function measure(run:()=>unknown|Promise<unknown>){const values:number[]=[];for(let index=0;index<7;index++){const start=performance.now();await run();values.push(performance.now()-start);}values.sort((a,b)=>a-b);return {p50_ms:Math.round(values[3]),p95_ms:Math.round(values[6]),max_ms:Math.round(values[6]),samples:7};}
const store=new JsonStore(dirname(path));await store.read();
console.log(JSON.stringify({utf16_units:text.length,utf8_bytes:Buffer.byteLength(text,'utf8'),revision:save.state_revision,
 snapshot_before:await measure(legacyImage),snapshot_after:await measure(()=>worldImage(save)),
 read_before:await measure(async()=>validateSave(JSON.parse(await readFile(path,'utf8')))),
 read_after:await measure(()=>store.read())},null,2));
