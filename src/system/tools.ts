/**
 * Capability / Tool registry for the System Agent (out-of-game surface).
 * Tools are described declaratively so the router can select by capability instead of by sentence.
 */
export type SideEffectLevel = 'none' | 'configuration' | 'canonical-management' | 'canonical-state' | 'development';
export type ConfirmationPolicy = 'never' | 'ambiguous-only' | 'always';
export interface ToolDescriptor {
  tool_id: string;
  name: string;
  description: string;
  /** Meta intent category this tool serves. */
  category: string;
  input_schema: Record<string, string>;
  output_schema: string;
  required_capabilities: string[];
  permissions: string[];
  side_effect_level: SideEffectLevel;
  confirmation_policy: ConfirmationPolicy;
  supported_platforms: ('desktop' | 'mobile')[];
}

export const tools: ToolDescriptor[] = [
  { tool_id: 'ui.feedback', name: '记录产品反馈', description: '把关于界面与交互的反馈记进本机日志，不修改游戏状态。', category: 'PRODUCT_FEEDBACK',
    input_schema: { text: 'string' }, output_schema: 'acknowledgement', required_capabilities: [], permissions: ['log'], side_effect_level: 'none', confirmation_policy: 'never', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'diagnostic.logs', name: '查看运行日志', description: '读取本机运行日志的摘要，用于排查问题。', category: 'BUG_REPORT',
    input_schema: { event: 'string?' }, output_schema: 'log summary', required_capabilities: [], permissions: ['read logs'], side_effect_level: 'none', confirmation_policy: 'never', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'character.lookup', name: '查找人物', description: '按名字解析人物；同名时会先询问。', category: 'MEDIA_OPERATION',
    input_schema: { name: 'string' }, output_schema: 'entity id', required_capabilities: ['character.identity'], permissions: ['read public state'], side_effect_level: 'none', confirmation_policy: 'never', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'character.media.get', name: '查看人物图片资料', description: '读取人物当前的公开外观描述、全身图与头像裁剪参数。', category: 'MEDIA_OPERATION',
    input_schema: { entity_id: 'string' }, output_schema: 'media summary', required_capabilities: ['character.identity'], permissions: ['read public state'], side_effect_level: 'none', confirmation_policy: 'never', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'avatar.crop', name: '调整头像', description: '用已有的全身图打开头像裁剪器（不生成新图片）。', category: 'MEDIA_OPERATION',
    input_schema: { entity_id: 'string' }, output_schema: 'crop directive', required_capabilities: ['character.identity','character.visuals'], permissions: ['open editor'], side_effect_level: 'none', confirmation_policy: 'never', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'media.set_avatar', name: '设置头像', description: '把裁剪结果或已存在的图片资源设为人物头像。', category: 'MEDIA_OPERATION',
    input_schema: { entity_id: 'string', asset_id: 'string?' }, output_schema: 'updated public state', required_capabilities: ['character.identity','character.visuals'], permissions: ['write presentation data'], side_effect_level: 'canonical-state', confirmation_policy: 'ambiguous-only', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'media.generate_image', name: '生成图片', description: '调用图像生成 Provider 创建新图片。', category: 'MEDIA_GENERATION',
    input_schema: { entity_id: 'string', kind: 'avatar|fullbody', style: 'string?' }, output_schema: 'asset id', required_capabilities: ['media.image_generation'], permissions: ['external provider call'], side_effect_level: 'canonical-state', confirmation_policy: 'always', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'module.enable', name: '启用系统', description: '启用一个已安装的玩法系统（例如地图、商店）。', category: 'MODULE_MANAGEMENT',
    input_schema: { module: 'string', confirmed: 'boolean' }, output_schema: 'updated public state', required_capabilities: [], permissions: ['framework configuration'], side_effect_level: 'canonical-management', confirmation_policy: 'ambiguous-only', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'module.disable', name: '停用系统', description: '停用一个玩法系统，数据休眠保留，可随时恢复。', category: 'MODULE_MANAGEMENT',
    input_schema: { module: 'string', confirmed: 'boolean' }, output_schema: 'updated public state', required_capabilities: [], permissions: ['framework configuration'], side_effect_level: 'canonical-management', confirmation_policy: 'ambiguous-only', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'module.remove', name: '移除系统', description: '移除一个玩法系统及其自有状态；会先写检查点。', category: 'MODULE_MANAGEMENT',
    input_schema: { module: 'string', confirmed: 'boolean' }, output_schema: 'updated public state', required_capabilities: [], permissions: ['framework configuration'], side_effect_level: 'canonical-management', confirmation_policy: 'always', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'save.export', name: '导出存档', description: '导出标准 Save Package。', category: 'SETTING',
    input_schema: {}, output_schema: 'download directive', required_capabilities: [], permissions: ['read save'], side_effect_level: 'none', confirmation_policy: 'never', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'extension.create', name: '准备新玩法', description: '为 Framework 目前没有的玩法准备一个扩展（需要确认后安装）。', category: 'EXTENSION_REQUEST',
    input_schema: { request: 'string' }, output_schema: 'development job', required_capabilities: [], permissions: ['write extension workspace'], side_effect_level: 'development', confirmation_policy: 'always', supported_platforms: ['desktop','mobile'] },
  { tool_id: 'framework.development', name: '修改框架自身', description: '修改 Framework 核心代码或存档机制。', category: 'FRAMEWORK_DEVELOPMENT',
    input_schema: { request: 'string' }, output_schema: 'development plan', required_capabilities: ['framework.development'], permissions: ['modify framework source'], side_effect_level: 'development', confirmation_policy: 'always', supported_platforms: ['desktop','mobile'] },
];

export function toolAvailability(capabilities: string[]) {
  const available = new Set(capabilities);
  return tools.map(tool => ({ ...tool, available: tool.required_capabilities.every(capability => available.has(capability)) }));
}
export function toolById(id: string) { return tools.find(tool => tool.tool_id === id) ?? null; }
