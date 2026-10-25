import { spawn } from 'node:child_process';
const build = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
build.on('exit', async code => {
  if (code) process.exit(code);
  const { default: electron } = await import('electron');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ['.'], { stdio: 'inherit', env: childEnv });
  child.on('exit', code => process.exit(code || 0));
});
