import type { PublicView } from '../shared/contracts.js';
import {displayText} from '../shared/display.js';
import {gameOutcome,type FrameworkOutcome} from './outcome.js';
import {currentTrace} from '../observability/trace.js';

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
  outcome: FrameworkOutcome;
  presentation?: 'story' | 'assistant' | 'handoff' | 'failure';
  plan_id?: string;
  plan?: import("./plan-schema.js").AgentPlan;
  results?: {goal_id:string;summary:string;related_entity:string|null;status:import("./plan-schema.js").GoalStatus}[];
  future_intents?: import("./plan-schema.js").FutureIntent[];
  intent: string;
  message: string;
  /** Only prose assembled from validated Narrator turns may replace the latest last_turn. */
  story?: string;
  ui_actions: UIAction[];
  tool_calls: { tool_id: string; ok: boolean }[];
  canonical_changes: string[];
  time_advanced: number;
  clarification?: string | null;
  awareness_status?: 'FOUND' | 'NOT_FOUND' | 'NOT_DEFINED' | 'UNKNOWN' | 'UNAVAILABLE' | 'AMBIGUOUS';
  goal_control?:{kind:'query'|'cancel'|'resume';target:string;goal_id:string|null;
    status:'queried'|'cancelled'|'already_terminal'|'not_found'|'resumed'|'blocked';revision:number;receipt_ids:string[]};
  view?: PublicView | null;
}

export function agentResult(intent: string, message: string, extra: Partial<AgentResult> = {}): AgentResult {
  const view=extra.view;
  const shown=(value:string)=>view?displayText(value,view.entities,view.locations):value;
  // An absent outcome is feedback, not evidence that a world turn completed.
  const outcome=extra.outcome??gameOutcome('feedback','agent_response',view?.revision??null);
  const presentation=outcome.type==='engine_failure'?'failure':
    extra.presentation==='failure'?'assistant':extra.presentation??'assistant';
  currentTrace()?.info('agent.outcome',{metadata:{type:outcome.type,
    kind:outcome.type==='game'?outcome.kind:outcome.code,stage:outcome.stage,
    completed_steps:outcome.type==='game'?outcome.completed_steps:outcome.committed_steps,
    receipt_ids:outcome.receipt_ids,revision:outcome.revision,
    goal_status:outcome.type==='game'?outcome.goal_status:null,
    state_certain:outcome.type==='engine_failure'?outcome.state_certain:true}});
  currentTrace()?.info('agent.presentation',{metadata:{presentation,message_chars:message.length,
    message_matches_last_turn:Boolean(view?.last_turn?.narrative&&shown(message).trim()===view.last_turn.narrative.trim()),
    view_revision:view?.revision??null,receipt_count:outcome.receipt_ids.length}});
  return { intent, ui_actions: [], tool_calls: [], canonical_changes: [], time_advanced: 0, ...extra,
    ...(extra.results?{results:extra.results.map(result=>({...result,summary:shown(result.summary)}))}:{}),
    outcome,presentation,message:shown(message),clarification:extra.clarification??null };
}
