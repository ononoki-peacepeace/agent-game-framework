import { randomUUID } from 'node:crypto';
import { changeClassificationSchema, changeRequestSchema, type ChangeClassification, type ChangeRequest, type ChangeType } from './contracts.js';

const layerRules: { type: Exclude<ChangeType, 'NOVEL_CHANGE_DISCOVERY'>; layer: string; patterns: RegExp[] }[] = [
  { type: 'CORE_EVOLUTION', layer: 'core', patterns: [/(框架|引擎|核心|源码|架构).{0,12}(修改|重构|重写|演进|接口)/i, /(modify|refactor|rewrite).{0,12}(framework|engine|core|source)/i] },
  { type: 'DATA_MODEL_CHANGE', layer: 'persistence', patterns: [/(存档|schema|数据模型|持久化).{0,12}(结构|版本|迁移|字段)/i, /(修改|重写|重构).{0,8}(存档机制|存档结构|数据模型)/i, /(migration|schema version|old save)/i] },
  { type: 'PROVIDER_INTEGRATION', layer: 'provider', patterns: [/(接入|集成|连接|配置).{0,12}(provider|模型服务|外部服务|api|供应商)/i, /(credential|endpoint|rate limit|secret).{0,12}(provider|service|api)/i] },
  { type: 'WORKFLOW_CHANGE', layer: 'workflow', patterns: [/(审批|工作流|流程|状态机|恢复流程|安装流程|取消流程)/i, /(workflow|state machine|approval|resume flow)/i] },
  { type: 'AGENT_PLANNING_CHANGE', layer: 'planner', patterns: [/(agent|智能体|规划器).{0,12}(规划|理解|澄清|决策|发现)/i, /(planner|planning).{0,12}(goal|affordance|clarif|fallback)/i] },
  { type: 'CAPABILITY_EXTENSION', layer: 'capability', patterns: [/(新增|增加|扩展|提供).{0,12}(能力|capability|工具|执行器)/i, /(capability|executor).{0,12}(register|availability|permission|schema)/i] },
  { type: 'QUERY_AWARENESS_EXTENSION', layer: 'query', patterns: [/(查询|感知|读取|查看|知道|列出).{0,14}(状态|事实|数据|信息|结果)/i, /(query|awareness|read.only).{0,12}(state|truth|result)/i] },
  { type: 'UI_SURFACE_CHANGE', layer: 'surface', patterns: [/(页面|面板|功能框|tab|按钮|界面|布局|卡片|hud|显示|展示|交互|键盘|控制器)/i, /(panel|surface|layout|button|display|keyboard|controller)/i] },
  { type: 'RULE_EXTENSION', layer: 'rule', patterns: [/(新增|增加|扩展|添加).{0,8}(规则|条件|触发)|每当|随着|达到.{0,8}(时|就)|变化时|衰减|自动.{0,8}(增长|更新)/i, /(add|extend).{0,8}(rule|trigger)|decay|progression|transition/i] },
  { type: 'STATE_EXTENSION', layer: 'state', patterns: [/(新增|增加|添加|扩展|拥有).{0,12}(属性|数值|资源|字段|维度|component|状态)/i, /(new|add).{0,12}(field|resource|component|dimension|attribute)/i] },
  { type: 'BEHAVIOR_CHANGE', layer: 'behavior', patterns: [/(行为|动作|执行|响应方式|处理方式).{0,12}(修改|改变|调整|规则)/i, /(change|modify).{0,12}(behavior|executor|semantics)/i] },
  { type: 'CONFIGURATION_CHANGE', layer: 'configuration', patterns: [/(配置|设置|参数|上限|倍率|阈值|开关|默认值|模型设置|文风|语气|启用|停用|关闭|打开|不需要.{0,8}(模式|系统))/i, /(config|setting|limit|multiplier|threshold|toggle|default|enable|disable)/i] },
  { type: 'CONTENT_CHANGE', layer: 'content', patterns: [/(新增|添加|修改|删除|移除|创建).{0,12}(人物|角色|地点|物品|任务|商品|世界内容|剧情内容)/i, /(add|edit|remove|create).{0,12}(character|location|item|quest|content)/i] },
];
const extensionTypes = new Set<ChangeType>(['STATE_EXTENSION','RULE_EXTENSION','BEHAVIOR_CHANGE','CAPABILITY_EXTENSION','PROVIDER_INTEGRATION','UI_SURFACE_CHANGE','WORKFLOW_CHANGE','AGENT_PLANNING_CHANGE','QUERY_AWARENESS_EXTENSION']);
const order: ChangeType[] = ['CONTENT_CHANGE','CONFIGURATION_CHANGE','STATE_EXTENSION','RULE_EXTENSION','QUERY_AWARENESS_EXTENSION','UI_SURFACE_CHANGE','BEHAVIOR_CHANGE','CAPABILITY_EXTENSION','PROVIDER_INTEGRATION','WORKFLOW_CHANGE','AGENT_PLANNING_CHANGE','DATA_MODEL_CHANGE','CORE_EVOLUTION'];

