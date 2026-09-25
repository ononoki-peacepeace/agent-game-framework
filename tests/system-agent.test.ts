import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { panelRegistry, CharacterDetail } from '../src/client/panels.js';
import { handleSystemInput } from '../src/system/agent.js';
import { planMeta } from '../src/system/router.js';
import { sparseSetup } from './sparse-fixture.js';
import { publicView } from '../src/core/state.js';

it('the meta router sends goals to tools instead of to Codex, and keeps in-world input out', () => {
  const capabilities = ['character.identity', 'character.visuals'];
  expect(planMeta('这个按钮太难用了。', capabilities)).toMatchObject({ category: 'PRODUCT_FEEDBACK', tool_id: 'ui.feedback' });
  expect(planMeta('地图按钮点了没有反应。', capabilities)).toMatchObject({ category: 'BUG_REPORT', tool_id: 'diagnostic.logs' });
  expect(planMeta('我不需要地图了。', capabilities)).toMatchObject({ category: 'MODULE_MANAGEMENT', tool_id: 'module.disable', args: { module: 'map' } });
  expect(planMeta('重新启用生活模式。', capabilities)).toMatchObject({ category: 'MODULE_MANAGEMENT', tool_id: 'module.enable', args: { module: 'routine' } });
  expect(planMeta('彻底移除装备系统', capabilities)).toMatchObject({ category: 'MODULE_MANAGEMENT', tool_id: 'module.remove', needs_confirmation: true });
  expect(planMeta('重新裁一下「伊芙琳」的头像。', capabilities)).toMatchObject({ category: 'MEDIA_OPERATION', tool_id: 'avatar.crop' });
  expect(planMeta('给「伊芙琳」生成一个新头像。', capabilities)).toMatchObject({ category: 'MEDIA_GENERATION', tool_id: 'media.generate_image' });
  expect(planMeta('我想增加一种当前没有的新玩法。', capabilities)).toMatchObject({ category: 'EXTENSION_REQUEST', tool_id: 'extension.create' });
  expect(planMeta('我要彻底修改存档机制。', capabilities)).toMatchObject({ category: 'FRAMEWORK_DEVELOPMENT', tool_id: 'framework.development' });
  expect(planMeta('继续生活。', capabilities).category).toBe('IN_WORLD_INPUT');
});

it('system requests never advance the world, and missing image generation is reported honestly', async () => {
  const { service } = await sparseSetup();
  const before = await service.current();
  const feedback = await handleSystemInput(service, { input: '这个界面太挤了。' });
  expect(feedback.category).toBe('PRODUCT_FEEDBACK');
  const inWorld = await handleSystemInput(service, { input: '继续生活。' });
  expect(inWorld.message).toContain('左侧输入');
  expect(inWorld.tool_id).toBeNull();
  const generation = await handleSystemInput(service, { input: '给「林舟」生成一个新头像。' });
  expect(generation.message).toContain('没有可用的图片生成功能');
  const crop = await handleSystemInput(service, { input: '重新裁一下「林舟」的头像。' });
  expect(crop.message).toContain('还没有全身图');
  const after = await service.current();
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.last_turn).toEqual(before.last_turn);
  expect(after.event_state).toEqual(before.event_state);
  expect(after.state_revision).toBe(before.state_revision);
});

it('a module request through the system surface is a canonical management action only', async () => {
  const { service } = await sparseSetup();
  const before = await service.current();
  // Disabling a system is reversible, so it executes directly (no pointless confirmation chain).
  const done = await handleSystemInput(service, { input: '我不需要生活模式了。' });
  expect(done.message).toContain('已停用');
  const after = await service.current();
  expect(after.runtime.time).toEqual(before.runtime.time);
  expect(after.last_turn).toEqual(before.last_turn);
  expect(after.definition.enabled_modules).not.toContain('routine');
  // Removing one is destructive: it must ask first and stay a no-op until confirmed.
  const asked = await handleSystemInput(service, { input: '彻底移除商店系统。' });
  expect(asked.needs_confirmation).toBe(true);
  expect(asked.message).toContain('确认');
  expect((await service.current()).state_revision).toBe(after.state_revision);
  // An unclear target asks instead of guessing.
  const vague = await handleSystemInput(service, { input: '关闭吧。' });
  expect(vague.category).not.toBe('MODULE_MANAGEMENT');

});

it('the character detail offers a visible avatar crop entry when a full-body image exists', async () => {
  const { service } = await sparseSetup();
  const view = publicView(await service.current());
  const entity = view.entities.find(item => item.components.character)!;
  const withFullbody = { ...entity, components: { ...entity.components, visual_assets: { images: { fullbody: 'visual_source' } } } };
  const html = renderToStaticMarkup(createElement(CharacterDetail, { view, entity: withFullbody, busy: false, act: () => {}, uploadAvatar: async () => {}, clearAvatar: async () => {}, uploadVisualAsset: async () => {} }));
  expect(html).toContain('调整头像');
  expect(html).toContain('character-media-actions');
  const withoutFullbody = renderToStaticMarkup(createElement(CharacterDetail, { view, entity, busy: false, act: () => {}, uploadAvatar: async () => {}, clearAvatar: async () => {}, uploadVisualAsset: async () => {} }));
  expect(withoutFullbody).not.toContain('调整头像');
});
