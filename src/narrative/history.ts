import type {SavePackage} from '../core/schema.js';

/** Past utterances remain attributed history; remote prose is not current scenery. */
export function narratorHistory(save:SavePackage,locationId:unknown,moving:boolean){
  return (save.narrative_history??[]).slice(-6).map(entry=>({
    location_id:entry.location_id??null,time:entry.time,historical:true,
    ...((entry.location_id===locationId||entry.location_id==null)&&!moving?
      {narrative:entry.narrative.slice(0,700)}:{}),
    // Legacy history may have dialogue without typed speech_events. Retain its
    // original speaker as history, never synthesize a fresh NPC decision.
    speaker:entry.speaker??null,dialogue:entry.dialogue?.slice(0,600)??null,
    speech_events:entry.speech_events??[],
  }));
}
