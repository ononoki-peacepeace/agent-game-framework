import { sanitizePlayerText } from './player-copy.js';
import type { DevelopmentTask } from '../extensions/tasks.js';

export interface DevelopmentPlayerView {
  message: string;
  question: string | null;
  options: { id: string; label: string; detail?: string }[];
  allowsDelegate: boolean;
  preview: Record<string, string> | null;
}

/**
 * One projection decides what a player may read about a DevelopmentTask. Understanding dumps, capability gaps,
 * tool ids and workflow words belong to the advanced fold only, so they are stripped here — not by hiding CSS.
 */
export function developmentPlayerView(task: Pick<DevelopmentTask, 'message' | 'status' | 'clarification_options' | 'preview'>): DevelopmentPlayerView {
  const asking = task.status === 'waiting_for_user';
  const options = (task.clarification_options ?? []).slice(0, 4).map((label, index) => ({ id: `option_${index + 1}`, label: sanitizePlayerText(label, '') })).filter(option => option.label.length > 0);
  const preview = task.preview && task.status === 'ready_for_preview'
    ? Object.fromEntries(Object.entries({
      name: task.preview.name,
      usage: task.preview.usage,
      rules: task.preview.rules.join('；'),
      ui: task.preview.ui.join('、'),
      world_integration: task.preview.world_integration,
      own_state: task.preview.own_state.join('、'),
      permissions: task.preview.permissions.join('；'),
      risk: task.preview.risk,
      migration: task.preview.migration.join('；'),
    }).map(([key, value]) => [key, sanitizePlayerText(String(value ?? ''), '')]))
    : null;
  return {
    message: sanitizePlayerText(task.message, '开发任务正在处理。'),
    question: asking ? sanitizePlayerText(task.message, '还需要你补充一项信息。') : null,
    options,
    allowsDelegate: asking,
    preview,
  };
}
