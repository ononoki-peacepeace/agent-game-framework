import type {Entity,Narrative} from '../shared/contracts.js';

type Beat=NonNullable<Narrative['scene_beats']>[number];

/** Structured speech supplies attribution and order; the complete prose remains
 * the source of narration. Do not replace a long paragraph with the model's
 * shorter parallel narration beat. No quotation-based speaker guessing. */
export function anchoredStoryBeats(turn:Narrative,entities:readonly Entity[]):Beat[]{
  const speech=turn.scene_beats?.filter(beat=>beat.kind==='speech')??[];
  if(!speech.length&&turn.speaker&&turn.dialogue)speech.push({kind:'speech',speaker_id:turn.speaker,utterance:turn.dialogue});
  if(!speech.length)return visibleStoryBeats(turn.narrative,entities);
  const body=turn.narrative+(turn.dialogue&&!turn.narrative.includes(turn.dialogue)?'\n\n'+turn.dialogue:'');
  const result:Beat[]=[];let cursor=0;
  const narrate=(text:string)=>{for(const paragraph of text.split(/\r?\n\s*\r?\n/))if(paragraph.trim())result.push({kind:'narration',text:paragraph.trim()});};
  for(const beat of speech){
    const start=body.indexOf(beat.utterance,cursor);
    // Old saves may not have a complete prose/beat pair. Keep their existing
    // structured performance; new generation validates anchors before commit.
    if(start<0)return turn.scene_beats!;
    let before=body.slice(cursor,start),end=start+beat.utterance.length;
    const pairs:Record<string,string>={'“':'”','「':'」','『':'』','"':'"'};
    const open=before.at(-1)??'';
    if(pairs[open]===body[end]){before=before.slice(0,-1);end++;}
    const name=String(entities.find(entity=>entity.id===beat.speaker_id)?.components.identity?.name??'');
    for(const suffix of [name+'：',name+':'])if(name&&before.endsWith(suffix))before=before.slice(0,-suffix.length);
    narrate(before);result.push(beat);cursor=end;
  }
  narrate(body.slice(cursor));return result;
}

/** Conservative adapter for older narrator prose. Only a whole quoted paragraph
 * attributed to one uniquely named, publicly projected character is dialogue. */
export function visibleStoryBeats(narrative:string,entities:readonly Entity[]):Beat[]{
  const byName=new Map<string,Entity|null>();
  for(const entity of entities){
    if(entity.type!=='character')continue;
    const name=String(entity.components.identity?.name??'').trim();
    if(!name)continue;
    byName.set(name,byName.has(name)?null:entity);
  }
  const names=[...byName.keys()].sort((a,b)=>b.length-a.length);
  return narrative.split(/\r?\n\s*\r?\n/).filter(Boolean).map(paragraph=>{
    for(const name of names){
      const speaker=byName.get(name);
      if(!speaker)continue;
      for(const [open,close] of [['：“','”'],['："','"']]){
        const prefix=name+open;
        if(paragraph.startsWith(prefix)&&paragraph.endsWith(close)){
          const utterance=paragraph.slice(prefix.length,-close.length);
          if(utterance.trim()&&!utterance.includes('\n'))
            return {kind:'speech',speaker_id:speaker.id,utterance};
        }
      }
    }
    return {kind:'narration',text:paragraph};
  });
}