export function createChangeRequest(input: string, context: Record<string, unknown> = {}, requestId: string = randomUUID()): ChangeRequest {
  const text = input.trim();
  return changeRequestSchema.parse({ request_id: requestId, original_input: text, goal_summary: text.slice(0, 1000), desired_outcomes: [text.slice(0, 600)], target_layers: [], known_context: context });
}

export function classifyChangeRequest(request: ChangeRequest): ChangeClassification {
  const matches = layerRules.filter(rule => rule.patterns.some(pattern => pattern.test(request.original_input)));
  let types = order.filter(type => matches.some(match => match.type === type));
  // A visible new state normally needs a read contract; an explicit change rule remains separate from state.
  if (types.includes('STATE_EXTENSION') && types.includes('UI_SURFACE_CHANGE') && !types.includes('QUERY_AWARENESS_EXTENSION')) types.push('QUERY_AWARENESS_EXTENSION');
  types = order.filter(type => types.includes(type));
  if (!types.length) return changeClassificationSchema.parse({ primary_type: 'NOVEL_CHANGE_DISCOVERY', recipe_types: ['NOVEL_CHANGE_DISCOVERY'], level: 3, confidence: 0.35, reasons: ['No registered change pattern covers the requested experience with sufficient confidence.'], novel_reason: 'The affected layers and missing primitive require discovery before implementation.' });
  const highest = types.includes('CORE_EVOLUTION') ? 4 : types.some(type => extensionTypes.has(type)) || types.includes('DATA_MODEL_CHANGE') ? 3 : types.length > 1 ? 2 : types[0] === 'CONFIGURATION_CHANGE' ? 1 : 0;
  const primary = types.includes('CORE_EVOLUTION') ? 'CORE_EVOLUTION' : types.includes('DATA_MODEL_CHANGE') ? 'DATA_MODEL_CHANGE' : types[0];
  return changeClassificationSchema.parse({ primary_type: primary, recipe_types: types, level: highest, confidence: matches.length > 1 ? 0.86 : 0.72, reasons: matches.map(match => `Request affects the ${match.layer} layer.`), novel_reason: null });
}

/** Returns null for ordinary play and conversation; only explicit framework/product changes enter recipes. */
export function classifyFrameworkChange(input: string): ChangeClassification | null {
  const text = input.trim();
  const explicitChange = /(新增|增加|添加|加入|加个|加一个|修改|改变|调整|删除|移除|启用|停用|配置|设置|接入|集成|重构|重写|开发|制作|实现|希望|想要|需要|让.{0,20}(显示|支持|拥有))|\b(add|change|modify|remove|configure|integrate|refactor|develop|implement)\b/i.test(text);
  if (!explicitChange) return null;
  const classification = classifyChangeRequest(createChangeRequest(text));
  if (classification.primary_type === 'NOVEL_CHANGE_DISCOVERY' && !/(框架|引擎|系统|玩法|小游戏|功能|机制|流程|能力|交互|控制|provider|agent|界面|面板|扩展|workflow|capability)/i.test(text)) return null;
  return classification;
}

export function changeRouteForText(input: string): 'FRAMEWORK_DEVELOPMENT' | 'EXTENSION_REQUEST' | null {
  const classification = classifyFrameworkChange(input);
  if (!classification) return null;
  if (classification.primary_type === 'CORE_EVOLUTION' || classification.primary_type === 'DATA_MODEL_CHANGE') return 'FRAMEWORK_DEVELOPMENT';
  return classification.primary_type === 'NOVEL_CHANGE_DISCOVERY' || classification.recipe_types.some(type => extensionTypes.has(type)) ? 'EXTENSION_REQUEST' : null;
}
