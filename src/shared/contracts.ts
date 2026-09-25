export type ComponentData = Record<string, unknown>;
export interface Entity { id: string; type: string; components: Record<string, ComponentData> }
/** Panel metadata is the single source of truth for desktop navigation, mobile navigation and surfaces. */
export interface PanelMeta {
  id: string;
  label: string;
  /** Module (or framework surface) that provides this panel. */
  module?: string;
  order?: number;
  icon?: string;
  /** Which capability has to be present for the panel to exist at all. */
  requires_capability?: string;
  /** Desktop placement hint: sidebar (default) or hidden. */
  desktop?: 'sidebar' | 'hidden';
  /** Mobile placement: primary (bottom bar) or secondary (more drawer). */
  mobile_group?: 'primary' | 'secondary';
  /** How the surface is presented; extensions may declare contextual/modal/full-screen surfaces. */
  presentation_type?: 'panel' | 'contextual_panel' | 'scene_widget' | 'modal' | 'overlay' | 'full_screen_activity';
  /** Extension surfaces carry their extension id so the client can render them generically. */
  extension_id?: string;
}
export interface ModuleStatus {
  id: string; version: string; installed: boolean; enabled: boolean;
  state_schema_version: string; provides: string[]; requires: string[]; dependents: string[];
  panels: string[]; supports_enable_disable: boolean; supports_remove: boolean;
}
export interface ActionInput { type: string; target_id?: string; parameters?: Record<string, unknown> }
export interface ContextActionSuggestion { target_id: string; label: string; intent: string }
export interface Narrative { narrative: string; speaker: string | null; dialogue: string | null; choices: string[]; context_actions?: ContextActionSuggestion[] }
export interface MapPosition { x: number; y: number }
export interface PublicLocation {
  id: string; name: string; description: string; tags: string[]; position?: MapPosition;
  parent_id?: string | null; kind?: string; map_level?: number; known_by_default?: boolean;
}
export interface PublicActionMeta {
  type: string;
  label: string;
  visibility: 'internal' | 'text' | 'contextual' | 'panel';
  target_component?: string;
  requires_text?: boolean;
  text_parameter?: string;
  module?: string;
}
export interface PublicView {
  future_intents?:import("../agent/plan-schema.js").FutureIntent[];
  calendar?:import('../routine/schema.js').Calendar;calendar_issue?:string|null;time_label?:string;
  scheduled_tasks?:{id:string;label:string;at:number;window:import('../routine/schema.js').ScheduleWindow;end_at?:number;duration_label?:string;status:'accepted'|'completed'|'cancelled';resolved:boolean}[];
  routine_activities?:{id:string;label:string;kind:string;duration:number;mode:string}[];
  game_id: string; revision: number; title: string; description: string; player_id: string;
  time: { day: number; minute: number }; minutes_per_day: number;
  entities: Entity[]; locations: PublicLocation[];
  routes: { from: string; to: string; travel_minutes: number }[];
  panels: PanelMeta[]; actions: PublicActionMeta[]; currencies: Record<string, string>;
  /** Installed/enabled module lifecycle, so the UI only shows capabilities that really exist. */
  modules: ModuleStatus[];
  capabilities: string[];
  last_turn: Narrative | null; notices: string[];
}
