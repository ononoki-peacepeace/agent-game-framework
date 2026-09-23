import type { z } from 'zod';
import { VERSION, type WorldPackage, type profileSchema } from '../core/schema.js';
import type { worldInitializationSchema } from './contracts.js';

function layoutLocations(locations: z.infer<typeof worldInitializationSchema>['locations']) {
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
  const positions = layoutLocations(b.locations);
  return {
    schema_version: 1, framework_version: VERSION,
    meta: { id: b.id, title: b.title, description: b.description },
    enabled_modules: ['core','characters','relationships','inventory','commerce','routine'],
    ruleset: { minutes_per_day: 1440, max_wait_minutes: 1440, talk_minutes: 5, trade_minutes: 2, default_check: '2d6+1',
      currencies: { [b.currency.id]: b.currency.name }, relationship_dimensions: { trust: { min: -100, max: 100, initial: 0 }, familiarity: { min: 0, max: 100, initial: 0 } } },
    prompt_profile: profile, world: { description: b.description },
    entities: [
      { id: b.player.id, type: 'character', components: { identity: identity(b.player.name, b.player.description), location: { location_id: b.player.location_id }, character: { role: 'player', traits: [] }, inventory: { items: {} }, wallet: { balances: { [b.currency.id]: b.player.cash } }, relationships: { entries: {} }, routine: { active:false, label:'未设置', pattern:'未设置', activities:[], chunk_minutes:60, elapsed_minutes:0, cycles:0, interrupted:false, last_interrupt:null } } },
      ...b.characters.map(c => ({ id: c.id, type: 'character', components: { identity: identity(c.name, c.description), character: { role: c.role, traits: [] }, location: { location_id: c.location_id } } })),
      ...b.items.map(i => ({ id: i.id, type: 'item', components: { identity: identity(i.name, i.description), item: { weight: i.weight, stackable: true } } })),
      { id: b.shop.id, type: 'shop', components: { identity: identity(b.shop.name, ''), location: { location_id: b.shop.location_id }, wallet: { balances: { [b.currency.id]: b.shop.cash } }, shop: { currency_id: b.currency.id, stock: Object.fromEntries(b.items.map(i => [i.id, 10])), prices: Object.fromEntries(b.items.map(i => [i.id, { buy: i.price, sell: Math.floor(i.price / 2) }])) } } },
    ],
    map: { locations: b.locations.map(l => ({ ...l, tags: [], position: positions[l.id] })), routes: b.routes.map(r => ({ ...r, conditions: [] })) },
    events: [], player: { entity_id: b.player.id }, gm_state: { notes: b.hidden_notes, flags: {} }, runtime: { time: { day: 1, minute: 540 } },
  };
}
