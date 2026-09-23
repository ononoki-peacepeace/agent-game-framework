import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const git = args => execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
const findings = [];
const forbidden = /^(?:node_modules|dist|data|imports|saves|checkpoints|exports|logs|\.tmp[^/]*|test-results|playwright-report|blob-report|\.codex|\.agents)\//;
const patterns = [
  ['credential-format', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['home-path', /[A-Z]:[\\/]Users[\\/][^\\/\s"'<>]+[\\/]/],
  ['credential-url', /https?:\/\/[^/\s:@]+:[^/\s@]+@/],
];
function inspect(label, text) {
  for (const [kind, pattern] of patterns) if (pattern.test(text)) findings.push({ file: label, kind });
}
for (const name of files) {
  const base = path.basename(name);
  if (forbidden.test(name) || (/^\.env(?:\.|$)/.test(base) && base !== '.env.example') ||
      base === 'runtime.lock' || /\.(?:log|tmp|bak)$/.test(base) ||
      /^(?:assets|public)\/(?:avatars|uploads)\//.test(name))
    findings.push({ file: name, kind: 'private-or-runtime-path' });
  const stat = fs.lstatSync(name);
  if (stat.isSymbolicLink()) { findings.push({ file: name, kind: 'symlink-review-required' }); continue; }
  const bytes = fs.readFileSync(name);
  if (!bytes.includes(0)) inspect(name, bytes.toString('utf8'));
}
// Audit staged and reachable/unreachable historical blobs as well as working files.
const objects = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).trim().split('\n').filter(Boolean);
let blobs = 0;
for (const row of objects) {
  const [hash, type] = row.split(' ');
  if (type !== 'blob') continue;
  blobs++;
  inspect('git-object:' + hash, git(['cat-file', 'blob', hash]));
}
console.log(JSON.stringify({ candidateFiles: files.length, gitBlobs: blobs, findings }, null, 2));
console.log('Heuristic audit only: manually review example content, staged diff, and history. No secret values are printed.');
if (findings.length) process.exitCode = 1;
