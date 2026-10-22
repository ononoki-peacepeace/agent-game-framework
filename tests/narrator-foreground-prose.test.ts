import {expect,it} from 'vitest';
import {foregroundNarrative} from '../src/narrative/foreground.js';
it('renders a canonical clock label without claiming attendance or changing the source',()=>{
 const source={blocker:'task' as const,reason:'已到安排时间：车站会面'},before=structuredClone(source);
 expect(foregroundNarrative(source)).toBe('「车站会面」的时间到了。');expect(source).toEqual(before);
 expect(foregroundNarrative({blocker:'interrupt',reason:'需要你回应的邀请到了。'})).toBe('需要你回应的邀请到了。');
 expect(foregroundNarrative(undefined)).toBeUndefined();
});
