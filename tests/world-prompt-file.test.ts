import {describe,it,expect} from 'vitest';
import {appendWorldPrompt,readWorldPromptFile,validatedWorldPrompt} from '../src/client/world-prompt-file.js';

function file(name:string,content:string|Uint8Array){
  const bytes=typeof content==='string'?new TextEncoder().encode(content):content;
  return {name,size:bytes.length,arrayBuffer:async()=>{const copy=new ArrayBuffer(bytes.length);new Uint8Array(copy).set(bytes);return copy;}};
}

describe('world creation prompt files',()=>{
  it.each(['txt','md','markdown'])('reads UTF-8 .%s into the same validated description used by manual input',async extension=>{
    const result=await readWorldPromptFile(file(`story.${extension}`,'\uFEFF  一个有海港的城市  '));
    expect(result).toEqual({kind:'description',name:`story.${extension}`,description:validatedWorldPrompt('一个有海港的城市')});
  });
  it('accepts explicit creation prompt JSON and distinguishes an engine Prompt Profile',async()=>{
    expect(await readWorldPromptFile(file('idea.json',JSON.stringify({type:'world_prompt',description:' 海港世界 '})))).toEqual({kind:'description',name:'idea.json',description:'海港世界'});
    const profile={id:'personal',version:'1',engine_policy:'a',world_initializer:'b',intent_interpreter:'c',narrator:'d',npc_decision:'e',gm_reasoning:'f'};
    expect(await readWorldPromptFile(file('profile.json',JSON.stringify(profile)))).toEqual({kind:'profile',name:'profile.json',profile});
  });
  it('rejects saves, world definitions, malformed JSON and unrelated formats',async()=>{
    await expect(readWorldPromptFile(file('save.json',JSON.stringify({schema_version:1,definition:{}})))).rejects.toThrow(/存档/);
    await expect(readWorldPromptFile(file('world.json',JSON.stringify({world:{description:'x'},entities:[]})))).rejects.toThrow(/存档/);
    await expect(readWorldPromptFile(file('idea.json','{oops'))).rejects.toThrow(/JSON 格式/);
    await expect(readWorldPromptFile(file('story.pdf','hello'))).rejects.toThrow(/仅支持/);
  });
  it('rejects empty, non UTF-8, oversized and overlong files',async()=>{
    await expect(readWorldPromptFile(file('empty.txt',''))).rejects.toThrow(/文件为空/);
    await expect(readWorldPromptFile(file('invalid.md',new Uint8Array([0xff])))).rejects.toThrow(/UTF-8/);
    await expect(readWorldPromptFile(file('large.txt','a'.repeat(512*1024+1)))).rejects.toThrow(/512 KB/);
    await expect(readWorldPromptFile(file('long.txt','a'.repeat(12001)))).rejects.toThrow(/12000/);
  });
  it('keeps manual text in an explicit append operation without silently losing it',()=>{
    expect(appendWorldPrompt('手动设定','文件设定')).toBe('手动设定\n\n文件设定');
    expect(()=>appendWorldPrompt('a'.repeat(12000),'b')).toThrow(/12000/);
  });
});
