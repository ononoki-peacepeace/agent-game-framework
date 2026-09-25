import { readFile, writeFile } from 'node:fs/promises';
import { compileWorld } from '../src/ai/authoring.js';
import { readProfile } from '../src/ai/profiles.js';
import { worldInitializationSchema } from '../src/ai/contracts.js';
import { newSave } from '../src/core/state.js';
// Hand-authored examples can be smaller than the AI authoring minimum.
const blueprint = worldInitializationSchema.parse(JSON.parse(await readFile('content/worlds/town-blueprint.json', 'utf8')));
const world = compileWorld(blueprint, await readProfile('content/profiles/default.json'));
world.events.push({ id: 'station_arrival', hook: 'on_location_enter', location_id: 'station', probability: 1, once: true, public_text: '站台广播提醒旅客保管好随身物品。', set_flag: 'heard_station_notice' });
newSave(world);
await writeFile('content/worlds/town.json', JSON.stringify(world, null, 2) + '\n');
