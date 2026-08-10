const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.loadURL('http://127.0.0.1:9000/dashboard/');
}

function startLocalServer() {
  const repoRoot = __dirname;
  serverProcess = spawn(process.execPath, ['-m', 'http.server', '9000'], {
    cwd: repoRoot,
    stdio: 'ignore',
    shell: false
  });

  serverProcess.on('error', () => {});
}

app.whenReady().then(() => {
  startLocalServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});
