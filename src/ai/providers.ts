import { z } from 'zod';
import { join } from 'node:path';
import type { AIAdapter, AIRequest, AIResult } from './contracts.js';
import { CodexAdapter } from './codex.js';
import { DeepSeekAdapter } from './deepseek.js';
import { MockAIAdapter } from './mock.js';
import { OpenAIAdapter } from './openai.js';
import { ResponsesCompatibleAdapter } from './responses-compatible.js';

export const providerConfigSchema = z.strictObject({
  provider: z.enum(['codex','openai','deepseek','responses-compatible','mock']),
  api_key: z.string().max(1000).optional(), model: z.string().min(1).max(200).optional(), base_url: z.string().url().max(500).optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderDescriptor = { id: ProviderConfig['provider']; label: string; note: string; requires_api_key: boolean; supports_base_url: boolean; default_model?: string };

const descriptors: ProviderDescriptor[] = [
  { id:'codex', label:'Codex / ChatGPT 会员', note:'使用本机 Codex CLI 的 ChatGPT 登录态，不需要 API Key；受 Codex 会员额度限制。', requires_api_key:false, supports_base_url:false },
  { id:'openai', label:'OpenAI API', note:'使用 OpenAI Responses API；API 用量与 ChatGPT/Codex 会员分开计费。', requires_api_key:true, supports_base_url:false, default_model:'gpt-5.6-luna' },
  { id:'deepseek', label:'DeepSeek API', note:'使用 DeepSeek Responses API。', requires_api_key:true, supports_base_url:false, default_model:'deepseek-flash' },
  { id:'responses-compatible', label:'Responses 兼容 API', note:'用于实现 OpenAI Responses 风格 /responses + JSON Schema 的第三方服务。', requires_api_key:true, supports_base_url:true },
  { id:'mock', label:'离线 Mock', note:'只验证程序规则，不理解自由文本。', requires_api_key:false, supports_base_url:false },
];

export class AIProviderManager implements AIAdapter {
  private current: AIAdapter;
  private config: ProviderConfig;
  private remembered = new Map<ProviderConfig['provider'], ProviderConfig>();
  constructor(private directory: string, initial?: ProviderConfig) {
    this.config = initial ?? { provider: (process.env.AI_ADAPTER as ProviderConfig['provider'] | undefined) ?? 'codex' };
    this.remembered.set(this.config.provider, { ...this.config });
    this.current = this.make(this.config);
  }
  get name() { return this.current.name; }
  async generate(request: AIRequest): Promise<AIResult> { return this.current.generate(request); }
  list() { return descriptors; }
  info() { return { provider: this.config.provider, name: this.current.name, model: this.config.model ?? this.defaultModel(this.config.provider), base_url: this.config.base_url ?? null }; }
  configure(input: ProviderConfig) {
    const old = this.remembered.get(input.provider) ?? { provider: input.provider };
    const merged: ProviderConfig = { ...old, ...input, ...(input.api_key ? { api_key: input.api_key } : {}) };
    this.current = this.make(merged); this.config = merged; this.remembered.set(merged.provider, merged);
    return this.info();
  }
  private defaultModel(provider: ProviderConfig['provider']) {
    if (provider === 'openai') return process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';
    if (provider === 'deepseek') return process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
    if (provider === 'codex') return process.env.CODEX_MODEL ?? null;
    return null;
  }
  private make(config: ProviderConfig): AIAdapter {
    if (config.provider === 'mock') return new MockAIAdapter();
    if (config.provider === 'codex') return new CodexAdapter(join(this.directory, 'ai-work'));
    if (config.provider === 'openai') {
      if (!config.api_key && !process.env.OPENAI_API_KEY) throw new Error('OpenAI API 需要 API Key（页面输入或 OPENAI_API_KEY）');
      return new OpenAIAdapter({ apiKey: config.api_key, model: config.model });
    }
    if (config.provider === 'deepseek') {
      if (!config.api_key && !process.env.DEEPSEEK_API_KEY) throw new Error('DeepSeek API 需要 API Key（页面输入或 DEEPSEEK_API_KEY）');
      return new DeepSeekAdapter({ apiKey: config.api_key, model: config.model });
    }
    if (!config.api_key) throw new Error('自定义 Responses API 需要 API Key');
    if (!config.base_url) throw new Error('自定义 Responses API 需要 Base URL');
    if (!config.model) throw new Error('自定义 Responses API 需要模型名');
    return new ResponsesCompatibleAdapter({ apiKey: config.api_key, baseUrl: config.base_url, model: config.model });
  }
}
