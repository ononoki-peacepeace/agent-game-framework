import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AIRuntime} from '../src/ai/runtime.js';
import {CodexAdapter} from '../src/ai/codex.js';
import {GameService} from '../src/server/service.js';
import {MemoryStore} from '../tests/helpers.js';
import {newSave} from '../src/core/state.js';
import {sparseWorld} from '../tests/sparse-fixture.js';

// An independent in-memory world. No formal save or its hidden facts enter this request.
const world=sparseWorld();
const here=world.entities.find(entity=>entity.id===world.player.entity_id)?.components.location?.location_id;
const room=world.map?.locations.find(location=>location.id===here);
assert(room);
room.name='临海客房';
room.description='单人客房里有床、书桌和衣柜；窗外能看见灰色海面。';
const store=new MemoryStore();
const save=newSave(world);
await store.write(save);
const ai=new AIRuntime(new CodexAdapter());
const service=new GameService(store,ai,world);
const requestId=randomUUID(),started=performance.now();
const view=await service.turn({request_id:requestId,game_id:save.game_id,
  expected_revision:save.state_revision,action:{type:'WAIT',parameters:{minutes:5}}});
const after=await service.current();
assert.equal(after.state_revision,save.state_revision+1);
assert.equal(after.runtime.time.minute,save.runtime.time.minute+5);
assert.equal(after.runtime.receipts.filter(receipt=>receipt.id===requestId).length,1);
assert.equal(view.last_turn?.narrative,after.last_turn?.narrative);
console.log(JSON.stringify({elapsed_ms:Math.round(performance.now()-started),
  narrator_wait_ms:Math.round(ai.metrics.ai_wait_ms),input_tokens:ai.metrics.input_tokens,
  output_tokens:ai.metrics.output_tokens,revision:after.state_revision,
  narrative:after.last_turn?.narrative,notices:view.notices},null,2));
