import type { Entity, PublicView } from '../shared/contracts.js';

const nameOf = (entity: Entity) => String(entity.components.identity?.name ?? '');
/** Entity resolution shared by the in-world agent and the System agent. */
export function resolveEntities(view: PublicView, text: string) {
  const named = view.entities.filter(entity => nameOf(entity) && text.includes(nameOf(entity)));
  if (named.length) return { matches: named, confident: named.length === 1 };
  const loose = view.entities.filter(entity => {
    const name = nameOf(entity);
    const head = name.split(/[·\s]/)[0];
    return head.length >= 2 && text.includes(head);
  });
  return { matches: loose, confident: loose.length === 1 };
}
export function entityLabel(entity: Entity) {
  return nameOf(entity) || entity.id;
}
