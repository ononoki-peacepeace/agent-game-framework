import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from '../src/storage/json-store.js';
import { exportSave, importSave, migrate } from '../src/core/state.js';
import { GameService } from '../src/server/service.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { MockAIAdapter } from '../src/ai/mock.js';
import { demo, fresh, MemoryStore } from './helpers.js';
const make = () => new GameService(new MemoryStore(), new AIRuntime(new MockAIAdapter()), demo);
it('persists across instances; portable save discards thread cache', async () => {
  const dir = await mkdtemp(join(tmpdir(),'agf-'));
  try { const store = new JsonStore(dir), s = fresh(); s.ai.threads.narrator = 'old-cache'; await store.write(s); expect(await new JsonStore(dir).read()).toEqual(s);
    const imported = importSave(JSON.parse(exportSave(s))); expect(imported.ai.threads).toEqual({}); expect(imported.entities).toEqual(s.entities); expect(imported.game_id).not.toBe(s.game_id);
  } finally { await rm(dir,{ recursive:true, force:true }); }
});
it('rejects invalid versions and missing modules', () => { const s = fresh(); expect(() => importSave({ ...s,schema_version:99 })).toThrow('schema_version'); s.definition.enabled_modules.push('unknown'); expect(() => importSave(s)).toThrow('缺少模块'); expect(() => migrate(1,2,{})).toThrow(); });
it('deduplicates commits and rejects stale revision', async () => {
  const service = make(), state = await service.newGame();
  const req = { request_id:randomUUID(), game_id:state.game_id, expected_revision:0, action:{ type:'WAIT',parameters:{minutes:10} } };
  await service.turn(req); expect((await service.turn(req)).revision).toBe(1); expect((await service.current()).runtime.time.minute).toBe(550);
  await expect(service.turn({ ...req,request_id:randomUUID() })).rejects.toThrow('状态已更新');
  await expect(service.turn({ ...req,action:{type:'WAIT',parameters:{minutes:20}} })).rejects.toThrow('另一行动');
});
it('checkpoint/load resets generation; bad import does not overwrite', async () => {
  const service = make(), start = await service.newGame(); await service.checkpoint();
  await service.turn({ request_id:randomUUID(),game_id:start.game_id,expected_revision:0,action:{type:'WAIT',parameters:{minutes:10}} });
  const restored = await service.load(); expect(restored.time.minute).toBe(540); expect(restored.game_id).not.toBe(start.game_id);
  const before = await service.current(); await expect(service.import({ malformed:true })).rejects.toThrow(); expect(await service.current()).toEqual(before);
});
it('serializes mutations while AI runs and degrades prose safely', async () => {
  let release!: () => void;
  const adapter = { name:'slow',generate:async () => { await new Promise<void>(resolve => { release=resolve; }); throw new Error('offline'); } };
  const service = new GameService(new MemoryStore(),new AIRuntime(adapter),demo), v=await service.newGame();
  const action = service.turn({request_id:randomUUID(),game_id:v.game_id,expected_revision:0,action:{type:'WAIT',parameters:{minutes:10}}});
  await new Promise(resolve => setTimeout(resolve,10)); await expect(service.newGame()).rejects.toThrow('正在执行'); release();
  const out=await action; expect(out.revision).toBe(1); expect(out.notices.length).toBe(1);
});
it('failed disk commit leaves authoritative state unchanged', async () => {
  const store = new MemoryStore(), service = new GameService(store,new AIRuntime(new MockAIAdapter()),demo), v=await service.newGame();
  await service.current(); const before = await store.read();
  store.write = async () => { throw new Error('disk full'); };
  await expect(service.turn({request_id:randomUUID(),game_id:v.game_id,expected_revision:0,action:{type:'WAIT',parameters:{minutes:10}}})).rejects.toThrow('disk full');
  expect(await store.read()).toEqual(before);
});
it('stores extensible local visual asset references without changing avatar compatibility', async () => {
  const service = make(), state = await service.newGame();
  const target = state.entities.find(e => e.id !== state.player_id && e.components.identity)!;
  const next = await service.setVisualAsset(target.id, 'fullbody', 'visual_test_asset', state.game_id, state.revision);
  const updated = next.entities.find(e => e.id === target.id)!;
  const visuals = updated.components.visual_assets as unknown as { images?: Record<string,string> };
  expect(visuals.images?.fullbody).toBe('visual_test_asset');
  expect(updated.components.identity?.avatar_id ?? null).toBe(target.components.identity?.avatar_id ?? null);
});
