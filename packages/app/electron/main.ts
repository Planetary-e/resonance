import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import { join } from 'node:path';
import { createAppServer } from '../src/server/server.js';
import { lockSession, loadRelayConfig } from '../src/server/session.js';

const PORT = 3000;
const RELAY_URL = 'ws://localhost:9091';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appServer: Awaited<ReturnType<typeof createAppServer>> | null = null;

async function startBackend(): Promise<void> {
  const server = createAppServer({ port: PORT, relayUrl: RELAY_URL });
  await server.start();
  appServer = server as any;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'Resonance',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#08080d',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // In dev mode, load from Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // In production, load the built files
    mainWindow.loadURL(`http://localhost:${PORT}`);
  }

  mainWindow.on('close', (e) => {
    // Hide to tray instead of quitting
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  // Simple tray icon (text-based for now)
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle('R');
  tray.setToolTip('Resonance');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Resonance', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => mainWindow?.show());
}

app.whenReady().then(async () => {
  await startBackend();
  createWindow();
  createTray();
});

app.on('activate', () => {
  mainWindow?.show();
});

app.on('before-quit', () => {
  lockSession();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
