/** Focus only an entity card in the mounted panel. Never fall back to another panel. */
export function focusPanelEntity(root:HTMLElement|null,id:string){
 const card=Array.from(root?.querySelectorAll<HTMLElement>('[data-entity-id]')??[]).find(e=>e.dataset.entityId===id);
 if(!card)return null;card.tabIndex=-1;card.focus({preventScroll:true});card.scrollIntoView({block:'center',behavior:'smooth'});card.classList.add('entity-highlight');return card;
}

