const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const debugLogPath = path.join(os.tmpdir(), 'mypdf-argv.log');

function appendArgLog(label, argv) {
  try {
    const time = new Date().toISOString();
    const lines = [`[${time}] ${label}`];
    for (let i = 0; i < argv.length; i++) {
      lines.push(`${i}: ${argv[i]}`);
    }
    lines.push('');
    fs.appendFileSync(debugLogPath, lines.join(os.EOL));
  } catch (e) {
    // ignore logging errors
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile('index.html');
}

function findPdfArg(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    try {
      if (typeof arg === 'string' && arg.toLowerCase().endsWith('.pdf') && fs.existsSync(arg)) {
        return path.resolve(arg);
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('menu-open-pdf');
          }
        },
        {
          label: 'Close PDF',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            mainWindow?.webContents.send('menu-close-pdf');
          }
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help' }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  appendArgLog('startup', process.argv || []);
  app.whenReady().then(() => {
    createMenu();
    createWindow();

    // If launched with a PDF argument, open it after the window loads
    const initialPdf = findPdfArg(process.argv);
    if (initialPdf) {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('open-file', initialPdf);
      });
    }

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Handle when another instance is launched (e.g., user double-clicks a file or uses Open with...)
  app.on('second-instance', (event, argv) => {
    appendArgLog('second-instance', argv || []);
    const pdf = findPdfArg(argv);
    if (pdf && mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('open-file', pdf);
    }
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('show-open-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled) return null;
  return filePaths[0];
});

ipcMain.handle('show-save-dialog', async (_event, defaultPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled) return null;
  return filePath;
});
