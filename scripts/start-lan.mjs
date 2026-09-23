import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist/server/server/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, HOST: '0.0.0.0' },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', code => process.exit(code ?? 0));
