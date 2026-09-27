import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AIRuntime } from '../src/ai/runtime.js';
import { createApp } from '../src/server/app.js';
import { GameService } from '../src/server/service.js';
import { JsonStore } from '../src/storage/json-store.js';
import { sparseWorld } from './sparse-fixture.js';
import type { AIRequest } from '../src/ai/contracts.js';
import type { ExtensionSpec } from '../src/extensions/schema.js';

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
};
async function close(server: any) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
}

it('a normal System request installs a visible first-level module that survives reload and is self-aware', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agf-visible-module-'));
  const saveDirectory = join(root, 'save');
  const plan = {
    normalized_requirements: ['提供持久记录状态、更新动作和一级面板入口'],
    complexity: 'LOW', clarification: null,
    milestones: [{ id: 'record_surface', title: '记录状态与一级面板', kind: 'integration', acceptance: ['面板可打开并显示持久状态'] }],
    capability_gaps: [], affected_milestone_ids: [],
  };
  const adapter = {
    name: 'mock',
    async generate(request: AIRequest) {
      if ((request.schema as any).properties.normalized_requirements) return { data: plan };
      const context = JSON.parse(request.prompt.slice(request.prompt.indexOf('{"extension_id"')));
      const spec: ExtensionSpec = {
        extension_id: context.extension_id,
        name: '记录台',
        description: '保存并展示这个功能自己的记录次数。',
        template: 'declarative',
        allow_betting: false,
        max_stake: 0,
        healing_item_id: null,
        fields: [{ key: 'entries', type: 'number', initial: 0 }],
        declarative_actions: [{ id: 'add_entry', label: '新增记录', op: 'increment', field: 'entries', value: 1 }],
        surfaces: [{ id: 'records_panel', kind: 'panel', title: '记录台', visibility: 'always' }],
      };
      return { data: { spec, capability_gaps: [] } };
    },
  };
  const ai = new AIRuntime(adapter);
  const service1 = new GameService(new JsonStore(saveDirectory), ai, sparseWorld());
  await service1.newGame();
  let server1: any;
  let server2: any;
  try {
    server1 = createApp(service1, undefined, undefined, join(root, 'assets')).listen(0, '127.0.0.1');
    await once(server1, 'listening');
    let base = 'http://127.0.0.1:' + (server1.address() as any).port;
    let token = (await (await fetch(base + '/api/session')).json()).token;
    let headers = { 'Content-Type': 'application/json', 'X-Game-Token': token };
    const before = (await service1.view())!;

    const requested = await (await fetch(base + '/api/system', {
      method: 'POST', headers,
      body: JSON.stringify({
        input: '增加一个新的记录类模块，作为一级面板入口。',
        request_id: randomUUID(),
        game_id: before.game_id,
        expected_revision: before.revision,
      }),
    })).json();
    expect(requested).toMatchObject({ category: 'EXTENSION_REQUEST', directive: { kind: 'extension_development' } });
    const taskId = requested.directive.task_id;
    const ready: any = await waitFor(
      async () => await (await fetch(base + '/api/development/tasks/' + taskId)).json(),
      (task: any) => task.status === 'ready_for_preview',
    );
    expect(ready.change_plan.classification.recipe_types).toEqual(expect.arrayContaining(['UI_SURFACE_CHANGE']));
    const installed: any = await (await fetch(base + '/api/development/tasks/' + taskId + '/install', {
      method: 'POST', headers,
      body: JSON.stringify({
        candidate_version: ready.current_version,
        confirmed: true,
        game_id: before.game_id,
        expected_revision: before.revision,
        request_id: randomUUID(),
      }),
    })).json();

    const panelId = 'extension:' + ready.extension_id + ':records_panel';
    expect(installed.panels).toContainEqual(expect.objectContaining({ id: panelId, label: '记录台', extension_id: ready.extension_id }));
    expect(installed.modules).toContainEqual(expect.objectContaining({ id: 'extension:' + ready.extension_id, installed: true, enabled: true, panels: [panelId] }));
    expect(installed.capabilities).toContain('extension.' + ready.extension_id);

    const acted: any = await (await fetch(base + '/api/extensions/' + ready.extension_id + '/action', {
      method: 'POST', headers,
      body: JSON.stringify({
        game_id: installed.game_id,
        expected_revision: installed.revision,
        request_id: randomUUID(),
        action: { type: 'add_entry' },
      }),
    })).json();
    expect(acted.revision).toBeGreaterThan(installed.revision);
    expect((await service1.current()).extensions?.[ready.extension_id].state).toMatchObject({ values: { entries: 1 } });

    await close(server1);
    server1 = null;
    const service2 = new GameService(new JsonStore(saveDirectory), ai, sparseWorld());
    server2 = createApp(service2, undefined, undefined, join(root, 'assets')).listen(0, '127.0.0.1');
    await once(server2, 'listening');
    base = 'http://127.0.0.1:' + (server2.address() as any).port;
    token = (await (await fetch(base + '/api/session')).json()).token;
    headers = { 'Content-Type': 'application/json', 'X-Game-Token': token };

    const reloaded: any = await (await fetch(base + '/api/state')).json();
    expect(reloaded.panels).toContainEqual(expect.objectContaining({ id: panelId, label: '记录台' }));
    expect(reloaded.capabilities).toContain('extension.' + ready.extension_id);
    const extensions: any[] = await (await fetch(base + '/api/extensions')).json();
    expect(extensions[0]).toMatchObject({ name: '记录台', enabled: true, installed: true, state: { values: { entries: 1 } } });

    const answer: any = await (await fetch(base + '/api/system', {
      method: 'POST', headers,
      body: JSON.stringify({ input: '现在有没有记录台这个模块？', request_id: randomUUID(), game_id: reloaded.game_id, expected_revision: reloaded.revision }),
    })).json();
    expect(answer.category).toBe('CAPABILITY_ANSWER');
    expect(answer.message).toContain('记录台');
    expect(answer.message).toMatch(/已安装|已启用/);
  } finally {
    if (server1) await close(server1);
    if (server2) await close(server2);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);