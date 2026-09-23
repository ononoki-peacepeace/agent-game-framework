export type ComponentData = Record<string, unknown>;
export interface Entity { id: string; type: string; components: Record<string, ComponentData> }
export interface PanelMeta { id: string; label: string }
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
}
export interface PublicView {
  game_id: string; revision: number; title: string; description: string; player_id: string;
  time: { day: number; minute: number }; minutes_per_day: number;
  entities: Entity[]; locations: PublicLocation[];
  routes: { from: string; to: string; travel_minutes: number }[];
  panels: PanelMeta[]; actions: PublicActionMeta[]; currencies: Record<string, string>;
  last_turn: Narrative | null; notices: string[];
}
