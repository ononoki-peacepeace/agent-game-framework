import type { z } from 'zod';
import { VERSION, type WorldPackage, type profileSchema } from '../core/schema.js';
import { defaultCalendar } from '../routine/schema.js';
import type { worldInitializationSchema } from './contracts.js';

// New worlds start with a trustworthy calendar anchor. Routine data only exists when the world
// actually selects the routine capability.
function defaultRoutineRules(homeLocation: string): WorldPackage['routine_rules'] {
  const source = 'framework default activity catalog';
  return { version: 1, activities: [
    { id:'sleep', label:'夜间睡眠', kind:'sleep', duration:480, location_id:homeLocation, mode:'local', effects:[{op:'condition_delta',key:'stamina',target_id:null,delta:20,reason:'框架默认的整夜睡眠恢复'}], source },
    { id:'meal', label:'用餐', kind:'meal', duration:60, location_id:homeLocation, mode:'local', effects:[], source },
    { id:'study', label:'学习与自习', kind:'study', duration:120, location_id:homeLocation, mode:'local', effects:[], source },
    { id:'work', label:'普通工作', kind:'work', duration:180, location_id:homeLocation, mode:'local', effects:[], source },
    { id:'social', label:'开放社交', kind:'social', duration:120, location_id:homeLocation, mode:'ai', effects:[], source },
  ] };
}

const moduleOrder = ['core','characters','relationships','map','inventory','commerce','attributes','aptitudes','skills','traits','equipment','quests','routine'];
const moduleRequires: Record<string, string[]> = { relationships:['characters'], commerce:['inventory'], equipment:['inventory'], skills:['aptitudes'] };
/** A world only installs the capabilities it selected, plus their hard dependencies. */
export function resolveModules(selected: string[]) {
  const set = new Set(['core', ...selected]);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...set]) for (const dependency of moduleRequires[id] ?? []) if (!set.has(dependency)) { set.add(dependency); changed = true; }
  }
  return moduleOrder.filter(id => set.has(id));
}

function layoutLocations(locations: NonNullable<z.infer<typeof worldInitializationSchema>['locations']>) {

  const byParent = new Map<string, typeof locations>();
  for (const location of locations) {
    const key = location.parent_id ?? '__root__';
    byParent.set(key, [...(byParent.get(key) ?? []), location]);
  }
  const result: Record<string, { x: number; y: number }> = {};
  for (const members of byParent.values()) {
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(members.length))));
    const rows = Math.ceil(members.length / cols);
    members.forEach((location, index) => {
      const col = index % cols, row = Math.floor(index / cols);
      const x = cols === 1 ? 50 : 18 + col * (64 / Math.max(1, cols - 1));
      const y = rows === 1 ? 50 : 22 + row * (56 / Math.max(1, rows - 1));
      result[location.id] = { x: Math.round(x), y: Math.round(y) };
    });
  }
  return result;
}

export function compileWorld(b: z.infer<typeof worldInitializationSchema>, profile: z.infer<typeof profileSchema>): WorldPackage {
  const identity = (name: string, description: string) => ({ name, description, avatar_id: null });
  // A strict provider answers every property; `null` means "this world does not have that data".
  const locations = b.locations ?? [], routes = b.routes ?? [], items = b.items ?? [], shop = b.shop ?? null;
  const positions = layoutLocations(locations);
  const modules = resolveModules(b.modules ?? ['map','characters','relationships','inventory','commerce','routine']);
  const has = (id: string) => modules.includes(id);
  const home = b.player.location_id ?? locations[0]?.id ?? 'start';
  const place = (locationId?: string | null) => has('map') && (locationId ?? locations[0]?.id) ? { location: { location_id: locationId ?? locations[0].id } } : {};
  const shops = has('commerce') && shop ? [shop] : [];


  const playerComponents: Record<string, unknown> = { identity: identity(b.player.name, b.player.description) };
  if (has('characters')) playerComponents.character = { role: 'player', traits: [] };
  if (has('routine')) playerComponents.condition = { hp:100, stamina:100, stress:0 };
  if (has('inventory')) playerComponents.inventory = { items: {} };
  if (has('commerce')) playerComponents.wallet = { balances: { [b.currency.id]: b.player.cash } };
  if (has('relationships')) playerComponents.relationships = { entries: {} };
  if (has('routine')) playerComponents.routine = { active:false, enabled:false, status:'saved', label:'未设置', pattern:'未设置', supplements:[], pattern_revision:0, plan_revision:0, armed_reason:null, activities:[], chunk_minutes:60, elapsed_minutes:0, cycles:0, interrupted:false, last_interrupt:null };
  Object.assign(playerComponents, place(b.player.location_id));

  type Entity = WorldPackage['entities'][number];
  const entity = (id: string, type: string, components: Record<string, unknown>) => ({ id, type, components } as Entity);
  const entities: Entity[] = [entity(b.player.id, 'character', playerComponents)];
  if (has('characters')) for (const character of b.characters) {
    entities.push(entity(character.id, 'character', { identity: identity(character.name, character.description), character: { role: character.role, traits: [] }, ...place(character.location_id) }));
  }
  if (has('inventory')) for (const item of items) {
    entities.push(entity(item.id, 'item', { identity: identity(item.name, item.description), item: { weight: item.weight, stackable: true } }));
  }
  if (shops.length) {
    const store = shops[0];
    entities.push(entity(store.id, 'shop', { identity: identity(store.name, ''), ...place(store.location_id), wallet: { balances: { [b.currency.id]: store.cash } }, shop: { currency_id: b.currency.id, stock: Object.fromEntries(items.map(i => [i.id, 10])), prices: Object.fromEntries(items.map(i => [i.id, { buy: i.price, sell: Math.floor(i.price / 2) }])) } }));
  }

  return {
    schema_version: 1, framework_version: VERSION,
    meta: { id: b.id, title: b.title, description: b.description },
    enabled_modules: modules,
    calendar: defaultCalendar(),
    ...(has('routine') ? { routine_rules: defaultRoutineRules(home) } : {}),
    ruleset: { minutes_per_day: 1440, max_wait_minutes: 1440, talk_minutes: 5, trade_minutes: 2, default_check: '2d6+1',
      currencies: { [b.currency.id]: b.currency.name }, relationship_dimensions: { trust: { min: -100, max: 100, initial: 0 }, familiarity: { min: 0, max: 100, initial: 0 } } },
    prompt_profile: profile, world: { description: b.description },
    entities,
    ...(has('map') ? { map: { locations: locations.map(l => ({ ...l, tags: [], position: positions[l.id] })), routes: routes.map(r => ({ ...r, conditions: [] })) } } : {}),
    events: [], player: { entity_id: b.player.id }, gm_state: { notes: b.hidden_notes, flags: {} }, runtime: { time: { day: 1, minute: 540 } },
  };
}

export {isEmptyWorld} from '../shared/world-intent.js';
export function emptyWorld(profile:z.infer<typeof profileSchema>):WorldPackage { return {schema_version:1,framework_version:VERSION,meta:{id:'empty_world',title:'空白世界',description:'空白世界：只包含框架运行所需的最小结构，没有地点、人物或剧情。'},enabled_modules:['core'],ruleset:{minutes_per_day:1440,max_wait_minutes:1440,talk_minutes:1,trade_minutes:1,default_check:'1d6',currencies:{},relationship_dimensions:{}},prompt_profile:profile,world:{description:''},entities:[{id:'player',type:'character',components:{identity:{name:'玩家',description:'',avatar_id:null}}}],events:[],player:{entity_id:'player'},gm_state:{notes:'',flags:{}},runtime:{time:{day:1,minute:0}}}; }
