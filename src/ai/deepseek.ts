import type { AIAdapter, AIRequest, AIResult } from './contracts.js';

type FetchLike = typeof fetch;

type DeepSeekAdapterOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: FetchLike;
};

type DeepSeekResponse = {
  status?: string;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

/**
 * Stateless DeepSeek Responses API adapter.
 *
 * The framework already sends the current canonical public state on every AI call,
 * so DeepSeek does not need Codex-style server-side thread persistence.
 */
export class DeepSeekAdapter implements AIAdapter {
  readonly name = 'deepseek';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: DeepSeekAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS ?? 12000);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: AIRequest): Promise<AIResult> {
    if (!this.apiKey) throw new Error('DEEPSEEK_API_KEY 未设置');
    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens < 1) throw new Error('DEEPSEEK_MAX_OUTPUT_TOKENS 必须是正整数');

    const timeout = AbortSignal.timeout(180000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const schema = request.schema && typeof request.schema === 'object' ? request.schema : {};

    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: request.prompt,
        max_output_tokens: this.maxOutputTokens,
        text: {
          format: {
            type: 'json_schema',
            name: `agent_game_${request.role}`,
            schema,
          },
        },
      }),
      signal,
    });

    const raw = await response.text();
    let payload: DeepSeekResponse;
    try { payload = raw ? JSON.parse(raw) as DeepSeekResponse : {}; }
    catch { throw new Error(`DeepSeek 返回了非 JSON HTTP 响应（${response.status}）`); }

    if (!response.ok) {
      const detail = payload.error?.message || raw.slice(0, 500) || response.statusText;
      throw new Error(`DeepSeek API ${response.status}: ${detail}`);
    }
    if (payload.status !== 'completed') {
      const detail = payload.error?.message || payload.incomplete_details?.reason || payload.status || 'unknown status';
      throw new Error(`DeepSeek 响应未完成: ${detail}`);
    }

    const text = payload.output
      ?.filter(item => item.type === 'message')
      .flatMap(item => item.content ?? [])
      .find(part => part.type === 'output_text')
      ?.text;
    if (!text) throw new Error('DeepSeek 响应缺少 output_text');

    try { return { data: JSON.parse(text) }; }
    catch { throw new Error('DeepSeek structured output 不是合法 JSON'); }
  }
}
