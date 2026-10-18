import {z} from 'zod';

/** One bounded authoring contract for initialized, spawned and imported characters. */
export const personaAuthoringSchema=z.strictObject({
  personality:z.string().max(1200).default(''),
  behavior_tendencies:z.array(z.string().min(1).max(180)).max(6).default([]),
  values:z.array(z.string().min(1).max(120)).max(4).default([]),
  motivations:z.array(z.string().min(1).max(160)).max(3).default([]),
  fears:z.array(z.string().min(1).max(120)).max(3).default([]),
  social_style:z.string().max(300).default(''),
  speech_style:z.string().max(600).default(''),
  verbal_habits:z.string().max(300).default(''),
  emotional_patterns:z.array(z.string().min(1).max(180)).max(4).default([]),
  example_dialogues:z.array(z.string().min(1).max(200)).max(4).default([]),
});
export type PersonaAuthoring=z.infer<typeof personaAuthoringSchema>;
export function authoredCharacter(role:string,persona:Partial<PersonaAuthoring>={}):{role:string;traits:string[]}&PersonaAuthoring{
  return {role:role.slice(0,200),traits:[],...personaAuthoringSchema.parse(persona)};
}
