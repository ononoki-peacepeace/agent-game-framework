import {readFile,realpath} from 'node:fs/promises';
import {resolve,dirname,basename,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {reviewPacketSchema,validateNarratorQualityReview} from './lib/narrator-quality-review.js';
const [packetFile,reviewFile]=process.argv.slice(2);
if(!packetFile||!reviewFile)throw Error('Usage: npx --no-install tsx scripts/narrator-quality-review.ts <capture/review.json> <reviewer-file.json>');
const packet=reviewPacketSchema.parse(JSON.parse(await readFile(packetFile,'utf8')));
const root=await realpath(dirname(resolve(packetFile)));
const hash=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
if(await hash(resolve(root,'manifest.json'))!==packet.manifest_sha256)throw Error('Manifest bytes changed');
for(const c of packet.cases)for(const record of c.records){
 if(basename(record.file)!==record.file)throw Error('Record must be a local capture basename');
 const file=await realpath(resolve(root,record.file));
 if(!file.startsWith(root+sep))throw Error('Record escapes capture directory');
 if(await hash(file)!==record.sha256)throw Error('Recorded output bytes changed: '+c.id);
}
const result=validateNarratorQualityReview(packet,JSON.parse(await readFile(reviewFile,'utf8')));
console.log(JSON.stringify(result,null,2));
if(!result.complete||!result.meets_declared_rubric)process.exitCode=1;
