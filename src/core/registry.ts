import { z } from 'zod';
import type { Entity, PanelMeta, ComponentData } from '../shared/contracts.js';
import { assert, safeParse, type Action, type SavePackage, type GameEvent } from './schema.js';
import type { RNG } from './dice.js';

export class Registry<T> {
  private entries = new Map<string, T>();
  register(name: string, value: T) { assert(!this.entries.has(name), `重复注册: ${name}`); this.entries.set(name, value); }
  get(name: string): T { const value = this.entries.get(name); assert(value !== undefined, `未注册: ${name}`); return value; }
  has(name: string) { return this.entries.has(name); }
  all() { return [...this.entries.entries()]; }
}
export interface ActionContext {
  save: SavePackage; store: EntityStore; action: Action; rng: RNG;
  emit(event: GameEvent): void; advance(minutes: number): void; facts: string[];
}
export interface ComponentSpec { schema: z.ZodType; project?: (data: ComponentData, entity: Entity, save: SavePackage) => ComponentData | undefined }
export interface ActionSpec {
  parameters: z.ZodType; execute(ctx: ActionContext): void;
  ui?: { label: string; visibility?: 'internal' | 'text' | 'contextual' | 'panel'; target_component?: string; requires_text?: boolean; text_parameter?: string };
}
export interface Patch { op: string; entity_id: string; target_id: string; dimension: string; delta: number }
export interface RuleEffectSpec { op: string; key: string; target_id: string | null; delta: number; reason: string }
export interface ActivityRuleSpec { id: string; label: string; kind: string; duration: number; location_id: string | null; mode: 'local' | 'ai'; effects: RuleEffectSpec[]; source: string }
export interface TaskRuleStepSpec { action: string; target_id: string | null; minimum_minutes: number }
export interface TaskRuleSpec { task_id: string; book: 'quests' | 'opportunities'; location_id: string; start_at: number; end_at: number; steps: TaskRuleStepSpec[] }
export interface EventRuleSpec { id: string; hook: string; location_id: string | null; probability: number; once: boolean; public_text: string; set_flag: string | null; reveal_location_id?: string | null; interrupt_automation?: boolean }
export interface ActivityCatalogSpec { id: string; mode?: 'local' | 'ai' }
export interface ActivityStateSpec { kind: 'local' | 'ai'; duration?: number; name?: string; participants?: string[] }

/**
 * Module manifest: the declarative contract every gameplay module publishes.
 * Capabilities are what other modules/extensions may depend on; state_ownership lists the save
 * paths a module owns, so enable/disable/remove can stay data-safe and predictable.
 */
export interface ModuleManifest {
  api_version: '1';
  provides: string[];
  optional_dependencies?: string[];
  state_ownership: string[];
  state_schema_version: string;
  migration_version: number;
  supports_enable_disable: boolean;
  supports_remove: boolean;
  /** Panels the module contributes to the shared desktop + mobile navigation registry. */
  panels?: PanelMeta[];
  /** What an ENABLE_MODULE action has to initialise for this module to be valid. */
  setup?: (save: SavePackage) => void;
  /** Optional hooks an activity/event needs; a missing hook means the other module is disabled. */
  hooks?: Record<string, (...args: never[]) => void>;
  activity_kinds?: string[];
  activity_catalog?: ActivityCatalogSpec[];
  currencies?: boolean;
  activity_state?: ActivityStateSpec;
  schedule_window?: boolean;
  task_rules?: boolean;
  event_rules?: boolean;
}
export interface Module {
  id: string; version: string; requires?: string[];
  manifest?: Partial<ModuleManifest>;
  components?: Record<string, ComponentSpec>; actions?: Record<string, ActionSpec>;
  handlers?: Partial<Record<GameEvent['type'], (ctx: ActionContext, event: GameEvent) => void>>;
  validate?: (save: SavePackage) => void; panels?: PanelMeta[]; prompt?: string;
  patches?: Record<string, (save: SavePackage, patch: Patch, action: Action) => void>;
}
export class EventBus {
  readonly handlers = new Map<string, ((ctx: ActionContext, event: GameEvent) => void)[]>();
  on(name: GameEvent['type'], handler: (ctx: ActionContext, event: GameEvent) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }
  emit(ctx: ActionContext, event: GameEvent) { for (const handler of this.handlers.get(event.type) ?? []) handler(ctx, event); }
}
export class ModuleRegistry {
  readonly modules = new Registry<Module>();
  readonly components = new Registry<ComponentSpec>();
  readonly actions = new Registry<ActionSpec>();
  readonly schemas = new Registry<z.ZodType>();
  readonly patches = new Registry<NonNullable<Module['patches']>[string]>();
  readonly events = new EventBus();
  readonly capabilities = new Registry<{ module: string }>();
  register(module: Module) {
    assert(!this.modules.has(module.id), `重复模块: ${module.id}`);
    for (const dep of module.requires ?? []) assert(this.modules.has(dep), `模块 ${module.id} 缺少依赖 ${dep}`);
    for (const name of module.manifest?.provides ?? []) this.capabilities.register(name, { module: module.id });
    for (const [name, spec] of Object.entries(module.components ?? {})) { this.components.register(name, spec); this.schemas.register(`component:${name}`, spec.schema); }
    for (const [name, spec] of Object.entries(module.actions ?? {})) { this.actions.register(name, spec); this.schemas.register(`action:${name}`, spec.parameters); }
    for (const [name, handler] of Object.entries(module.handlers ?? {})) this.events.on(name as GameEvent['type'], handler);
    for (const [name, handler] of Object.entries(module.patches ?? {})) this.patches.register(name, handler);
    this.modules.register(module.id, module);
  }
  moduleOfComponent(name: string) { return this.modules.all().find(([, module]) => Object.hasOwn(module.components ?? {}, name))?.[0] ?? null; }
  validate(save: SavePackage) {
    const ids = new Set<string>();
    for (const entity of save.entities) {
      assert(!ids.has(entity.id), `重复实体: ${entity.id}`); ids.add(entity.id);
      for (const [name, value] of Object.entries(entity.components)) {
        if (!this.components.has(name)) continue; // dormant component of a disabled module: data stays untouched
        safeParse(this.components.get(name).schema, value);
      }
    }
    for (const [, module] of this.modules.all()) module.validate?.(save);
  }
}
export class EntityStore {
  constructor(private save: SavePackage, private registry: ModuleRegistry) {}
  entity(id: string) { const e = this.save.entities.find(e => e.id === id); assert(e, `实体不存在: ${id}`); return e; }
  component<T = ComponentData>(id: string, name: string): T { const c = this.entity(id).components[name]; assert(c, `${id} 缺少组件 ${name}`); return c as T; }
  update(id: string, name: string, value: ComponentData) {
    this.entity(id).components[name] = safeParse(this.registry.components.get(name).schema, value) as SavePackage['entities'][number]['components'][string];
  }
}
