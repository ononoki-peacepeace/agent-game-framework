import type {Entity,PublicView} from '../shared/contracts.js';
import {Avatar,nameOf} from './panels.js';
import {visibleStoryBeats,anchoredStoryBeats} from './story-beats.js';

/** One ordered performance is the visible scene; legacy turns retain their existing layout. */
type SceneStoryProps={view:PublicView;override:string|null;onSelectEntity:(entity:Entity)=>void};
export function SceneStory(props:SceneStoryProps){
  return <>{props.view.last_turn?.presentation?.status==='degraded'&&
    <details className="narration-notice"><summary>叙事说明</summary><p>本段依据实际行动结果直接呈现。</p></details>}
    <SceneStoryContent {...props}/></>;
}
function SceneStoryContent({view,override,onSelectEntity}:SceneStoryProps){
  const turn=view.last_turn;
  if(override!==null)return <p className="narrative">{override}</p>;
  const beats=turn?.scene_beats?.length?anchoredStoryBeats(turn,view.entities):visibleStoryBeats(turn?.narrative||view.description,view.entities);
  if(turn?.scene_beats?.length||beats.some(beat=>beat.kind==='speech'))return <div className="scene-performance" aria-label="本轮互动场景">{beats.map((beat,index)=>{
    if(beat.kind==='narration')return <p className="scene-beat-narration" key={index}>{beat.text}</p>;
    const speaker=view.entities.find(entity=>entity.id===beat.speaker_id);
    return <div className="scene-beat-speech" key={index}>
      {speaker?<button type="button" className="scene-speaker" onClick={()=>onSelectEntity(speaker)}><Avatar entity={speaker}/><strong>{nameOf(speaker)}</strong></button>
        :<strong className="scene-speaker">说话者</strong>}
      <p>{beat.utterance}</p>
    </div>;
  })}</div>;
  const speaker=turn?.speaker?view.entities.find(entity=>entity.id===turn.speaker):undefined;
  return <><p className="narrative">{turn?.narrative||view.description}</p>
    {turn?.dialogue&&<div className="dialogue-card"><button type="button" className="dialogue-speaker" disabled={!speaker} onClick={()=>speaker&&onSelectEntity(speaker)}>{speaker?<Avatar entity={speaker}/>:<span className="avatar">？</span>}<span><strong>{nameOf(speaker)}</strong>{!speaker&&<small>说话者未登记</small>}</span></button><p>{turn.dialogue}</p></div>}</>;
}
