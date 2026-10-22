import fs from 'node:fs';
const [packetPath,outputPath]=process.argv.slice(2);
if(!packetPath||!outputPath)throw Error('Usage: node scripts/narrator-review-template.mjs <capture/review.json> <new-reviewer-file.json>');
const packet=JSON.parse(fs.readFileSync(packetPath,'utf8'));
const template={manifest_sha256:packet.manifest_sha256,reviewer:{id:null,role:null,attestation:null},
 cases:packet.cases.map(c=>({id:c.id,record_hashes:c.records.map(r=>r.sha256),hard_gates:[null,null,null,null],
  ratings:c.dimensions.map(dimension=>({dimension,score:null,evidence:null}))})),
 pairs:packet.pairs.map(p=>({id:p.id,distinguished:null,evidence:null}))};
fs.writeFileSync(outputPath,JSON.stringify(template,null,2)+'\n',{flag:'wx'});
console.log('Blank template written. This is not a review or acceptance result.');
