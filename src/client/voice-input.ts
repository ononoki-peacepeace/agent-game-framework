export interface SpeechResult {
  isFinal: boolean;
  0: {transcript: string};
}

export interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}

export interface SpeechUpdate {
  finalText: string;
  interimText: string;
  firstFinal: boolean;
}

/** Clean spacing introduced by speech engines without rewriting punctuation or human input. */
export function normalizeSpeechText(text:string){
  return text.trim().replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,'')
    .replace(/\s+([，。！？、；：,.!?;:])/gu,'')
    .replace(/(?<=[，。！？、；：])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,'')
    .replace(/([（「『])\s+/gu,'$1');
}

function speechJoiner(left:string,right:string){
  if(!left||!right||/\s$/.test(left)||/^\s/.test(right))return '';
  if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(left.at(-1)??'')&&
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？、；：]/u.test(right))return '';
  if(/[，。！？、；：]$/.test(left)&&/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right))return '';
  if(/[（「『]$/.test(left)||/^[，。！？、；：,.!?;:）」。』]/.test(right))return '';
  return ' ';
}

/** Recognition results are cumulative. Only changed indices may become newly committed text. */
export class VoiceTranscriptSession {
  private readonly committed = new Set<number>();
  private readonly interim = new Map<number,string>();
  private stopping = false;
  private ended = false;

  accept(event:SpeechResultEvent):SpeechUpdate {
    if(this.ended)return {finalText:'',interimText:'',firstFinal:false};
    const firstFinal=this.committed.size===0;
    let finalText='';
    const start=Math.max(0,Math.min(event.results.length,Math.trunc(event.resultIndex)));
    for(let index=start;index<event.results.length;index++){
      const result=event.results[index],transcript=normalizeSpeechText(result?.[0]?.transcript??'');
      if(result?.isFinal){
        this.interim.delete(index);
        if(!this.committed.has(index)){
          this.committed.add(index);
          finalText+=speechJoiner(finalText,transcript)+transcript;
        }
      }else if(!this.stopping&&!this.committed.has(index))this.interim.set(index,transcript);
    }
    for(const index of this.interim.keys())if(index>=event.results.length)this.interim.delete(index);
    return {finalText,interimText:this.preview(),firstFinal};
  }

  stop(){this.stopping=true;this.interim.clear();}
  end(){this.ended=true;this.interim.clear();}
  preview(){return [...this.interim.entries()].sort(([a],[b])=>a-b)
    .reduce((joined,[,text])=>joined+speechJoiner(joined,text)+text,'');}
}

export function appendFinalSpeech(current:string,finalText:string,_firstFinal:boolean){
  if(!finalText)return current;
  const speech=normalizeSpeechText(finalText);
  return current+speechJoiner(current,speech)+speech;
}

export function voicePreview(current:string,interim:string){
  if(!interim)return current;
  const speech=normalizeSpeechText(interim);
  return current+speechJoiner(current,speech)+speech;
}
