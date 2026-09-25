/**
 * Client-side guard for automatic retries after a revision conflict.
 * The server classifies each conflict: 'safe' only for requests it can reliably prove are read-only.
 * Automatic retry happens at most once per user action so a retry loop is impossible.
 */
export function shouldAutoRetry(policy: string | undefined | null, alreadyRetried: boolean) {
  return policy === 'safe' && !alreadyRetried;
}
