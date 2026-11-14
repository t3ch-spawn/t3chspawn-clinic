import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', '--test-name-pattern=isolated live Supabase connections', 'test/assessment.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, RUN_LIVE_AUDIT: 'true' },
});
child.on('error', () => { console.error('Could not start live tests.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
