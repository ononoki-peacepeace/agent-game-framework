import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sparseSetup } from './sparse-fixture.js';
import { ExtensionHost } from '../src/extensions/host.js';
import { ExtensionDevelopment } from '../src/extensions/development.js';
import type { SavePackage } from '../src/core/schema.js';

const request = {
  request_id: randomUUID(), request: '做一个只改自己状态的计数器小工具', template: 'declarative' as const,
  extension_id: 'counter', allow_betting: false, use_codex: false,
};
const tx = async (service: { current: () => Promise<SavePackage> }) => {
  const save = await service.current();
  return { game_id: save.game_id, expected_revision: save.state_revision, request_id: randomUUID() };
};
async function ready(dev: ExtensionDevelopment) {
  for (let i = 0; i < 2000; i++) {
    const job = (await dev.get())!;
    if (!['queued', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('development timeout');
}

it('a declarative dummy extension installs, runs, disables, re-enables, versions and uninstalls without touching the core', async () => {
  const { service } = await sparseSetup();
  const directory = await mkdtemp(join(tmpdir(), 'agf-counter-'));
  try {
    const host = new ExtensionHost(service, directory), dev = new ExtensionDevelopment(host);
    const baseEntities = JSON.stringify((await service.current()).entities);
    // The framework has no built-in counter gameplay: the manifest is produced by the development pipeline.
    await dev.start(request);
    const job = await ready(dev);
    expect(job.status).toBe('ready');
    expect(job.logs).toContain('状态字段与动作自洽');
    expect(job.manifest).toMatchObject({ template: 'declarative', ui_type: 'declarative', state_schema: 'declarative.v1', save_namespace: 'counter' });
    expect(job.manifest!.permissions.write).toEqual(['extension-owned state']);
    expect(job.manifest!.fields.map(field => field.key)).toEqual(['count']);
    expect(job.manifest!.declarative_actions.map(action => action.id)).toEqual(['plus_one','reset']);
    expect(job.manifest!.surfaces[0]).toMatchObject({ kind: 'contextual_panel', visibility: 'always' });
    expect(JSON.stringify((await service.current()).entities)).toBe(baseEntities);

    await expect(dev.install(job.job_id, { ...(await tx(service)), confirmed: false })).rejects.toThrow();
    await dev.install(job.job_id, { ...(await tx(service)), confirmed: true });
    const installed = await host.list();
    const counter = installed.find(item => item.id === 'counter')!;
    expect(counter).toMatchObject({ enabled: true, installed: true, available: true, can_open: true });
    expect(counter.state).toMatchObject({ kind: 'declarative', values: { count: 0 } });

    // The only thing an action may change is the extension's own namespace.
    const before = await service.current();
    await host.act('counter', { ...(await tx(service)), action: { type: 'plus_one' } });
    await host.act('counter', { ...(await tx(service)), action: { type: 'plus_one' } });
    const after = await service.current();
    expect((after.extensions!.counter.state as { values: { count: number } }).values.count).toBe(2);
    expect(after.entities).toEqual(before.entities);
    expect(after.definition).toEqual(before.definition);
    await expect(host.act('counter', { ...(await tx(service)), action: { type: 'invented_action' } })).rejects.toThrow('未声明');

    // Disable hides the surface but keeps the state dormant; re-enable restores it.
    await host.manage('counter', await tx(service), 'disable');
    expect((await host.list())[0]).toMatchObject({ enabled: false, installed: true });
    expect((await host.list())[0].can_open).toBe(false);
    await expect(host.act('counter', { ...(await tx(service)), action: { type: 'plus_one' } })).rejects.toThrow('未启用');
    await host.manage('counter', await tx(service), 'enable');
    expect((await host.list())[0].state).toMatchObject({ values: { count: 2 } });

    // A new version installs over the working one, and rollback keeps the state.
    await dev.start({ ...request, request_id: randomUUID(), request: '计数器小工具改进版' });
    const update = await ready(dev);
    expect(update.status).toBe('ready');
    expect(update.manifest!.version).toBe('0.1.1');
    await dev.install(update.job_id, { ...(await tx(service)), confirmed: true });
    expect((await host.list())[0].version).toBe('0.1.1');
    await host.manage('counter', await tx(service), 'rollback');
    const rolledBack = (await host.list())[0];
    expect(rolledBack.version).toBe('0.1.0');
    expect(rolledBack.state).toMatchObject({ values: { count: 2 } });

    // Export/import keeps module metadata and extension state.
    const exported = await service.export();
    await service.import(JSON.parse(exported));
    expect((await host.list())[0]).toMatchObject({ version: '0.1.0', enabled: true, installed: true });
    expect((await host.list())[0].state).toMatchObject({ values: { count: 2 } });

    // Uninstall keeps the dormant state and does not damage the base world.
    await host.manage('counter', await tx(service), 'uninstall');
    const removed = (await host.list())[0];
    expect(removed).toMatchObject({ installed: false, enabled: false });
    expect(removed.state).toMatchObject({ values: { count: 2 } });
    expect(JSON.stringify((await service.current()).entities)).toBe(baseEntities);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
