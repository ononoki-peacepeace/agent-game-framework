import { Codex, type ThreadOptions } from '@openai/codex-sdk';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AIAdapter, AIRequest, AIResult } from './contracts.js';

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
    await mkdir(this.directory, { recursive: true });
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
    const run = async (resume?: string): Promise<AIResult> => {
      const thread = resume ? this.codex.resumeThread(resume, this.options) : this.codex.startThread(this.options);
      const result = await thread.run(request.prompt, { outputSchema: request.schema, signal });
      if (result.items.some(i => ['command_execution','file_change','mcp_tool_call','web_search'].includes(i.type))) throw new Error('AI_TOOL_BOUNDARY: unexpected tool use');
      return { data: JSON.parse(result.finalResponse), threadId: thread.id ?? undefined, ...(result.usage?{usage:{input_tokens:result.usage.input_tokens,output_tokens:result.usage.output_tokens}}:{}) };
    };
    try { return await run(request.threadId); }
    catch (error) {
      // A failed cache can always be discarded: this request carries the current canonical context.
      if (!request.threadId || signal.aborted || String(error).includes('AI_TOOL_BOUNDARY')) throw error;
      return { ...await run(), recovered: true };
    }
  }
}
