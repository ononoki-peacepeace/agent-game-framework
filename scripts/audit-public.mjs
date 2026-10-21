import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { once } from 'node:events';

// Bounded metadata records and size-framed blob streams; never buffer a blob.
const root = process.cwd(), args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--revision', '--exceptions'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('-') || options.has(args[i]))
    throw Error('Usage: node scripts/audit-public.mjs [--revision REV] [--exceptions FILE]');
  options.set(args[i], args[i + 1]);
}
const revision = options.get('--revision'), findings = new Map();
const exceptions = options.has('--exceptions') ? JSON.parse(fs.readFileSync(options.get('--exceptions'), 'utf8')).exceptions : [];
// Only exact, reviewed historical home-path objects can be excepted. This
// mechanism cannot waive credentials, private keys, URLs or runtime files.
if (!Array.isArray(exceptions) || exceptions.some(entry => !entry ||
    !/^git-object:[a-f0-9]{40,64}$/.test(entry.file) || entry.kind !== 'home-path' ||
    typeof entry.reason !== 'string' || !entry.reason.trim() || typeof entry.approved_by !== 'string' || !entry.approved_by.trim()))
  throw Error('Invalid audit exceptions: only documented exact-object home-path exceptions are supported');
const forbidden = /^(?:node_modules|dist|data|imports|saves|checkpoints|exports|logs|\.tmp[^/]*|test-results|playwright-report|blob-report|\.codex|\.agents|\.agent-runtime|\.codex-checkpoints)\//;
const patterns = [
  ['credential-format', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['home-path', /[A-Z]:[\\/]Users[\\/][^\\/\s"'<>]+[\\/]/],
  ['credential-url', /https?:\/\/[^/\s:@]+:[^/\s@]+@/],
];
function finding(file, kind) { findings.set(file + '\0' + kind, { file, kind }); }
function inspectPath(name) {
  const base = path.posix.basename(name);
  if (forbidden.test(name) || (/^\.env(?:\.|$)/.test(base) && base !== '.env.example') ||
      base === 'runtime.lock' || /\.(?:log|tmp|bak)$/.test(base) || /^(?:assets|public)\/(?:avatars|uploads)\//.test(name))
    finding(name, 'private-or-runtime-path');
}
function scanner(label) {
  const decoder = new StringDecoder('utf8'); let tail = '';
  const scan = text => {
    const window = tail + text;
    for (const [kind, pattern] of patterns) if (pattern.test(window)) finding(label, kind);
    // Heuristic boundary, explicitly reported: arbitrary tokens >64 KiB are
    // outside the overlap guarantee. Binary blobs are scanned too.
    tail = window.slice(-65536);
  };
  return { write: bytes => scan(decoder.write(bytes)), end: () => scan(decoder.end()) };
}
function git(parameters) {
  const child = spawn('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), ...parameters],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-2048); });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error('git ' + parameters[0] + ' failed (' + code + '): ' + diagnostics)));
  });
  done.catch(() => {});
  return { child, done };
}
async function* records(parameters, delimiter = '\n') {
  const { child, done } = git(parameters); child.stdin.end();
  let tail = ''; const decoder = new StringDecoder('utf8');
  try {
    for await (const bytes of child.stdout) {
      tail += decoder.write(bytes); let index;
      while ((index = tail.indexOf(delimiter)) >= 0) {
        yield tail.slice(0, index); tail = tail.slice(index + delimiter.length);
      }
      if (tail.length > 1024 * 1024) throw Error('Unbounded Git metadata record');
    }
    tail += decoder.end(); if (tail) yield tail;
    await done;
  } finally { if (child.exitCode === null) child.kill(); }
}
async function main() {
  let candidateFiles = 0;
  if (revision) {
    // Explicit publication scope: candidate tree + all reachable history.
    // Unrelated dirty/unreachable local objects are not sent by normal push.
    for await (const entry of records(['ls-tree', '-r', '-z', revision], '\0')) {
      const tab = entry.indexOf('\t'), name = entry.slice(tab + 1), mode = entry.slice(0, 6);
      candidateFiles++; inspectPath(name);
      if (mode === '120000' || mode === '160000') finding(name, 'symlink-or-submodule-review-required');
    }
    for await (const entry of records(['log', '--format=', '--name-only', '-z', revision, '--'], '\0')) {
      const name = entry.replace(/^\n+/, ''); if (name) inspectPath(name);
    }
  } else {
    const seen = new Set();
    for await (const name of records(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], '\0')) {
      if (!name || seen.has(name)) continue;
      seen.add(name); candidateFiles++; inspectPath(name);
      if (!fs.existsSync(name)) continue;
      if (fs.lstatSync(name).isSymbolicLink()) { finding(name, 'symlink-review-required'); continue; }
      const scan = scanner(name);
      for await (const bytes of fs.createReadStream(name, { highWaterMark: 65536 })) scan.write(bytes);
      scan.end();
    }
  }
  const batch = git(['cat-file', '--batch']), iterator = batch.child.stdout[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0), blobs = 0, bytesScanned = 0, largestBlob = 0;
  const fill = async () => {
    const next = await iterator.next();
    if (next.done) throw Error('Truncated git cat-file response');
    pending = next.value;
  };
  const line = async () => {
    const parts = []; let length = 0;
    for (;;) {
      if (!pending.length) await fill();
      const index = pending.indexOf(10), part = index < 0 ? pending : pending.subarray(0, index);
      length += part.length; if (length > 1024) throw Error('Invalid cat-file header');
      parts.push(part); pending = index < 0 ? Buffer.alloc(0) : pending.subarray(index + 1);
      if (index >= 0) return Buffer.concat(parts).toString('utf8');
    }
  };
  try {
    const metadata = revision ? ['rev-list', '--objects', revision, '--'] : ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'];
    for await (const entry of records(metadata)) {
      const hash = entry.split(' ')[0];
      if (!/^[a-f0-9]{40,64}$/.test(hash)) throw Error('Invalid object ID');
      if (!batch.child.stdin.write(hash + '\n')) await once(batch.child.stdin, 'drain');
      const header = await line(), match = /^([a-f0-9]+) (blob|tree|commit|tag) (\d+)$/.exec(header);
      if (!match || match[1] !== hash) throw Error('Unexpected cat-file response');
      const size = Number(match[3]); if (!Number.isSafeInteger(size)) throw Error('Invalid object size');
      const scan = match[2] === 'blob' ? scanner('git-object:' + hash) : undefined;
      if (scan) { blobs++; bytesScanned += size; largestBlob = Math.max(largestBlob, size); }
      let remaining = size;
      while (remaining) {
        if (!pending.length) await fill();
        const take = Math.min(remaining, pending.length);
        scan?.write(pending.subarray(0, take)); pending = pending.subarray(take); remaining -= take;
      }
      scan?.end(); if (!pending.length) await fill();
      if (pending[0] !== 10) throw Error('Invalid cat-file object boundary');
      pending = pending.subarray(1);
    }
    batch.child.stdin.end(); await batch.done;
  } finally { if (batch.child.exitCode === null) batch.child.kill(); }
  const active = [], knownExceptions = [];
  for (const item of findings.values()) {
    const approved = exceptions.find(entry => entry.file === item.file && entry.kind === item.kind);
    if (approved) knownExceptions.push({ ...item, reason: approved.reason, approved_by: approved.approved_by });
    else active.push(item);
  }
  console.log(JSON.stringify({ scope: revision ? 'revision-and-reachable-history:' + revision : 'working-files-and-all-local-objects',
    candidateFiles, gitBlobs: blobs, bytesScanned, largestBlob, findings: active, knownExceptions }, null, 2));
  console.log('Heuristic audit only: manually review candidate content and history. Bounded 64 KiB overlap; no secret values are printed.');
  if (active.length) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 2; });
