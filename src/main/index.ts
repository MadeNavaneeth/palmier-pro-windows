/**
 * Palmier Pro Windows - main process bootstrap.
 *
 * Keep this entry point intentionally small. Feature modules are loaded only
 * after Electron is ready so packages that use app paths can initialize safely.
 */

import { app, BrowserWindow, dialog } from 'electron';

/**
 * Windowless MCP server mode for CI/batch harnesses. Skips the
 * single-instance lock so an automation run can coexist with the desktop
 * app, and never opens a window.
 */
const mcpServerMode = process.argv.includes('--mcp-server');

const allowMultipleInstances = process.env['PALMIER_ALLOW_MULTIPLE_INSTANCES'] === '1';
const hasSingleInstanceLock = mcpServerMode || allowMultipleInstances || app.requestSingleInstanceLock();

if (mcpServerMode) {
  app.whenReady()
    .then(async () => {
      const { startMcpServerMode } = await import('./mcp-server-mode');
      await startMcpServerMode();
    })
    .catch((error: unknown) => {
      console.error('Palmier Pro MCP server mode failed to start:', error);
      app.exit(1);
    });
} else if (!hasSingleInstanceLock) {
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
