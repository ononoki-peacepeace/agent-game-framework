import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SceneStory} from '../src/client/SceneStory.js';
import {visibleStoryBeats,anchoredStoryBeats} from '../src/client/story-beats.js';
import type {Entity,PublicView} from '../src/shared/contracts.js';

const person=(id:string,name:string,avatar_id:string|null=null):Entity=>({
  id,type:'character',components:{identity:{name,avatar_id}},
});
const actors=[person('npc_a','白鳥 実','avatar_a'),person('npc_b','立花 亮介','avatar_b')];
function html(narrative:string,entities:Entity[]=actors){
  const view={entities,description:'',last_turn:{narrative,speaker:null,dialogue:null,choices:[]}} as unknown as PublicView;
  return renderToStaticMarkup(createElement(SceneStory,{view,override:null,onSelectEntity:()=>{}}));
}

describe('mixed story dialogue display',()=>{
  it('anchors attributed speech without discarding longer prose or reassigning repeated lines',()=>{
    const turn={narrative:'完整的环境铺垫。\n\n“好。”\n\n两人交换了视线，周围依旧安静。\n\n“好。”\n\n这一段收束不能消失。',speaker:null,dialogue:null,choices:[],
      scene_beats:[{kind:'narration' as const,text:'缩略铺垫'},{kind:'speech' as const,speaker_id:'npc_a',utterance:'好。'},
        {kind:'speech' as const,speaker_id:'npc_b',utterance:'好。'}]};
    const beats=anchoredStoryBeats(turn,actors);
    expect(beats.map(beat=>beat.kind==='speech'?beat.speaker_id:beat.text)).toEqual([
      '完整的环境铺垫。','npc_a','两人交换了视线，周围依旧安静。','npc_b','这一段收束不能消失。']);
    const legacy=anchoredStoryBeats({...turn,speaker:'npc_a',dialogue:'另一个回答。',scene_beats:[{kind:'narration',text:'缩略铺垫'}]},actors);
    expect(legacy.at(-1)).toEqual({kind:'speech',speaker_id:'npc_a',utterance:'另一个回答。'});
  });
  it('keeps narration and alternating NPC speech in source order with their existing avatars',()=>{
    const prose='大厅里很安静。\n\n白鳥 実：“先看看这里。”\n\n立花 亮介：“我去那边。”\n\n白鳥 実：“等一下。”\n\n他抬头望向门口。';
    const beats=visibleStoryBeats(prose,actors);
    expect(beats.map(beat=>beat.kind==='speech'?beat.speaker_id:'narration'))
      .toEqual(['narration','npc_a','npc_b','npc_a','narration']);
    const markup=html(prose);
    expect(markup.indexOf('大厅里很安静。')).toBeLessThan(markup.indexOf('先看看这里。'));
    expect(markup.indexOf('先看看这里。')).toBeLessThan(markup.indexOf('我去那边。'));
    expect(markup.indexOf('我去那边。')).toBeLessThan(markup.indexOf('等一下。'));
    expect(markup.indexOf('等一下。')).toBeLessThan(markup.indexOf('他抬头望向门口。'));
    expect(markup).toContain('/api/avatar/avatar_a');
    expect(markup).toContain('/api/avatar/avatar_b');
    expect(markup.match(/scene-beat-speech/g)).toHaveLength(3);
  });

  it('leaves actions, inner thoughts, unknown speakers and ambiguous names as narration',()=>{
    const prose='白鳥 実：“这句话”让他停住了。\n\n未知者：“你好。”\n\n立花 亮介心里想：“别说了。”';
    expect(visibleStoryBeats(prose,actors).every(beat=>beat.kind==='narration')).toBe(true);
    const ambiguous=[...actors,person('npc_c','白鳥 実')];
    expect(visibleStoryBeats('白鳥 実：“你好。”',ambiguous)[0].kind).toBe('narration');
  });

  it('uses structured beats without reparsing, and falls back to a letter when no avatar exists',()=>{
    const view={entities:[person('npc_a','白鳥 実')],description:'',last_turn:{narrative:'旧摘要',
      scene_beats:[{kind:'narration',text:'她停了停。'},{kind:'speech',speaker_id:'npc_a',utterance:'我听见了。'}],
      speaker:null,dialogue:null,choices:[]}} as unknown as PublicView;
    const markup=renderToStaticMarkup(createElement(SceneStory,{view,override:null,onSelectEntity:()=>{}}));
    expect(markup).toContain('我听见了。');
    expect(markup).not.toContain('旧摘要');
    expect(markup).toContain('aria-label="无头像"');
    expect(markup).toContain('>白</span>');
  });
});
