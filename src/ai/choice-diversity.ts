export interface ChoiceMeaning {index:number;intent_key:string;consequence_key:string;target_id:string|null}
/** Model-supplied semantic action keys are checked here; text matching only removes exact duplicates. */
export function distinctChoiceIndices(choices:string[],meanings:ChoiceMeaning[],allowed?:ReadonlySet<number>){
  const byIndex=new Map(meanings.map(item=>[item.index,item]));
  const seen=new Set<string>();
  return choices.flatMap((choice,index)=>{
    if(allowed&&!allowed.has(index))return [];
    const meaning=byIndex.get(index);
    const key=meaning?`${meaning.intent_key.trim().toLowerCase()}|${meaning.consequence_key.trim().toLowerCase()}|${meaning.target_id??''}`:
      `text:${choice.trim().replace(/[\s，,。！？!?]+/g,'').toLowerCase()}`;
    if(seen.has(key))return [];seen.add(key);return [index];
  });
}
export function distinctChoices(choices:string[],meanings:ChoiceMeaning[],allowed?:ReadonlySet<number>){
  return distinctChoiceIndices(choices,meanings,allowed).map(index=>choices[index]);
}
