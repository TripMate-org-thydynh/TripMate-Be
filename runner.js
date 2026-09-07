const { spawn } = require('child_process');
const path = require('path');

function start() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Supervisor] Spawning backend: node dist/main.js`);

  const child = spawn(process.execPath, [path.join(__dirname, 'dist', 'main.js')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    const exitTime = new Date().toISOString();
    console.error(`[${exitTime}] [Supervisor] Backend exited (code=${code}, signal=${signal}). Restarting in 1s...`);
    setTimeout(start, 1000);
  });

  child.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] [Supervisor] Spawn error:`, err);
    setTimeout(start, 2000);
  });
}

start();
