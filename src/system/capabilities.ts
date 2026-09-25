import type { PublicView } from '../shared/contracts.js';
import type { CapabilityPlan, CapabilityPlanStep } from './goals.js';

export type CapabilityAccess = 'read' | 'write' | 'external';
export type CapabilitySideEffect = 'none' | 'canonical-state' | 'external-artifact' | 'development';
export type RetrySemantics = 'safe' | 'idempotency-key' | 'never';

export interface CapabilityDescriptor {
  id: string;
  description: string;
  accepted_inputs: Record<string, string>;
  output: string;
  access: CapabilityAccess;
  side_effect: CapabilitySideEffect;
  affected_surfaces: string[];
  permissions: string[];
  dependencies: string[];
  provider_requirements: string[];
  version: string;
  retry: RetrySemantics;
  idempotency: string;
  implemented: boolean;
}

export interface CapabilityAvailability extends CapabilityDescriptor {
  available: boolean;
  missing: string[];
}

const definitions: CapabilityDescriptor[] = [
  { id: 'entity.lookup', description: 'Resolve one public world entity from a player-facing reference without guessing between duplicates.', accepted_inputs: { reference: 'string', entity_id: 'string?' }, output: 'entity', access: 'read', side_effect: 'none', affected_surfaces: ['entities'], permissions: ['read public state'], dependencies: [], provider_requirements: ['character.identity'], version: '1.0.0', retry: 'safe', idempotency: 'read-only', implemented: true },
  { id: 'entity.query', description: 'Resolve public entities by an explicit player-facing property without inventing members.', accepted_inputs: { query: 'string' }, output: 'entity[]', access: 'read', side_effect: 'none', affected_surfaces: ['entities'], permissions: ['read public state'], dependencies: [], provider_requirements: ['character.identity'], version: '1.0.0', retry: 'safe', idempotency: 'read-only', implemented: true },
  { id: 'entity.identity.rename', description: 'Change the canonical display name of one resolved entity.', accepted_inputs: { entity: 'entity', name: 'string' }, output: 'canonical entity', access: 'write', side_effect: 'canonical-state', affected_surfaces: ['entities.identity'], permissions: ['write canonical state'], dependencies: ['entity.lookup'], provider_requirements: ['character.identity'], version: '1.0.0', retry: 'idempotency-key', idempotency: 'request receipt and expected revision', implemented: true },
  { id: 'media.image.generate', description: 'Generate an image artifact through the configured image provider.', accepted_inputs: { entity: 'entity', description: 'string', kind: 'string' }, output: 'image artifact', access: 'external', side_effect: 'external-artifact', affected_surfaces: ['media workspace'], permissions: ['external provider call'], dependencies: ['entity.lookup'], provider_requirements: ['media.image_generation'], version: '1.0.0', retry: 'never', idempotency: 'provider-specific artifact request key required', implemented: false },
  { id: 'asset.persist', description: 'Persist an existing media artifact and return a stable asset reference.', accepted_inputs: { artifact: 'image artifact' }, output: 'asset reference', access: 'write', side_effect: 'canonical-state', affected_surfaces: ['assets'], permissions: ['write asset storage'], dependencies: ['media.image.generate'], provider_requirements: [], version: '1.0.0', retry: 'idempotency-key', idempotency: 'content-addressed asset write', implemented: false },
  { id: 'character.avatar.assign', description: 'Assign an existing stable asset reference as an entity avatar.', accepted_inputs: { entity: 'entity', asset: 'asset reference' }, output: 'canonical entity', access: 'write', side_effect: 'canonical-state', affected_surfaces: ['entities.identity.avatar_id'], permissions: ['write canonical state'], dependencies: ['entity.lookup', 'asset.persist'], provider_requirements: ['character.identity', 'character.visuals'], version: '1.0.0', retry: 'idempotency-key', idempotency: 'request receipt and expected revision', implemented: false },
  { id: 'location.resolve', description: 'Resolve a public location reference without inventing a map node.', accepted_inputs: { reference: 'string' }, output: 'location', access: 'read', side_effect: 'none', affected_surfaces: ['map'], permissions: ['read public state'], dependencies: [], provider_requirements: ['map.location'], version: '1.0.0', retry: 'safe', idempotency: 'read-only', implemented: false },
  { id: 'routine.schedule.assign', description: 'Assign a validated recurring activity to resolved entities.', accepted_inputs: { entities: 'entity[]', recurrence: 'string', location: 'location?' }, output: 'canonical schedule', access: 'write', side_effect: 'canonical-state', affected_surfaces: ['routine'], permissions: ['write canonical state'], dependencies: ['entity.query'], provider_requirements: ['routine.simulation'], version: '1.0.0', retry: 'idempotency-key', idempotency: 'request receipt and expected revision', implemented: false },
  { id: 'relationship.create', description: 'Create or update a canonical relationship edge between resolved entities.', accepted_inputs: { source: 'entity', target: 'entity', dimensions: 'object' }, output: 'canonical relationship', access: 'write', side_effect: 'canonical-state', affected_surfaces: ['relationships'], permissions: ['write canonical state'], dependencies: ['entity.lookup'], provider_requirements: ['relationship.graph'], version: '1.0.0', retry: 'idempotency-key', idempotency: 'request receipt and expected revision', implemented: false },
  { id: 'feature.develop', description: 'Create controlled extension development work after explicit user approval.', accepted_inputs: { requirement: 'string' }, output: 'development task', access: 'write', side_effect: 'development', affected_surfaces: ['development workspace'], permissions: ['write extension workspace'], dependencies: [], provider_requirements: [], version: '1.0.0', retry: 'idempotency-key', idempotency: 'development request receipt', implemented: true },
];

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityDescriptor>();
  constructor(descriptors: CapabilityDescriptor[] = definitions) {
    for (const descriptor of descriptors) {
      if (this.entries.has(descriptor.id)) throw new Error(`重复 capability id: ${descriptor.id}`);
      this.entries.set(descriptor.id, Object.freeze({ ...descriptor }));
    }
  }
  get(id: string) { return this.entries.get(id) ?? null; }
  all() { return [...this.entries.values()]; }
  availability(capabilities: string[]): CapabilityAvailability[] {
    const installed = new Set(capabilities);
    return this.all().map(entry => {
      const missing = entry.provider_requirements.filter(requirement => !installed.has(requirement));
      if (!entry.implemented) missing.push(`implementation:${entry.id}`);
      return { ...entry, available: missing.length === 0, missing };
    });
  }
  digest(capabilities: string[]) {
    return this.availability(capabilities).map(({ implemented: _implemented, ...entry }) => entry);
  }
}

