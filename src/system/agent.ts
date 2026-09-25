import {sessionInput,type SystemSession} from './session.js';
import { z } from 'zod';
import { safeParse } from '../core/schema.js';
import { publicView } from '../core/state.js';
import type { GameService } from '../server/service.js';
import { planMeta, type MetaPlan } from './router.js';
import { toolAvailability, type ToolDescriptor } from './tools.js';

const moduleNames: Record<string, string> = { map: '地图', commerce: '商店', inventory: '背包', equipment: '装备', quests: '任务', routine: '生活模式', attributes: '属性', aptitudes: '资质', skills: '技能', traits: '特质', relationships: '关系系统', characters: '人物系统' };
const moduleLabel = (id: string | null) => (id ? moduleNames[id] ?? id : '');

export interface SystemResult {
  session?:SystemSession;
  category: string; tool_id: string | null; side_effect_level: string; needs_confirmation: boolean;
  message: string; advanced?: Record<string, unknown>; directive?: { kind: string } & Record<string, unknown>;
}
const result = (plan: MetaPlan, message: string, toolsList: ToolDescriptor[], extra: Partial<SystemResult> = {}): SystemResult => {
  const tool = toolsList.find(entry => entry.tool_id === plan.tool_id);
  return { category: plan.category, tool_id: plan.tool_id, side_effect_level: tool?.side_effect_level ?? 'none', needs_confirmation: plan.needs_confirmation, message, ...extra };
};



/** The System Agent: goal -> intent -> tool -> validation -> (canonical management) -> result. */
export async function handleSystemInput(service:GameService,raw:unknown):Promise<SystemResult>{
 const body=safeParse(z.strictObject({input:z.string().min(1).max(2000),confirmed:z.boolean().default(false),session_id:z.string().uuid().optional()}),raw);
 return sessionInput(service,body,(input,confirmed,entity_id)=>executeSystemInput(service,{input,confirmed},entity_id));
}
async function executeSystemInput(service: GameService, raw: unknown,entityId?:string): Promise<SystemResult> {
  const body = safeParse(z.strictObject({ input: z.string().min(1).max(2000), confirmed: z.boolean().default(false) }), raw);
  const save = await service.current(), view = publicView(save), toolsList = toolAvailability(view.capabilities);
  const plan = planMeta(body.input, view.capabilities);
  if (plan.reply&&!(plan.tool_id==="module.remove"&&body.confirmed)) return result(plan, plan.reply, toolsList);
  const tool = toolsList.find(entry => entry.tool_id === plan.tool_id)!;
  service.logger.info('system.agent.request', { module: 'system', metadata: { category: plan.category, tool: tool.tool_id, side_effect: tool.side_effect_level, confirmed: body.confirmed } });

  switch (tool.tool_id) {
    case 'ui.feedback':
      service.logger.warn('system.feedback', { module: 'system', metadata: { text: String(plan.args.request).slice(0, 400) } });
      return result(plan, '已记录这条反馈，会写入本机日志。它不会修改游戏世界。', toolsList);
    case 'diagnostic.logs': {
      const entries = service.logger.entries({ limit: 200 });
      const counts = new Map<string, number>();
      for (const entry of entries) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1);
      const warnings = entries.filter(entry => entry.level === 'warn' || entry.level === 'error').slice(-3).map(entry => entry.event);
      return result(plan, `本机日志最近 ${entries.length} 条：${[...counts].slice(0, 6).map(([event, count]) => `${event}×${count}`).join('、') || '（无）'}。${warnings.length ? `最近的警告/错误：${warnings.join('、')}。` : ''}完整内容见「日志」面板。`, toolsList);
    }
    case 'avatar.crop':
    case 'media.set_avatar':
    case 'character.media.get':
    case 'media.generate_image': {
      const byName = view.entities.filter(entity => entityId?entity.id===entityId:entity.components.identity?.name && body.input.includes(String(entity.components.identity.name)));
      if (byName.length > 1) return result(plan, `有多个人物匹配这个名字：${byName.map(entity => String(entity.components.identity!.name)).join('、')}。请指定是谁。`, toolsList);
      const target = byName[0] ?? save.entities.find(entity => entity.id === save.player_state.entity_id)!;
      const visuals = (target.components.visual_assets ?? {}) as { images?: Record<string, string>; avatar_crop?: unknown };
      const fullbody = visuals.images?.fullbody ?? null, avatar = target.components.identity?.avatar_id ?? null;
      if (plan.category === 'MEDIA_GENERATION') {
        return result(plan, `当前未配置图像生成服务。我不会假装已经生成图片；可以改用已有的全身图裁剪头像，或在框架开发侧接入图像 Provider。`, toolsList, { advanced: { entity_id: target.id, has_fullbody: Boolean(fullbody) } });
      }
      if (!fullbody) return result(plan, `${String(target.components.identity?.name ?? '这个人物')} 还没有全身图，无法裁剪头像。请先上传全身图，或接入图像生成能力。`, toolsList, { advanced: { entity_id: target.id } });
      return result(plan, `已为 ${String(target.components.identity?.name ?? target.id)} 打开头像裁剪器：拖动图片、滚轮/双指缩放，确认后保存头像裁剪设置（原图不变）。`, toolsList, {
        directive: { kind: 'open_crop_editor', entity_id: target.id, source_asset_id: fullbody, current_avatar: avatar, crop: visuals.avatar_crop ?? null },
        advanced: { entity_id: target.id, source_asset_id: fullbody },
      });
    }
    case 'module.enable':
    case 'module.disable':
    case 'module.remove': {
      const moduleId = plan.args.module as string | null;
      if (!moduleId) return result(plan, '请说明是哪一个系统（地图、商店、背包、装备、任务、生活模式…）。', toolsList);
      // Only destructive removal asks first; enable/disable are reversible configuration changes.
      if (tool.tool_id === 'module.remove' && !body.confirmed) return result(plan, `将要移除「${moduleLabel(moduleId)}」。移除会删除该系统的自有状态（会先写检查点）。确认后执行。`, toolsList);

      const next = await service.manageModule({ module: moduleId, confirmed: true, game_id: save.game_id, expected_revision: save.state_revision, request_id: crypto.randomUUID() }, tool.tool_id === 'module.enable' ? 'enable' : tool.tool_id === 'module.disable' ? 'disable' : 'remove');
      return result(plan, `${tool.tool_id === 'module.enable' ? '已启用' : tool.tool_id === 'module.disable' ? '已停用' : '已移除'}「${moduleLabel(moduleId)}」。`, toolsList, { needs_confirmation:false, advanced: { revision: next.revision, panels: next.panels.map(panel => panel.id) } });
    }
    case 'save.export':
      return result(plan, '已准备导出标准存档包。', toolsList, { directive: { kind: 'export_save' } });
    case 'extension.create':
      return result(plan, '这需要一个 Framework 目前没有的玩法。我会在「高级开发」里准备一个候选扩展，构建与验证通过后由你确认安装；它不会自动改框架源码。', toolsList, { directive: { kind: 'extension_development', request: String(plan.args.request ?? body.input) } });
    case 'framework.development':
      return result(plan, '修改 Framework 核心或存档机制属于框架开发，当前尚未接入核心源码开发流程，也不会让 Codex 直接改动源码。', toolsList);
    default:
      return result(plan, '我还不确定你的目标，可以再具体一点吗？', toolsList);
  }
}
