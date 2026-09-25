import {z} from 'zod';
const key=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).refine(x=>!['constructor','prototype','__proto__'].includes(x));
const number=z.number().finite().min(-1_000_000).max(1_000_000);
export const templates=['blackjack','turn_based_combat','declarative'] as const;
export type ExtensionTemplate=typeof templates[number];

// Declarative extensions describe their own state, actions and UI surface — no arbitrary code.
export const declarativeFieldSchema=z.strictObject({key,type:z.enum(['number','flag','text']),initial:z.union([number,z.boolean(),z.string().max(60)])});
export const declarativeActionSchema=z.strictObject({id:key,label:z.string().min(1).max(40),op:z.enum(['increment','decrement','set','toggle']),field:key,value:number.optional()});
export const declarativeSurfaceSchema=z.strictObject({id:key,kind:z.enum(['contextual_panel','panel','modal']),title:z.string().min(1).max(60),visibility:z.enum(['always','scene']).default('always')});
export const specSchema=z.strictObject({
  extension_id:key,name:z.string().min(1).max(80),description:z.string().min(1).max(600),template:z.enum(templates),
  allow_betting:z.boolean().default(false),max_stake:z.number().int().min(0).max(100).default(0),healing_item_id:key.nullable().default(null),
  fields:z.array(declarativeFieldSchema).max(8).default([]),
  declarative_actions:z.array(declarativeActionSchema).max(8).default([]),
  surfaces:z.array(declarativeSurfaceSchema).max(4).default([]),
});
export type ExtensionSpec=z.infer<typeof specSchema>;
export const manifestSchema=specSchema.extend({
 version:z.string().regex(/^\d+\.\d+\.\d+$/),framework_api_version:z.literal('1'),author:z.string().max(80),generated_by:z.string().max(80),entrypoint:z.literal('dist/profile.json'),ui_type:z.enum(templates),
 permissions:z.strictObject({read:z.array(z.enum(['player.public_state','current_location','inventory','current_scene'])),write:z.array(z.enum(['extension-owned state','request currency transaction','request damage/heal','request consume item']))}),
 state_schema:z.enum(['blackjack.v1','combat.v1','declarative.v1']),supported_platforms:z.array(z.enum(['desktop','mobile'])).min(1),triggers:z.array(z.string().max(40)).max(6),actions:z.array(z.string().max(40)).max(10),events:z.array(z.string().max(40)).max(10),save_namespace:key,dependencies:z.array(z.string().max(40)).max(0),
});
export type ExtensionManifest=z.infer<typeof manifestSchema>;
export const extensionSaveSchema=z.strictObject({version:z.string().max(30),framework_api_version:z.literal('1'),manifest:manifestSchema,enabled:z.boolean(),installed:z.boolean(),state:z.json(),previous:manifestSchema.optional(),previous_state:z.json().optional()});
export const extensionEntriesSchema=z.record(key,extensionSaveSchema).refine(entries=>Object.entries(entries).every(([id,value])=>value.manifest.extension_id===id&&value.manifest.save_namespace===id&&value.version===value.manifest.version),'扩展 namespace / version 不匹配');
const templateActions:Record<Exclude<ExtensionTemplate,'declarative'>,string[]>={blackjack:['start','hit','stand'],turn_based_combat:['start','attack','heal','flee']};
export const extensionActionSchema=z.strictObject({type:z.string().max(40),stake:z.number().int().min(0).max(100).optional(),currency:key.optional(),item_id:key.optional()});
export function manifestFrom(spec:ExtensionSpec,version:string,generatedBy:string):ExtensionManifest{
 const combat=spec.template==='turn_based_combat',declarative=spec.template==='declarative';
 const actions=declarative?spec.declarative_actions.map(action=>action.id):templateActions[spec.template as Exclude<ExtensionTemplate,'declarative'>];
 return manifestSchema.parse({
  ...spec,version,framework_api_version:'1',author:'玩家确认的扩展',generated_by:generatedBy,entrypoint:'dist/profile.json',ui_type:spec.template,
  permissions:declarative
   ?{read:['player.public_state'],write:['extension-owned state']}
   :{read:['player.public_state','current_location','inventory'],write:combat?['extension-owned state','request damage/heal','request consume item']:['extension-owned state',...(spec.allow_betting?['request currency transaction']:[])]},
  state_schema:declarative?'declarative.v1':combat?'combat.v1':'blackjack.v1',
  supported_platforms:['desktop','mobile'],
  triggers:declarative?(spec.surfaces.some(surface=>surface.visibility==='scene')?['scene']:[]):[combat?'training':'casino'],
  actions,events:declarative?[]:['round_finished'],save_namespace:spec.extension_id,dependencies:[],
 });
}
