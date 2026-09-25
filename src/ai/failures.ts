// Provider failures carry a machine reason for the log and a readable sentence for the player UI.
export class ProviderError extends Error {
  constructor(readonly reason: string, readonly detail: string, message: string) { super(message); this.name = 'ProviderError'; }
}
const readable: Record<string, string> = {
  max_output_tokens: '输出达到最大 Token 限制（max_output_tokens），响应未完成',
  content_filter: '内容被提供方的安全策略截断，响应未完成',
  rate_limit: '请求过于频繁（rate_limit），响应未完成',
  length: '输出达到长度上限，响应未完成',
  server_error: '提供方内部错误，响应未完成',
};
export function describeIncomplete(reason: string) {
  return readable[reason] ?? `响应未完成（reason=${reason}）`;
}
export function providerError(reason: string, detail: string, prefix: string) {
  return new ProviderError(reason, detail, `${prefix}：${describeIncomplete(reason)}`);
}
export function failureReason(error: unknown) {
  if (error instanceof ProviderError) return error.reason;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/timeout|abort/i.test(message)) return 'timeout';
  const match = message.match(/reason=([a-z_]+)/i);
  return match ? match[1] : 'unknown';
}
export function isTruncationFailure(error: unknown) {
  // Truncated output is the main case; a provider-level malformed/empty JSON body is equally transient.
  return ['max_output_tokens','length','invalid_json','missing_output_text'].includes(failureReason(error));
}
export function readableFailureMessage(error: unknown) {
  if (error instanceof ProviderError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return message || '提供方调用失败';
}
