const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const BACKEND_URL = process.env.INTERVIEW_BACKEND_URL || 'http://127.0.0.1:8787';
const RENDERER_DIR = path.join(__dirname, 'renderer');
const RENDERER_URL_PREFIX = pathToFileURL(RENDERER_DIR).href + '/';
const BACKEND_DIR = path.join(__dirname, '..', 'backend');

let mainWindow = null;
let backendProcess = null;

// ---------- local backend (development checkout only) ----------

function backendPython() {
  const venv = path.join(BACKEND_DIR, '.venv');
  return process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
}

async function backendIsUp() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts backend/app.py when it isn't already running, so one `npm start` is enough.
 * Skipped for a remote INTERVIEW_BACKEND_URL, in a packaged build (no backend/ next to it),
 * or with INTERVIEW_AUTOSTART_BACKEND=0. The renderer's health polling picks it up once ready.
 */
async function startBackendIfNeeded() {
  const { hostname, port } = new URL(BACKEND_URL);
  const local = hostname === '127.0.0.1' || hostname === 'localhost';
  if (!local || app.isPackaged || process.env.INTERVIEW_AUTOSTART_BACKEND === '0') return;
  if (await backendIsUp()) return; // e.g. already running in a terminal: leave it alone

  const python = backendPython();
  if (!fs.existsSync(python) || !fs.existsSync(path.join(BACKEND_DIR, 'app.py'))) {
    console.warn(`[backend] not auto-starting: ${python} not found (see README setup)`);
    return;
  }
  const logPath = path.join(app.getPath('userData'), 'backend.log');
  const log = fs.openSync(logPath, 'a');
  backendProcess = spawn(python, ['app.py'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: port || '8787', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  console.log(`[backend] started pid ${backendProcess.pid}, logging to ${logPath}`);
  backendProcess.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`);
    backendProcess = null;
  });
}

function stopBackend() {
  if (!backendProcess) return;
  const { pid } = backendProcess;
  backendProcess = null;
  if (process.platform === 'win32') {
    // The venv python.exe is a launcher with its own child; kill the whole tree.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

// Only our own renderer page may call privileged IPC.
function isTrustedSender(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith(RENDERER_URL_PREFIX);
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error(`Blocked IPC from untrusted sender on ${channel}`);
    return fn(event, ...args);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'Interview Partner',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Microphone is the only permission the app needs.
  const allowed = new Set(['media']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const audioOnly = !details.mediaTypes || details.mediaTypes.every((t) => t === 'audio');
    callback(allowed.has(permission) && audioOnly && wc.getURL().startsWith(RENDERER_URL_PREFIX));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));

  handle('config:get', () => ({ backendUrl: BACKEND_URL }));
  handle('window:set-always-on-top', (_event, value) => {
    if (mainWindow) mainWindow.setAlwaysOnTop(Boolean(value));
    return Boolean(value);
  });

  createWindow();
  startBackendIfNeeded();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// No navigation away from the app and no new windows.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// Only stops a backend this app started; one you run in a terminal keeps running.
app.on('will-quit', stopBackend);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
