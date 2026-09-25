import {z} from 'zod';
export const avatarCropSchema=z.strictObject({crop_version:z.literal(1),source_asset_id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),scale:z.number().finite().min(1).max(100),offset_x:z.number().finite().min(-100).max(100),offset_y:z.number().finite().min(-100).max(100)});
export type AvatarCropMetadata=z.infer<typeof avatarCropSchema>;
