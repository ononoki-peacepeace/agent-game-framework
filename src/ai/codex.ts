import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AIAdapter, AIRequest, AIResult } from './contracts.js';
import { compileStructuredSchema } from './provider-schema.js';
import {ProviderError} from './failures.js';

function unsupportedCodexSchema(node:unknown,path='$'):string|null{
  if(!node||typeof node!=='object')return null;
  if(Array.isArray(node))return node.map((item,index)=>unsupportedCodexSchema(item,`${path}[${index}]`)).find(Boolean)??null;
  const value=node as Record<string,unknown>;
  if('propertyNames' in value)return `${path}.propertyNames`;
  for(const [key,child] of Object.entries(value)){
    const found=unsupportedCodexSchema(child,`${path}.${key}`);
    if(found)return found;
  }
  return null;
}

function isProviderSchemaRejection(error:unknown){
  return /invalid_json_schema|Invalid schema for response_format/i.test(String(error));
}

export class CodexAdapter implements AIAdapter {
  readonly name = 'codex';
  private codex: Codex;
  private options: ThreadOptions;
  constructor(private directory = resolve('data/ai-work'), client?: Codex) {
    this.codex = client ?? new Codex({
      codexPathOverride: process.env.CODEX_PATH || undefined,
      // No env override: SDK inherits proxy variables and the user's ChatGPT auth environment.
      config: { forced_login_method: 'chatgpt', features: { shell_tool: false, unified_exec: false, apply_patch_freeform: false, multi_agent: false, apps: false, remote_plugin: false },
        tools: { view_image: false }, project_doc_max_bytes: 0 },
      configOverrides: ['mcp_servers={}', 'hooks={}'],
    });
    this.options = { workingDirectory: directory, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false, model: process.env.CODEX_MODEL || undefined };
  }
  providerInfo() { return { provider: this.name, model: this.options.model ?? null }; }
  async generate(request: AIRequest): Promise<AIResult> {
    const compiled=compileStructuredSchema(request.schema) as Record<string,unknown>;
    const unsupported=unsupportedCodexSchema(compiled);
    if(unsupported)throw new ProviderError('invalid_provider_schema',unsupported,
      'Codex 输出结构不兼容，未执行本次模型请求。');
    // Codex structured output requires an object root. Wrap array/union roots
    // only for transport; AIRuntime still validates the original canonical schema.
    const wrapped=compiled.type!=='object';
    const outputSchema=wrapped?{type:'object',properties:{result:compiled},required:['result'],additionalProperties:false}:compiled;
    const prompt=wrapped?`${request.prompt}\n\n只输出 JSON 对象，将原本的完整结果放在 result 字段中。`:request.prompt;
    await mkdir(this.directory, { recursive: true });
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    const run = async (resume?: string): Promise<AIResult> => {
      const thread = resume ? this.codex.resumeThread(resume, this.options) : this.codex.startThread(this.options);
      const result = await thread.run(prompt, { outputSchema, signal });
      if (result.items.some(i => ['command_execution','file_change','mcp_tool_call','web_search'].includes(i.type))) throw new Error('AI_TOOL_BOUNDARY: unexpected tool use');
      const parsed=JSON.parse(result.finalResponse) as unknown;
      if(wrapped&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Object.hasOwn(parsed,'result')))
        throw new ProviderError('schema','Codex transport wrapper missing result','Codex 输出缺少结构化结果。');
      return { data: wrapped?(parsed as {result:unknown}).result:parsed, threadId: thread.id ?? undefined,
        ...(result.usage?{usage:{input_tokens:result.usage.input_tokens,output_tokens:result.usage.output_tokens}}:{}) };
    };
    try { return await run(request.threadId); }
    catch (error) {
      if(isProviderSchemaRejection(error))throw new ProviderError('invalid_provider_schema',
        'Codex rejected structured output schema','Codex 输出结构不兼容，未执行本次模型请求。');
      // A failed cache can always be discarded: this request carries the current canonical context.
      if (!request.threadId || signal.aborted || String(error).includes('AI_TOOL_BOUNDARY')||
        error instanceof ProviderError&&error.reason==='schema') throw error;
      return { ...await run(), recovered: true };
    }
  }
}
