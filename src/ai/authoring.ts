import type { z } from 'zod';
import { VERSION, type WorldPackage, type profileSchema } from '../core/schema.js';
import type { Gender } from '../shared/gender.js';
import { AGE_MAX, isAge } from '../shared/age.js';
import { suggestLifeHorizon } from '../narrative/policy.js';
import { defaultCalendar } from '../routine/schema.js';
import type { worldInitializationSchema } from './contracts.js';
import {authoredCharacter} from '../characters/authoring.js';
import {frameworkCapabilityDomains} from '../core/capability.js';
import { defaultRoleplayConfig } from '../narrative/policy.js';
import { hiddenTruthStateSchema } from '../narrative/schema.js';

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
  // Gender travels as canonical character data: a world may specify it, and `null` means "not defined yet".
  const identity = (name: string, description: string, gender: Gender | null = null, age: number | null = null) => ({ name, description, avatar_id: null, gender, age: typeof age === 'number' && Number.isSafeInteger(age) && age >= 0 && age <= AGE_MAX ? age : null });
  // A strict provider answers every property; `null` means "this world does not have that data".
  // Authored worlds start on the first day: an age the world declares is the age on that day, and from there
  // it follows the world's own calendar instead of being frozen.
  const startDay = 1;
  const locations = b.locations ?? [], routes = b.routes ?? [], items = b.items ?? [], shop = b.shop ?? null;
  const positions = layoutLocations(locations);
  const possessions=b.initial_possessions??[],capabilities=b.capability_profiles??[];
  const capabilityLabels={strength:'力量',agility:'敏捷',endurance:'耐力',perception:'感知',cognition:'认知',willpower:'意志'};
  const modules = resolveModules([...(b.modules ?? ['map','characters','relationships','inventory','commerce','routine']),
    ...(possessions.length?['inventory']:[]),
    // Module selection stays need-driven: Core reads a body through the declared domains below
    // and falls back to a neutral baseline, so adjudication never depends on this module being
    // installed. Per-person ability data is what needs it, and that arrives with profiles.
    ...(capabilities.length?['attributes']:[]),...(capabilities.some(p=>p.skills.length)?['skills']:[]),
    ...(possessions.some(entry=>entry.placement==='held'||entry.placement==='worn')?['equipment']:[])]);
  const has = (id: string) => modules.includes(id);
  // One source of truth with the floor Core applies to worlds that predate this: an authored
  // world and a legacy world must read a body the same way.
  const capabilityDomains:NonNullable<WorldPackage['ruleset']['capability_domains']>=frameworkCapabilityDomains();
  for(const profile of capabilities)for(const skill of profile.skills){
    const physical=['strength','agility','endurance'].includes(skill.attribute??'');
    capabilityDomains[skill.id]={attribute:skill.attribute??null,skills:[skill.id],condition_sensitive:physical,exertion_cost:physical?1:0};
  }

  const home = b.player.location_id ?? locations[0]?.id ?? 'start';
  const place = (locationId?: string | null) => has('map') && (locationId ?? locations[0]?.id) ? { location: { location_id: locationId ?? locations[0].id } } : {};
  const shops = has('commerce') && shop ? [shop] : [];
  const possessedItemIds=new Set(possessions.map(entry=>entry.item_id));
  const shopItems=items.filter(item=>!possessedItemIds.has(item.id));


  const playerComponents: Record<string, unknown> = { identity: identity(b.player.name, b.player.description, b.player.gender, b.player.age) };
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
    entities.push(entity(character.id, 'character', { identity: identity(character.name, character.description, character.gender, character.age), character: authoredCharacter(character.role,character.persona),
      ...(possessions.some(entry=>entry.owner_id===character.id)?{inventory:{items:{}}}:{}),...place(character.location_id) }));
  }
  // Authored capability values are stable modifiers, not a scale guessed during play.
  for(const profile of capabilities){
    const actor=entities.find(entity=>entity.id===profile.entity_id);
    if(!actor)throw new Error('能力资料引用了不存在的人物');
    actor.components.attributes={values:{strength:0,agility:0,endurance:0,perception:0,cognition:0,willpower:0,...profile.attributes},labels:{...capabilityLabels},initial_source:profile.basis};
    if(profile.skills.length)actor.components.skills={entries:Object.fromEntries(profile.skills.map(skill=>[skill.id,
      {name:skill.name,level:skill.level,xp:0,next_xp:100,aptitude_ref:null,tags:[],source:profile.basis}]))};
  }
  if(has('attributes'))for(const actor of entities.filter(e=>e.components.character||e.id===b.player.id))
    actor.components.attributes??={values:{strength:0,agility:0,endurance:0,perception:0,cognition:0,willpower:0},labels:{...capabilityLabels},initial_source:'世界默认中性基准；未登记额外训练差异'};
  if (has('inventory')) for (const item of items) {
    entities.push(entity(item.id, 'item', { identity: identity(item.name, item.description), item: { weight: item.weight, stackable: !possessedItemIds.has(item.id),
      ...(item.container?{container:true}:{}) } }));
  }
  for(const possession of possessions){
    const owner=entities.find(entry=>entry.id===possession.owner_id)!;
    const item=entities.find(entry=>entry.id===possession.item_id)!;
    const itemState=item.components.item!;
    itemState.owner_id=owner.id;itemState.tracking='tracked';
    if(possession.placement==='stored'){
      item.components.location={location_id:possession.location_id!};
      continue;
    }
    const inventory=(owner.components.inventory??={items:{}}) as {items:Record<string,number>;placements?:Record<string,string|null>};
    inventory.items[item.id]=1;
    inventory.placements??={};inventory.placements[item.id]=possession.placement==='inside_container'?possession.container_id!:null;
    if(possession.placement==='held'||possession.placement==='worn'){
      const slot=possession.slot??(possession.placement==='held'?'hand':'body');
      const equipment=(owner.components.equipment??={slots:{},labels:{}}) as {slots:Record<string,string|null>;labels:Record<string,string>};
      equipment.slots[slot]=item.id;
      equipment.labels[slot]=possession.placement==='held'?'手持':'穿戴';
      item.components.equipment_item={allowed_slots:[slot],modifiers:{},effect:''};
    }
  }
  if (shops.length) {
    const store = shops[0];
    entities.push(entity(store.id, 'shop', { identity: identity(store.name, ''), ...place(store.location_id), wallet: { balances: { [b.currency.id]: store.cash } }, shop: { currency_id: b.currency.id, stock: Object.fromEntries(shopItems.map(i => [i.id, 10])), prices: Object.fromEntries(shopItems.map(i => [i.id, { buy: i.price, sell: Math.floor(i.price / 2) }])) } }));
  }
  if(has('relationships'))for(const relation of b.initial_relationships??[]){
    const source=entities.find(item=>item.id===relation.from_id);
    if(!source)continue; // worldCandidateIssues rejects unknown IDs before compilation.
    const component=(source.components.relationships??={entries:{}}) as {entries:Record<string,Record<string,number>>};
    (component.entries[relation.to_id]??={})[relation.dimension]=relation.value;
  }

  const structuredTruth=hiddenTruthStateSchema.parse({version:1,commitments:(b.hidden_truths??[]).map(truth=>({
    id:truth.id,commitment:truth.commitment,statement:truth.statement,seed_constraint:truth.seed_constraint,source:'WORLD_CREATION' as const,created_event_ref:null,
    evidence:truth.evidence.map(evidence=>({id:evidence.id,status:'EXISTS' as const,description:evidence.description,event_ref:null,discovered_by:[],
      ...(evidence.location_id||evidence.anchor_entity_id||evidence.scene_scope?{placement:{
        location_id:evidence.location_id??null,anchor_entity_id:evidence.anchor_entity_id??null,scene_scope:evidence.scene_scope??null,
        discoverability:evidence.discoverability??{domain:'investigation',difficulty:'normal' as const},
      }}:{}),
    })),known_by:[],
  }))});
  for (const entity of entities) {
    const identity = entity.components.identity as { age?: unknown } | undefined;
    if (isAge(identity?.age)) (identity as { age_as_of_day?: number | null }).age_as_of_day = startDay;
  }
  return {
    schema_version: 1, framework_version: VERSION,
    meta: { id: b.id, title: b.title, description: b.description },
    // The world's own premise selects the soft lifespan reference, so an immortal or long-lived setting is not
    // measured with a human 70–100 yardstick. It stays a pacing range, never a death date.
    roleplay_config:{...defaultRoleplayConfig(),life_horizon:suggestLifeHorizon({premise:b.description})},
    enabled_modules: modules,
    calendar: b.opening_time?.calendar ?? defaultCalendar(),
    ...(has('routine') ? { routine_rules: defaultRoutineRules(home) } : {}),
    // Declared unconditionally: these domains are how Core reads a body, not authoring flavour.
    ruleset: { capability_domains:capabilityDomains, minutes_per_day: 1440, max_wait_minutes: 1440, talk_minutes: 5, trade_minutes: 2, default_check: '2d6+1',resolution_profile:{version:1,kind:b.resolution_profile??'bell_2d6'},
      currencies: { [b.currency.id]: b.currency.name }, relationship_dimensions: { trust: { min: -100, max: 100, initial: 0 }, familiarity: { min: 0, max: 100, initial: 0 } } },
    prompt_profile: profile, world: { description: b.description },
    entities,
    ...(has('map') ? { map: { locations: locations.map(l => ({ ...l,spatial:l.spatial??undefined, tags: [], position: positions[l.id] })),
      routes: routes.map(r => ({ ...r,gateway:r.gateway??undefined, conditions: [] })),
      ...(b.regions?.length?{regions:b.regions}:{}), } } : {}),
    events: [],
    ...(b.background_incidents?.length?{
      background_event_policy:{enabled:true,target_active_incidents:1,max_dormant_incidents:3,minimum_gap_minutes:1440,replenishment:true},
      background_incidents:b.background_incidents.map(incident=>({...incident,source:'WORLD_CREATION' as const})),
    }:{}),
    ...(b.world_macro_arcs?.length?{world_macro_arcs:b.world_macro_arcs}:{}),
    player: { entity_id: b.player.id }, gm_state: { notes: b.hidden_notes, flags: {}, ...(structuredTruth.commitments.length?{hidden_truth:structuredTruth}:{}) }, runtime: { time: { day: startDay, minute: b.opening_time?.minute ?? 540 } },
  };
}

export {isEmptyWorld} from '../shared/world-intent.js';
export function emptyWorld(profile:z.infer<typeof profileSchema>):WorldPackage { return {schema_version:1,framework_version:VERSION,meta:{id:'empty_world',title:'空白世界',description:'空白世界：只包含框架运行所需的最小结构，没有地点、人物或剧情。'},roleplay_config:defaultRoleplayConfig(),enabled_modules:['core'],ruleset:{minutes_per_day:1440,max_wait_minutes:1440,talk_minutes:1,trade_minutes:1,default_check:'1d6',resolution_profile:{version:1,kind:'classic_d20'},currencies:{},relationship_dimensions:{}},prompt_profile:profile,world:{description:''},entities:[{id:'player',type:'character',components:{identity:{name:'玩家',description:'',avatar_id:null,gender:null,age:null}}}],events:[],player:{entity_id:'player'},gm_state:{notes:'',flags:{},hidden_truth:{version:1,commitments:[]}},runtime:{time:{day:1,minute:0}}}; }
