const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const BACKEND_URL = process.env.INTERVIEW_BACKEND_URL || 'http://127.0.0.1:8787';
const RENDERER_DIR = path.join(__dirname, 'renderer');
const RENDERER_URL_PREFIX = pathToFileURL(RENDERER_DIR).href + '/';

let mainWindow = null;

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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// No navigation away from the app and no new windows.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
