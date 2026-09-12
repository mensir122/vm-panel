// desktop/preload.cjs — Preload script for Electron renderer.
// Context-isolated bridge exposing safe desktop capabilities to window.electronDesktop.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronDesktop', {
  isDesktop: true,
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  deployFolder: (folderPath) => ipcRenderer.invoke('deploy-folder', folderPath),
  openDataFolder: () => ipcRenderer.send('open-data-folder'),
  getPathForFile: (file) => {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        /* fallback to standard file.path if available */
      }
    }
    return (file && file.path) ? file.path : '';
  },
});
