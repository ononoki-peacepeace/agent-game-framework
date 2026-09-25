import { normalizeStructuredSchema } from './provider-schema.js';
import type { AIAdapter, AIRequest, AIResult } from './contracts.js';


type FetchLike = typeof fetch;
export type ResponsesCompatibleOptions = { apiKey: string; baseUrl: string; model: string; fetchImpl?: FetchLike; maxOutputTokens?: number };

type Payload = { status?: string; error?: { message?: string } | null; output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };

/** Generic adapter for providers that implement an OpenAI Responses-compatible /responses endpoint with JSON Schema text.format. */
export class ResponsesCompatibleAdapter implements AIAdapter {
  readonly name = 'responses-compatible';
  private fetchImpl: FetchLike;
  constructor(private options: ResponsesCompatibleOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }
  providerInfo() { return { provider: this.name, model: this.options.model }; }
  async generate(request: AIRequest): Promise<AIResult> {
    if (!this.options.apiKey) throw new Error('自定义 API Key 未设置');
    if (!this.options.baseUrl || !this.options.model) throw new Error('自定义 Responses API 需要 base_url 和 model');
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.options.model, input: request.prompt, max_output_tokens: request.maxOutputTokens ?? this.options.maxOutputTokens ?? 12000,
        text: { format: { type: 'json_schema', name: `agent_game_${request.role}`, schema: normalizeStructuredSchema(request.schema && typeof request.schema === 'object' ? request.schema : {}) } } }),
    });
    const raw = await response.text(); let payload: Payload;
    try { payload = raw ? JSON.parse(raw) as Payload : {}; } catch { throw new Error(`自定义 API 返回非 JSON（${response.status}）`); }
    if (!response.ok) throw new Error(`自定义 API ${response.status}: ${payload.error?.message || raw.slice(0, 500) || response.statusText}`);
    const text = payload.output_text ?? payload.output?.filter(x => x.type === 'message').flatMap(x => x.content ?? []).find(x => x.type === 'output_text')?.text;
    if (!text) throw new Error('自定义 Responses API 缺少 output_text');
    try { return { data: JSON.parse(text) }; } catch { throw new Error('自定义 Responses API structured output 不是合法 JSON'); }
  }
}
