import type {PublicView} from '../shared/contracts.js';

export const visibleLanguagePolicy='玩家可见的新增旁白、普通人物对白及行动反馈默认使用简体中文。人物姓名、国籍和文化背景不改变交流语言。真实文件、暗号、证据的外语原文保留原样；引用不表示人物自动掌握该语言。内部知识边界不得写成人物的系统说明。';

/** Detect a clear kana sentence drift, not Japanese names or an authenticated
 * foreign source. This is a repair signal, never automatic translation. */
export function narrativeLanguageIssues(result:{narrative:string;dialogue?:string|null;scene_beats?:readonly ({kind:'narration';text:string}|{kind:'speech';speaker_id:string;utterance:string})[]},view:PublicView){
  const names=view.entities.flatMap(entity=>String(entity.components.identity?.name??'').split(/[\s·・]+/).filter(name=>name.length>=2));
  const sources=[...view.locations.map(place=>place.description),...(view.known_evidence??[]).map(evidence=>evidence.description)];
  const fields:[string,string][]=[['narrative',result.narrative],['dialogue',result.dialogue??''],
    ...(result.scene_beats??[]).map((beat,index):[string,string]=>[`scene_beats.${index}.${beat.kind==='speech'?'utterance':'text'}`,beat.kind==='speech'?beat.utterance:beat.text])];
  return fields.flatMap(([path,text])=>{
    for(const name of names)text=text.split(name).join('');
    const drift=[...text.matchAll(/[ぁ-んァ-ヶー]{4,}/g)].some(match=>!sources.some(source=>source.includes(match[0])));
    return drift?[{path,code:'visible_language',expected:'简体中文（已知姓名及真实外语原文除外）',message:'普通场景表达发生日语漂移；保留原有事实与说话人，用简体中文重新表达。'}]:[];
  });
}
