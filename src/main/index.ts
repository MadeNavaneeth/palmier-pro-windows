/**
 * Palmier Pro Windows - main process bootstrap.
 *
 * Keep this entry point intentionally small. Feature modules are loaded only
 * after Electron is ready so packages that use app paths can initialize safely.
 */

import { app, BrowserWindow, dialog } from 'electron';

const allowMultipleInstances = process.env['PALMIER_ALLOW_MULTIPLE_INSTANCES'] === '1';
const hasSingleInstanceLock = allowMultipleInstances || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady()
    .then(async () => {
      const { startApplication } = await import('./application');
      startApplication();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error
        ? `${error.message}\n\n${error.stack ?? ''}`
        : String(error);

      console.error('Palmier Pro failed to start:', error);
      dialog.showErrorBox('Palmier Pro could not start', message);
      app.quit();
    });
}
