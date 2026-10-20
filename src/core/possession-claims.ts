/**
 * What a character's own biography explicitly claims they are carrying right now.
 *
 * One source of truth for two callers that used to be unable to agree: the authoring gate, which
 * refuses to compile a world whose stated opening possessions are not structured items, and the
 * load-time reliability check, which reports a world that already shipped with that gap. The live
 * world is the reason both exist — its player biography reads 「随身只有相机、半卷胶片和一件沾了
 * 海雾的外套」 while `inventory` is `{items:{}}`, so the Narrator described using a camera that was
 * never an entity.
 *
 * This reads only explicit present-possession statements. Profession, habit, history and negation
 * are never grounds to claim someone is carrying something, so "自由摄影师，习惯用镜头记东西"
 * yields nothing. It returns the phrases a world stated, never an item it should invent.
 */

// Possession phrasing comes in two tiers. `随身/身上/手里/兜里` already assert a present on-person
// state, so they stand on their own; a bare verb could just as easily be backstory ("他小时候总
// 带着那只怀表"), so it still needs an explicit opening/now marker.
const anchoredPossession=/(?:随身(?:带着|携带|带有|只有|仅有|只剩|有)|身上(?:带着|携带|带有|只有|仅有|只剩|穿着)|手(?:里|中)(?:拿着|握着|提着|抓着)|(?:口袋|兜)里(?:装着|放着|塞着|有))/;
const possessionVerb=/(?:随身带着|随身携带|手持|穿着|披着|拿着|握着|已装在|装在)/;
const openingMarker=/(?:开局|开场|此刻|现在|目前)/;
const markedPossession=new RegExp(`${openingMarker.source}[^。；;\\n]{0,60}${possessionVerb.source}`);
const possessionTail=new RegExp(`(?:${anchoredPossession.source}|${possessionVerb.source})(.+)`);
const negated=/(?:没有|并未|不再|曾经|过去|早已不|已经不)[^。；;\n]{0,20}(?:带着|携带|手持|穿着|装在|只有|仅有)/;

/** The clauses of a description that explicitly state something is carried at this moment. */
export function statedPossessionClauses(description:string):string[]{
  return description.split(/[。；;\n]/).filter(clause=>
    (anchoredPossession.test(clause)||markedPossession.test(clause))&&!negated.test(clause));
}

/**
 * The individual things one such clause names. `、` is unambiguously an enumeration separator;
 * `和/与/以及/还有` are split only when they are not inside a known item's own name, so a world may
 * still own an item literally called 和服. `，` separates predicates, not list items — treating the
 * clause after it as a list item would turn "随身带着相机，他很紧张" into a demand for an item
 * named 「他很紧张」.
 */
export function statedPossessionClaims(clause:string,knownNames:readonly string[]):string[]{
  const enumerate=(text:string)=>text.split('、').flatMap(piece=>
    knownNames.some(name=>name.length>=2&&piece.includes(name)&&/和|与|以及|还有/.test(name))
      ?[piece]:piece.split(/和|与|以及|还有/)).map(piece=>piece.trim()).filter(Boolean);
  return clause.split(/[，,]/).map(segment=>segment.trim()).filter(Boolean).flatMap(segment=>{
    const container=segment.match(/(.+?)(?:已装在|装在)(.+)/);
    if(container)return enumerate(container[1].replace(new RegExp(`^${openingMarker.source}`),''));
    const held=segment.match(possessionTail);
    return held?enumerate(held[1]):[];
  }).filter(claim=>claim.length>=2);
}

/** A stated claim is backed once some known name is the thing named, in either direction. */
export function possessionClaimBacked(claim:string,knownNames:readonly string[]):boolean{
  return knownNames.some(name=>claim.includes(name)||name.includes(claim));
}

export type UnbackedPossession={entity_id:string;name:string;claim:string};

/**
 * Stated possessions that no item in this world could ever satisfy.
 *
 * Deliberately narrower than the authoring gate. Whether a character still *holds* a declared item
 * is not a defect — they may have put it down two hundred turns ago while their biography still
 * reads the same, and reporting that every load would be noise. Whether the item exists as an
 * entity at all is a defect that play cannot create and cannot fix: moving items only moves
 * existing ones, and the one path that materialises a new one (`item_claims`) also creates the
 * entity. So a claim with no matching item anywhere in the save was missing from the moment the
 * world was compiled, which is exactly the live world's camera.
 *
 * Reports; never repairs. Giving a save the item would be inventing world facts from prose, and
 * that is the authoring model's job under the gate above, not a loader's.
 */
export function unbackedPossessionClaims(save:{entities:readonly {id:string;type:string;
  components:{identity?:{name?:string;description?:string|null}|undefined}}[]}):UnbackedPossession[]{
  const itemNames=save.entities.filter(entity=>entity.type==='item')
    .map(entity=>entity.components.identity?.name).filter((name):name is string=>!!name);
  const found:UnbackedPossession[]=[];
  for(const entity of save.entities){
    const identity=entity.components.identity;
    if(entity.type!=='character'||!identity?.description)continue;
    for(const clause of statedPossessionClauses(identity.description))
      for(const claim of statedPossessionClaims(clause,itemNames))
        if(!possessionClaimBacked(claim,itemNames))
          found.push({entity_id:entity.id,name:identity.name??entity.id,claim});
  }
  return found;
}

