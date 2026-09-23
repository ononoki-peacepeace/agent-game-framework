import type { AIAdapter, AIRequest, AIResult } from './contracts.js';

type FetchLike = typeof fetch;
export type OpenAIAdapterOptions = {
  apiKey?: string; baseUrl?: string; model?: string; maxOutputTokens?: number; fetchImpl?: FetchLike;
};
type ResponsePayload = {
  status?: string; error?: { message?: string } | null; incomplete_details?: { reason?: string } | null;
  output_text?: string;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
};

export class OpenAIAdapter implements AIAdapter {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: FetchLike;
  constructor(options: OpenAIAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-5.6-luna';
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 12000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  async generate(request: AIRequest): Promise<AIResult> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY 未设置');
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model, input: request.prompt, max_output_tokens: this.maxOutputTokens,
        text: { format: { type: 'json_schema', name: `agent_game_${request.role}`, strict: true, schema: request.schema && typeof request.schema === 'object' ? request.schema : {} } },
      }),
    });
    const raw = await response.text();
    let payload: ResponsePayload;
    try { payload = raw ? JSON.parse(raw) as ResponsePayload : {}; }
    catch { throw new Error(`OpenAI 返回了非 JSON HTTP 响应（${response.status}）`); }
    if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${payload.error?.message || raw.slice(0, 500) || response.statusText}`);
    if (payload.status && payload.status !== 'completed') throw new Error(`OpenAI 响应未完成: ${payload.error?.message || payload.incomplete_details?.reason || payload.status}`);
    const text = payload.output_text ?? payload.output?.filter(x => x.type === 'message').flatMap(x => x.content ?? []).find(x => x.type === 'output_text')?.text;
    if (!text) throw new Error('OpenAI 响应缺少 output_text');
    try { return { data: JSON.parse(text) }; }
    catch { throw new Error('OpenAI structured output 不是合法 JSON'); }
  }
}
