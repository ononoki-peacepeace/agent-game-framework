import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
const directory=process.env.AGF_TEST_PIPELINE_DIR,nonce=process.env.AGF_TEST_PIPELINE_NONCE;
if(!directory||!nonce)throw Error('Pipeline deadline requires owned test identity');
appendFileSync(join(directory,'owned-node-processes.ndjson'),JSON.stringify({nonce,pid:process.pid,ppid:process.ppid,argv:process.argv})+'\n');
// A bounded test tool must end even if the controller is interrupted.
setTimeout(()=>process.exit(91),120000).unref();
