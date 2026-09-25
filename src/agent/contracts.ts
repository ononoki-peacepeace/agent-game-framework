import type { PublicView } from '../shared/contracts.js';

/** Shared Agent result used by both the in-world (left) and Meta (right) surfaces. */
export type UIAction =
  | { kind: 'open_panel'; panel: string }
  | { kind: 'focus_entity'; entity_id: string; panel?: string }
  | { kind: 'scroll_to_entity'; entity_id: string }
  | { kind: 'highlight_entity'; entity_id: string }
  | { kind: 'open_character_detail'; entity_id: string }
  | { kind: 'open_crop_editor'; entity_id: string; source_asset_id: string }
  | { kind: 'export_save' }
  | { kind: 'extension_development'; request: string };

export interface AgentResult {
  presentation?: 'story' | 'assistant';
  plan_id?: string;
  plan?: import("./plan-schema.js").AgentPlan;
  results?: {goal_id:string;summary:string;related_entity:string|null;status:import("./plan-schema.js").GoalStatus}[];
  future_intents?: import("./plan-schema.js").FutureIntent[];
  intent: string;
  message: string;
  ui_actions: UIAction[];
  tool_calls: { tool_id: string; ok: boolean }[];
  canonical_changes: string[];
  time_advanced: number;
  clarification?: string | null;
  view?: PublicView | null;
}

export function agentResult(intent: string, message: string, extra: Partial<AgentResult> = {}): AgentResult {
  return { intent, message, ui_actions: [], tool_calls: [], canonical_changes: [], time_advanced: 0, clarification: null, ...extra };
}
