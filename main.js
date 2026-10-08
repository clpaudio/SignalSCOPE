const { app, BrowserWindow } = require('electron');
const path = require('path');

// Arrancamos el servidor integrado
require('./server.js');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Stage Scope - Pro Audio Audit",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Limpieza total de caché y almacenamiento local de Electron antes de cargar
  mainWindow.webContents.session.clearCache().then(() => {
    mainWindow.webContents.session.clearStorageData().then(() => {
      setTimeout(() => {
        mainWindow.loadURL('http://localhost:3000');
      }, 1000);
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (process.platform === 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});