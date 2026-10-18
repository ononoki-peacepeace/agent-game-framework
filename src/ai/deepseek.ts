import { ProviderError, providerError } from './failures.js';
import { compileStructuredSchema, schemaViolations } from './provider-schema.js';
import { observe } from '../observability/index.js';
import type { AIAdapter, AIRequest, AIResult } from './contracts.js';

type FetchLike = typeof fetch;

type DeepSeekAdapterOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  cooldownMs?: number;
};

type DeepSeekResponse = {
  status?: string;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number;
    output_tokens_details?: {reasoning_tokens?:number} } | null;
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
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private pausedUntil = 0;

  constructor(options: DeepSeekAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
    this.maxOutputTokens = options.maxOutputTokens ?? Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS ?? 24000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180000;
    this.cooldownMs = options.cooldownMs ?? 60000;
  }
  providerInfo() { return { provider: this.name, model: this.model, maxOutputTokens: this.maxOutputTokens }; }
  /** A transport failure is a provider failure like any other: readable to the player, detailed in the log. */
  private async request(url: string, init: RequestInit) {
    try { return await this.fetchImpl(url, init); }
    catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ProviderError('network', String((error as Error)?.message ?? error), 'DeepSeek 连接失败：请检查本机网络或代理设置后重试。');
    }
  }

  async generate(request: AIRequest): Promise<AIResult> {
    if (!this.apiKey) throw new Error('DEEPSEEK_API_KEY 未设置');
    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens < 1) throw new Error('DEEPSEEK_MAX_OUTPUT_TOKENS 必须是正整数');
    // Per-role budgets let the routine compiler/GM ask for more room than a short narrator line.
    const budget = Math.min(request.maxOutputTokens ?? this.maxOutputTokens, this.maxOutputTokens);
    if(Date.now()<this.pausedUntil)throw new ProviderError('provider_cooldown',
      'A prior DeepSeek request exhausted the local response timeout',
      '模型服务上一请求持续未返回，已暂停自动调用。请稍后重试原请求。');

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    // Canonical Zod stays untouched; only the outgoing provider schema is normalized for strict mode.
    const schema = compileStructuredSchema(request.schema && typeof request.schema === 'object' ? request.schema : {});
    // Diagnostic: the formal product path must never send an object whose required != properties.
    const violations = schemaViolations(schema);
    if (violations.length) observe('error', 'provider.schema.invalid', { module: 'ai', metadata: { role: request.role, violations: violations.slice(0, 6) } });
    else observe('debug', 'provider.schema.checked', { module: 'ai', metadata: { role: request.role, objects: 'ok' } });

    const started=performance.now();
    let phase:'awaiting_headers'|'reading_body'='awaiting_headers';
    let httpStatus:number|null=null,firstBodyMs:number|null=null,bodyBytes=0;
    let raw:string;
    try{
    const response = await this.request(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: request.prompt,
        max_output_tokens: budget,
        ...(request.reasoningEffort?{reasoning:{effort:request.reasoningEffort}}:{}),
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
    httpStatus=response.status;
    phase='reading_body';
    observe('info','provider.transport.headers',{module:'ai',duration_ms:performance.now()-started,
      metadata:{provider:'deepseek',model:this.model,role:request.role,status:response.status}});
    const reader=response.body?.getReader();
    if(reader){
      const decoder=new TextDecoder(),parts:string[]=[];
      for(;;){
        const chunk=await reader.read();
        if(chunk.done)break;
        if(firstBodyMs===null){firstBodyMs=performance.now()-started;
          observe('info','provider.transport.first_body_byte',{module:'ai',duration_ms:firstBodyMs,
            metadata:{provider:'deepseek',model:this.model,role:request.role,status:response.status}});}
        bodyBytes+=chunk.value.byteLength;
        parts.push(decoder.decode(chunk.value,{stream:true}));
      }
      parts.push(decoder.decode());raw=parts.join('');
    }else raw=await response.text();
    observe('info','provider.transport.body_complete',{module:'ai',duration_ms:performance.now()-started,
      metadata:{provider:'deepseek',model:this.model,role:request.role,status:response.status,
        first_body_ms:firstBodyMs,body_bytes:bodyBytes}});
    }catch(error){
      if(timeout.aborted)this.pausedUntil=Date.now()+this.cooldownMs;
      observe('warn','provider.transport.failed',{module:'ai',duration_ms:performance.now()-started,
        metadata:{provider:'deepseek',model:this.model,role:request.role,phase,status:httpStatus,
          first_body_ms:firstBodyMs,body_bytes:bodyBytes,local_timeout:timeout.aborted,
          caller_aborted:request.signal?.aborted===true}});
      throw error;
    }
    const responseStatus=httpStatus!;
    let payload: DeepSeekResponse;
    try { payload = raw ? JSON.parse(raw) as DeepSeekResponse : {}; }
    catch { throw new Error(`DeepSeek 返回了非 JSON HTTP 响应（${responseStatus}）`); }

    if (responseStatus<200||responseStatus>=300) {
      const detail = payload.error?.message || raw.slice(0, 500) || `HTTP ${responseStatus}`;
      throw providerError(payload.error?.code ?? `http_${responseStatus}`, detail, 'DeepSeek 请求失败');
    }
    if (payload.status !== 'completed') {
      const reason = payload.incomplete_details?.reason ?? payload.error?.code ?? payload.status ?? 'unknown';
      const detail = payload.error?.message || payload.incomplete_details?.reason || payload.status || 'unknown status';
      // A truncated or filtered response is never parsed as data: half a JSON document must not reach the framework.
      throw providerError(reason, detail, 'DeepSeek 响应未完成');
    }

    if(payload.output?.some(item=>item.content?.some(part=>part.type==='refusal')))throw providerError('refusal','Provider declined this content','本段描写需要安全降级');
    const text = payload.output
      ?.filter(item => item.type === 'message')
      .flatMap(item => item.content ?? [])
      .find(part => part.type === 'output_text')
      ?.text;
    if (!text) throw providerError('missing_output_text', 'output_text missing', 'DeepSeek 响应缺少内容');

    const usage = typeof payload.usage?.input_tokens === 'number' && typeof payload.usage?.output_tokens === 'number'
      ? { input_tokens: payload.usage.input_tokens, output_tokens: payload.usage.output_tokens,
        ...(typeof payload.usage.output_tokens_details?.reasoning_tokens==='number'
          ?{reasoning_tokens:payload.usage.output_tokens_details.reasoning_tokens}:{}) } : undefined;
    try { return { data: JSON.parse(text), ...(usage?{usage}:{}) }; }
    catch { throw providerError('invalid_json', `chars=${text.length}`, 'DeepSeek 结构化输出不是合法 JSON'); }
  }
}
