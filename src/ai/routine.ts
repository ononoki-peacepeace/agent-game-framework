import { z } from 'zod';
import { id, integer } from '../core/schema.js';
export const routineTime = z.strictObject({day:integer, minute:integer});
export const routineResultSchema = z.strictObject({
  segment: z.strictObject({start:routineTime, end:routineTime, summary:z.string().min(1).max(2000)}),
  activities: z.array(z.strictObject({
    kind:z.enum(['course','training','work','social','rest','expense','gambling','world_event']),
    summary:z.string().min(4).max(600), participants:z.array(id).max(12),
  })).max(12),
  visits:z.array(id).max(16).describe("本段按顺序经过的地点ID；必须沿当前可通行的有向routes，包含中途地点，留在原地为空"),
  patches:z.array(z.strictObject({
    op:z.enum(['wallet_delta','skill_xp','attribute_delta','relationship_delta','condition_delta']),
    key:id.describe("币种ID、技能ID、属性ID或关系维度ID；condition为hp/stamina/stress"), target_id:id.nullable().describe("仅relationship_delta填写对方人物ID，其他操作为null，操作对象始终是玩家"), delta:z.number().int().min(-100).max(100),
    reason:z.string().min(4).max(500),
  })).max(16),
  checks:z.array(z.strictObject({id, expression:z.string().max(30), reason:z.string().min(4).max(500)})).max(4),
  interrupt:z.boolean(), interrupt_reason:z.string().min(1).max(500).nullable(),
  next_arrangement:z.string().max(500).nullable(),
});
export type RoutineResult = z.infer<typeof routineResultSchema>;
export const routinePolicy = [
  '你是 Routine GM。只处理下一段有意义的普通生活，可以数小时或一个普通日，不按小时机械调用。',
  '优先级：明确的已接受日期事件 > 世界已注册 routine rule（其中的 duration 是权威值，绝不因玩家的近似措辞改写） > 已保存固定安排 > 玩家的近似措辞 > 推断默认值。',
  '缺失的时间细节自行按世界规则、班次、daypart 默认窗口与 travel time 推断，不要为可以推断的时间要求玩家确认；只有真正无法推断且会改变玩家意图的冲突才 interrupt。',
  '读取 canonical_state、原始 pattern、现有历史、当前时刻、角色描述和 GM 记录中的日期/待处理事件。不得跳过尚待玩家决定的事。',
  '时间从 canonical time 开始，结束不超过 max_minutes。无法确定日历或安排时立即零时间 interrupt 澄清，不能猜日期。',
  '正常生活可直接生成课程、训练、兼职、普通交往、休息、开销和小事件，不要求每件事已有专用模块。',
  'activities 是真正完成的生活事实，不能只有时间过去或没有触发事件。普通社交/休息可以没有数值收益，但须有具体经历。',
  'patches 仅提出玩家现有钱包、技能经验、属性、condition体力压力HP、与已有人物关系的小幅变动。不能改地图、库存、任务、身份、时间原点或 GM flags。visits仅沿现有可通行路线移动，路程耗时包含在本段内；不能瞬移，移动中发生重要事件时框架会丢弃尚未发生的生活结算。',
  '钱包单段各币种总变化不超过100、技能各项XP总增加不超过20且不能达到升级阈值、属性各项总变化不超过1、关系每人每维总变化不超过2。技能升级需要玩家接管。condition_delta仅当canonical有condition时可用，key限hp/stamina/stress，单段各项总变化不超过20，最终0到100。不得把体力/压力藏在文本里改数值。',
  '结果只到重要事件发生前：危险、邀请、任务、重大关系或玩家需要决定的事件，interrupt=true，reason说明，不能擅自接受/拒绝。事件可在当前时刻发生，此时零时间且不写收益。',
  '若需正式随机（包括赌博），先返回 checks，activities和patches留空。程序掷骰后会携带 random_results 再问你；不得自行掷骰或编造点数。已有 random_results 时不再请求检查，不得改变原 segment 起止或visits。',
  '如果世界没有明确赌博赔率/规则，则中断询问，不编造赢钱。所有收益需依据既有工资/价格/成长事实；规则或资格不明则中断。',
  '历史和GM notes可能含隐藏事实，只在玩家实际经历中合理显露。既有模块的 Narrator 限制不禁止本角色提出上述受控 patches。',
].join('\n');
