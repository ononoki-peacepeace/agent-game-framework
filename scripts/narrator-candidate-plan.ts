import {readFile} from 'node:fs/promises';
import {candidatePlan,type NarratorJob} from './lib/narrator-candidate-queue.js';
const file=process.argv[2];if(!file)throw Error('Usage: npx --no-install tsx scripts/narrator-candidate-plan.ts <candidate-queue.json>');
console.log(JSON.stringify({mode:'dry_run',...candidatePlan(JSON.parse(await readFile(file,'utf8')) as NarratorJob[]),
 real_provider_calls:0,requires_explicit_authorization:true},null,2));
