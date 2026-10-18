import {describe,it,expect} from 'vitest';
import {VoiceTranscriptSession,appendFinalSpeech,voicePreview,normalizeSpeechText,type SpeechResultEvent} from '../src/client/voice-input.js';

const item=(transcript:string,isFinal=false)=>({0:{transcript},isFinal});
const event=(resultIndex:number,...results:ReturnType<typeof item>[]):SpeechResultEvent=>({resultIndex,results});

describe('browser speech result accumulation',()=>{
  it('replaces cumulative interim text instead of appending each update',()=>{
    const voice=new VoiceTranscriptSession();
    expect(voice.accept(event(0,item('敲门'))).interimText).toBe('敲门');
    expect(voice.accept(event(0,item('敲门看看'))).interimText).toBe('敲门看看');
    const latest=voice.accept(event(0,item('敲门看看有没有人')));
    expect(latest.interimText).toBe('敲门看看有没有人');
    expect(latest.finalText).toBe('');
  });

  it('commits a final result once even when a later event repeats the cumulative results',()=>{
    const voice=new VoiceTranscriptSession();
    voice.accept(event(0,item('敲门看看')));
    const first=voice.accept(event(0,item('敲门看看有没有人',true)));
    expect(first.finalText).toBe('敲门看看有没有人');
    expect(first.interimText).toBe('');
    expect(voice.accept(event(0,item('敲门看看有没有人',true))).finalText).toBe('');
  });

  it('uses nonzero resultIndex and ignores an already committed earlier segment',()=>{
    const voice=new VoiceTranscriptSession();
    voice.accept(event(0,item('先敲门',true)));
    const update=voice.accept(event(1,item('先敲门',true),item('再听一听',true)));
    expect(update.finalText).toBe('再听一听');
    expect(update.firstFinal).toBe(false);
    expect(voice.accept(event(1,item('先敲门',true),item('再听一听',true))).finalText).toBe('');
  });

  it('keeps human text intact and shows interim only in the preview after it',()=>{
    const voice=new VoiceTranscriptSession(),manual='先看看走廊';
    const interim=voice.accept(event(0,item('敲门看看')));
    expect(voicePreview(manual,interim.interimText)).toBe('先看看走廊敲门看看');
    expect(manual).toBe('先看看走廊');
    const final=voice.accept(event(0,item('敲门看看有没有人',true)));
    expect(appendFinalSpeech(manual,final.finalText,final.firstFinal)).toBe('先看看走廊敲门看看有没有人');
  });

  it('appends multiple final segments in order and previews only the changing tail',()=>{
    const voice=new VoiceTranscriptSession();let input='';
    let update=voice.accept(event(0,item('先敲门',true),item('看看',false)));
    input=appendFinalSpeech(input,update.finalText,update.firstFinal);
    expect(input).toBe('先敲门');expect(update.interimText).toBe('看看');
    update=voice.accept(event(1,item('先敲门',true),item('看看有没有人',true),item('再等等',false)));
    input=appendFinalSpeech(input,update.finalText,update.firstFinal);
    expect(input).toBe('先敲门看看有没有人');
    expect(voicePreview(input,update.interimText)).toBe('先敲门看看有没有人再等等');
    update=voice.accept(event(2,item('先敲门',true),item('看看有没有人',true),item('再等等',true)));
    input=appendFinalSpeech(input,update.finalText,update.firstFinal);
    expect(input).toBe('先敲门看看有没有人再等等');
  });

  it('clears interim on stop/end and ignores late interim or final after cancellation',()=>{
    const stopping=new VoiceTranscriptSession();
    stopping.accept(event(0,item('敲门')));stopping.stop();
    expect(stopping.preview()).toBe('');
    expect(stopping.accept(event(0,item('敲门看看'))).interimText).toBe('');
    expect(stopping.accept(event(0,item('敲门看看有没有人',true))).finalText).toBe('敲门看看有没有人');
    stopping.end();expect(stopping.preview()).toBe('');
    const cancelled=new VoiceTranscriptSession();cancelled.accept(event(0,item('准备取消')));cancelled.end();
    expect(cancelled.accept(event(0,item('准备取消',true))).finalText).toBe('');
    expect(cancelled.preview()).toBe('');
  });
  it('removes speech-engine CJK spacing while preserving native punctuation and English word gaps',()=>{
    expect(normalizeSpeechText('  我 想 去 看 看， 今天 有 人 吗？  ')).toBe('我想去看看，今天有人吗？');
    expect(normalizeSpeechText('  Open the door, please.  ')).toBe('Open the door, please.');
    expect(appendFinalSpeech('我想问：',' 今 天 有 人 吗？ ',true)).toBe('我想问：今天有人吗？');
    expect(appendFinalSpeech('Please',' open the door.',true)).toBe('Please open the door.');
  });
  it('joins successive finalized CJK segments once without inventing punctuation',()=>{
    const voice=new VoiceTranscriptSession();let text='手动写的：';
    const first=voice.accept(event(0,item(' 敲 门 ',true)));
    text=appendFinalSpeech(text,first.finalText,first.firstFinal);
    const second=voice.accept(event(1,item(' 敲 门 ',true),item(' 看 看 有 没 有 人 ',true)));
    text=appendFinalSpeech(text,second.finalText,second.firstFinal);
    expect(text).toBe('手动写的：敲门看看有没有人');
    expect(voice.accept(event(0,item(' 敲 门 ',true),item(' 看 看 有 没 有 人 ',true))).finalText).toBe('');
  });
});
