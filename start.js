const { spawn } = require('child_process');
const electronPath = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Ensure a writable user-data dir for Electron to avoid cache permission errors on Windows
const userDataDir = path.join(os.tmpdir(), 'mypdf-electron-user-data');
try {
  fs.mkdirSync(userDataDir, { recursive: true });
} catch (e) {}

const child = spawn(electronPath, ['.', `--user-data-dir=${userDataDir}`], {
  stdio: 'inherit',
  env,
  windowsHide: false
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
