import {z} from 'zod';
const ref=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/).refine(value=>!['constructor','prototype','__proto__'].includes(value));
export const consumptionMethodSchema=z.enum(['eat','drink','use']);
/** Authored permission only. No inferred nutrition, healing or resource reward. */
export const consumptionRuleSchema=z.strictObject({method:consumptionMethodSchema,minutes:z.number().int().min(1).max(240),
 required_flags:z.array(z.strictObject({flag:ref,equals:z.boolean()})).max(12).optional()});
export const consumptionReceiptSchema=z.strictObject({item_id:ref,name:z.string().min(1).max(120),method:consumptionMethodSchema,
 requested_quantity:z.number().int().min(1).max(1000000),before_quantity:z.number().int().nonnegative(),
 consumed_quantity:z.number().int().nonnegative(),after_quantity:z.number().int().nonnegative(),status:z.enum(['completed','interrupted'])});
export type ConsumptionReceipt=z.infer<typeof consumptionReceiptSchema>;
