import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GameError, assert, safeParse, profileSchema, type SavePackage } from '../core/schema.js';
import { exportSave, importSave, newSave, publicView, validateSave } from '../core/state.js';
import { executeAction, applyPatches } from '../core/runtime.js';
import { routineModule } from '../modules/routine.js';
import type { SaveStorage } from '../storage/json-store.js';
import type { AIRuntime } from '../ai/runtime.js';
import type { WorldPackage } from '../core/schema.js';

export const requestSchema = z.strictObject({ request_id: z.string().uuid(), game_id: z.string().uuid(), expected_revision: z.number().int().min(0), action: z.unknown().optional(), input: z.string().min(1).max(2000).optional() }).refine(x => (x.action !== undefined) !== (x.input !== undefined), '必须提供 action 或 input 中的一项');
export class GameService {
  private busy = false;
  private ensureBaseFeatures(save: SavePackage) {
    let changed = false;
    if (!save.definition.enabled_modules.includes('routine')) {
      save.definition.enabled_modules.push('routine');
      save.module_versions.routine = routineModule.version;
      const defaults = { active:false, label:'未设置', pattern:'未设置', activities:[], chunk_minutes:60, elapsed_minutes:0, cycles:0, interrupted:false, last_interrupt:null };
      const currentPlayer = save.entities.find(e => e.id === save.player_state.entity_id);
      const initialPlayer = save.definition.entities.find(e => e.id === save.player_state.entity_id);
      if (currentPlayer && !currentPlayer.components.routine) currentPlayer.components.routine = structuredClone(defaults);
      if (initialPlayer && !initialPlayer.components.routine) initialPlayer.components.routine = structuredClone(defaults);
      changed = true;
    }
    return { save: validateSave(save), changed };
  }
  constructor(readonly storage: SaveStorage, readonly ai: AIRuntime, readonly demo: WorldPackage) {}
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new GameError('当前有行动或存档操作正在执行，请稍后重试', 409);
    this.busy = true; try { return await fn(); } finally { this.busy = false; }
  }
  async current() {
    const raw = await this.storage.read(); assert(raw, '请先开始新游戏或导入存档');
    const upgraded = this.ensureBaseFeatures(raw);
    if (upgraded.changed) await this.storage.write(upgraded.save);
    return upgraded.save;
  }
  async view() {
    const raw = await this.storage.read();
    if (!raw) return null;
    const upgraded = this.ensureBaseFeatures(raw);
    if (upgraded.changed) await this.storage.write(upgraded.save);
    return publicView(upgraded.save);
  }
  async newGame(description?: string, promptText?: string, promptProfile?: unknown) {
    return this.exclusive(async () => {
      let profile = promptProfile ? safeParse(profileSchema, promptProfile) : structuredClone(this.demo.prompt_profile);
      if (promptText) profile = { ...profile, id: 'imported_prompt', version: 'user-1', engine_policy: promptText };
      const save = description ? await this.ai.initialize(description, profile) : newSave(this.demo);
      if (!save.last_turn) save.last_turn = { narrative: save.definition.meta.description, speaker: null, dialogue: null, choices: [], context_actions: [] };
      await this.storage.write(save); return publicView(save);
    });
  }
  async turn(raw: unknown) {
    return this.exclusive(async () => {
      const req = safeParse(requestSchema, raw), current = await this.current();
      const fingerprint = createHash('sha256').update(JSON.stringify({ action: req.action, input: req.input })).digest('hex');
      if (req.game_id !== current.game_id) throw new GameError('游戏已切换，请刷新后操作', 409);
      const receipt = current.runtime.receipts.find(r => r.id === req.request_id);
      if (receipt) { assert(receipt.fingerprint === fingerprint, '请求 ID 已用于另一行动'); return publicView(current); }
      if (req.expected_revision !== current.state_revision) throw new GameError('状态已更新，请刷新后重试', 409);
      let input = req.action;
      if (req.input) input = await this.ai.interpret(current, req.input);
      const turn = executeAction(current, input, req.request_id, req.input ? 'ai' : 'player');
      let next = turn.save;
      const notices: string[] = [];
      try {
        const result = await this.ai.narrate(next, turn.action, turn.facts);
        next = applyPatches(next, result.patches, turn.action, turn.registry);
        next.last_turn = { narrative: result.narrative, speaker: result.speaker, dialogue: result.dialogue, choices: result.choices, context_actions: result.context_actions };
      } catch {
        // A deterministic action remains valid even if its optional prose generation fails.
        delete next.ai.threads.narrator;
        next.last_turn = { narrative: turn.facts.join('\n') || '行动已完成。', speaker: null, dialogue: null, choices: [], context_actions: [] };
        notices.push('AI 叙事暂不可用或未通过校验；本次程序动作已完成并保存。');
      }
      next.state_revision++;
      next.runtime.receipts = [...next.runtime.receipts, { id: req.request_id, fingerprint, revision: next.state_revision }].slice(-100);
      next = validateSave(next); await this.storage.write(next);
      return { ...publicView(next), notices };
    });
  }
  async checkpoint() { return this.exclusive(async () => { const save = await this.current(); await this.storage.write(save, 'checkpoint'); return publicView(save); }); }
  async load() { return this.exclusive(async () => {
    const raw = await this.storage.read('checkpoint'); assert(raw, '还没有手动保存的检查点');
    const save = this.ensureBaseFeatures(raw).save;
    save.game_id = randomUUID(); save.ai.threads = {}; save.runtime.receipts = [];
    await this.storage.write(save); return publicView(save);
  }); }
  async import(raw: unknown) { return this.exclusive(async () => {
    const isSave = !!raw && typeof raw === 'object' && 'state_revision' in raw;
    let save = isSave ? importSave(raw) : newSave(raw);
    save = this.ensureBaseFeatures(save).save;
    if (!save.last_turn) save.last_turn = { narrative: save.definition.meta.description, speaker: null, dialogue: null, choices: [], context_actions: [] };
    await this.storage.write(save); return publicView(save);
  }); }
  async setAvatar(entityId: string, avatarId: string, gameId: string, expectedRevision: number) {
    return this.exclusive(async () => {
      const save = await this.current();
      if (save.game_id !== gameId) throw new GameError('游戏已切换，请刷新后操作', 409);
      if (save.state_revision !== expectedRevision) throw new GameError('状态已更新，请刷新后重试', 409);
      const entity = save.entities.find(e => e.id === entityId);
      assert(entity?.components.identity, '目标没有可设置头像的身份信息');
      entity.components.identity.avatar_id = avatarId;
      save.state_revision++;
      const next = validateSave(save);
      await this.storage.write(next);
      return publicView(next);
    });
  }
  async export() { return exportSave(await this.current()); }
}
