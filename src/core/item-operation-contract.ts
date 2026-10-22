import {z} from 'zod';
const ref=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine(value=>!['constructor','prototype','__proto__'].includes(value));
const label=z.string().min(1).max(120);
const common={item_id:ref,name:label,actor_label:label};
/** Event-time facts from validated Core operations, not a claim about current possession. */
export const itemOperationSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.literal('move'),destination:z.enum(['held','container','scene','scene_container']),
  container_id:ref.nullable(),container_name:label.nullable(),from_container_id:ref.nullable(),from_container_name:label.nullable(),from_held:z.boolean()}),
 z.strictObject({...common,kind:z.literal('transfer'),recipient_id:ref,recipient_name:label}),
]);
export type ItemOperation=z.infer<typeof itemOperationSchema>;