export const capabilityRegistry = new CapabilityRegistry();

export type PlanValidation =
  | { ok: true; ordered: CapabilityPlanStep[] }
  | { ok: false; kind: 'CAPABILITY_GAP' | 'INVALID_PLAN'; missing: string[]; detail: string };

/** Validate IDs, availability, declared dependencies and acyclicity before any executor may run. */
export function validateCapabilityPlan(plan: CapabilityPlan, view: Pick<PublicView, 'capabilities'>, registry: CapabilityRegistry = capabilityRegistry, authorization?: { permissions?: string[] }): PlanValidation {
  const availability = new Map(registry.availability(view.capabilities).map(item => [item.id, item]));
  const steps = new Map<string, CapabilityPlanStep>();
  for (const step of plan.steps) {
    if (steps.has(step.step_id)) return { ok: false, kind: 'INVALID_PLAN', missing: [], detail: `duplicate step: ${step.step_id}` };
    steps.set(step.step_id, step);
  }
  const missing = new Set<string>();
  for (const step of plan.steps) {
    const descriptor = availability.get(step.capability_id);
    if (!descriptor || !descriptor.available) missing.add(step.capability_id);
    for (const dependency of step.depends_on) if (!steps.has(dependency)) return { ok: false, kind: 'INVALID_PLAN', missing: [], detail: `unknown dependency step: ${dependency}` };
    if (descriptor) {
      const unknown = Object.keys(step.input).find(key => !(key in descriptor.accepted_inputs));
      if (unknown) return { ok: false, kind: 'INVALID_PLAN', missing: [], detail: `unexpected input ${unknown} for ${descriptor.id}` };
      const bad = Object.entries(step.input).find(([key, value]) => (descriptor.accepted_inputs[key] ?? '').startsWith('string') && value !== null && typeof value !== 'string');
      if (bad) return { ok: false, kind: 'INVALID_PLAN', missing: [], detail: `invalid input ${bad[0]} for ${descriptor.id}` };
      if (authorization?.permissions) {
        const allowed = new Set(authorization.permissions), denied = descriptor.permissions.find(permission => !allowed.has(permission));
        if (denied) return { ok: false, kind: 'INVALID_PLAN', missing: [], detail: `permission denied: ${denied}` };
      }
    }
    if (descriptor) for (const required of descriptor.dependencies) {
      const supplied = plan.steps.some(candidate => candidate.capability_id === required && step.depends_on.includes(candidate.step_id));
      if (!supplied) missing.add(required);
    }
  }
  if (missing.size) return { ok: false, kind: 'CAPABILITY_GAP', missing: [...missing], detail: 'required capabilities are unavailable or not connected' };
  const ordered: CapabilityPlanStep[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of steps.get(id)!.depends_on) if (!visit(dependency)) return false;
    visiting.delete(id); visited.add(id); ordered.push(steps.get(id)!); return true;
  };
  for (const id of steps.keys()) if (!visit(id)) return { ok: false, kind: 'INVALID_PLAN', missing: [], detail: 'capability plan contains a cycle' };
  const firstCanonical = ordered.findIndex(step => availability.get(step.capability_id)?.side_effect === 'canonical-state');
  const externalAfterCanonical = firstCanonical >= 0 && ordered.slice(firstCanonical + 1).some(step => availability.get(step.capability_id)?.side_effect === 'external-artifact');
  if (externalAfterCanonical) return { ok: false, kind: 'INVALID_PLAN', missing: [], detail: 'external artifact work must finish before canonical commit' };
  return { ok: true, ordered };
}
