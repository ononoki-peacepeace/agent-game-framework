import type { Entity, PublicView } from '../shared/contracts.js';

const nameOf = (entity: Entity) => String(entity.components.identity?.name ?? '');
/** Every name this entity has ever been known by: identity is the id, the display name is mutable data. */
const namesOf = (entity: Entity) => [nameOf(entity), ...((entity.components.identity?.previous_names ?? []) as string[])].filter(Boolean);
const normalizeName = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s·・._-]+/g, '');
/** "我 / 我自己 / 主角" deterministically means the canonical player entity — it is never something to guess. */
// Deliberately narrow: a bare "我" appears in requests about *other* targets ("我想改一个人物头像"), so only an
// explicit self-reference may resolve to the player entity. Identity questions are handled by their own fast path.
const PLAYER_DEIXIS = /(我自己|我本人|我的角色|玩家角色|玩家自己|主角)/;
export const isSelfReference = (value: string) => /^(我|我自己|我本人|我的角色|玩家角色|玩家自己|主角)$/.test(value.trim());

/** Extract only an explicitly named lookup target. It never guesses a referent from nearby prose. */
export function explicitEntityReference(text: string) {
  const patterns = [/(?:有没有|是否有)(?:一个|一位)?(?:叫|名叫)\s*[“"「『]?([^，。；、？！?!”"」』]{1,40})/, /[“"「『]?([^，。；、？！?!”"」』]{1,40})[”"」』]?\s*(?:是谁|是什么人|在不在|存在吗)/, /(?:叫|名叫)\s*[“"「『]?([^，。；、？！?!”"」』]{1,40})[”"」』]?\s*(?:的)?(?:人|人物|角色)/];
  for (const pattern of patterns) { const value=text.match(pattern)?.[1]?.trim(); if (value) return value; }
  return null;
}

/** Exact current name and historical aliases share one normalized canonical index. */
export function resolveNamedEntity(view: PublicView, reference: string) {
  if (isSelfReference(reference)) return view.entities.find(entity => entity.id === view.player_id) ?? null;
  const key=normalizeName(reference);if(!key)return null;
  const matches=view.entities.filter(entity=>namesOf(entity).some(name=>normalizeName(name)===key));
  return matches.length===1?matches[0]:null;
}

/** Entity resolution shared by the in-world agent and the System agent. */
export function resolveEntities(view: PublicView, text: string) {
  const named = view.entities.filter(entity => namesOf(entity).some(name => name.length >= 2 && text.includes(name)));
  if (named.length) return { matches: named, confident: named.length === 1 };
  const explicit=explicitEntityReference(text);if(explicit){const exact=resolveNamedEntity(view,explicit);return {matches:exact?[exact]:[],confident:Boolean(exact)};}
  const loose = view.entities.filter(entity => {
    const head = namesOf(entity).map(name => name.split(/[^一-龥A-Za-z0-9]+/)[0]).find(part => part && part.length >= 2) ?? '';
    return head.length >= 2 && text.includes(head);
  });
  if (loose.length) return { matches: loose, confident: loose.length === 1 };
  if (PLAYER_DEIXIS.test(text)) {
    const player = view.entities.find(entity => entity.id === view.player_id);
    if (player) return { matches: [player], confident: true };
  }
  return { matches: [], confident: false };
}

export function entityLabel(entity: Entity) {
  return nameOf(entity) || entity.id;
}
