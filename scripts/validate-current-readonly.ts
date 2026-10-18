// Schema compatibility only: never constructs a service or writes a save.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateSave} from '../src/core/state.js';
const bytes=await readFile('data/current.json'),before=createHash('sha256').update(bytes).digest('hex');
const save=validateSave(JSON.parse(bytes.toString('utf8')));
const after=createHash('sha256').update(await readFile('data/current.json')).digest('hex');
console.log(JSON.stringify({valid:true,revision:save.state_revision,time:save.runtime.time,sha256:before,unchanged:before===after}));
