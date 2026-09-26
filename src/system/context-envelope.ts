import type { PublicView } from '../shared/contracts.js';

export type InputSurface = 'WORLD' | 'SYSTEM';
export interface ContextEnvelope {
  input_surface: InputSurface;
  actor: 'PLAYER_CHARACTER' | 'FRAMEWORK_USER' | 'REAL_WORLD_USER';
  fictional_context: boolean;
  real_world_override: boolean;
  player_entity_id: string;
  world_id: string;
  scene: { location_id: string | null; location_name: string | null };
  intent_domain: 'world' | 'system' | 'real_world';
}

const realWorldLanguage = /(暂停|退出|先停|离开).{0,8}(游戏|角色|扮演)|(?:我|用户)(?:本人)?(?:在)?现实(?:里|中)|不是(?:游戏|角色).{0,8}(是我|现实)/;

/** A strong context prior for models and routers. It supplies truth and never weakens provider policy. */
export function contextEnvelope(view: PublicView, input: string, surface: InputSurface): ContextEnvelope {
  const player=view.entities.find(entity=>entity.id===view.player_id),locationId=String(player?.components.location?.location_id??'')||null;
  const location=locationId?view.locations.find(entry=>entry.id===locationId):null,override=realWorldLanguage.test(input);
  const fictional=surface==='WORLD'&&!override;
  return {
    input_surface:surface,actor:override?'REAL_WORLD_USER':fictional?'PLAYER_CHARACTER':'FRAMEWORK_USER',fictional_context:fictional,real_world_override:override,
    player_entity_id:view.player_id,world_id:view.game_id,scene:{location_id:locationId,location_name:location?.name??null},intent_domain:override?'real_world':fictional?'world':'system',
  };
}
