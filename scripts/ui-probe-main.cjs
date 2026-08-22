/**
 * Electron entry for the rendered-layout probe (scripts/ui-probe.mjs).
 *
 * Mirrors src/main/application.ts's window configuration -- same preload,
 * same context-isolation settings, same background -- but skips feature
 * registration, single-instance locking, and the auto-updater so the probe
 * measures pure renderer layout. Reads UI_PROBE_SIZES, loads the built
 * renderer at each size, runs the measurement script, and prints one line
 * REPORT:[...] for the driver to parse.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const sizes = JSON.parse(process.env.UI_PROBE_SIZES || '[]');

// The renderer fires a few preboot IPC calls during mount; feature
// registration is intentionally skipped here, so answer them with no-ops to
// keep the probe output clean.
for (const channel of ['editor:sync-from-renderer', 'system:check-ffmpeg']) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, () => null);
}

/** Runs in the page: generic overflow scan plus the token checks the parity
 * ledger records after every UI batch. */
const MEASURE = () => {
  const doc = document.documentElement;
  const offenders = [];
  document.querySelectorAll('body *').forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    if (rect.right > window.innerWidth + 1 || rect.bottom > window.innerHeight + 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 80),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      });
    }
  });

  let textProbe = null;
  const liveTokenElement = document.querySelector('.text-2xs');
  if (liveTokenElement) textProbe = getComputedStyle(liveTokenElement).fontSize;

  return {
    width: window.innerWidth,
    height: window.innerHeight,
    overflowX: doc.scrollWidth - window.innerWidth,
    overflowY: doc.scrollHeight - window.innerHeight,
    offenderCount: offenders.length,
    offenders,
    token: getComputedStyle(document.documentElement).getPropertyValue('--text-2xs').trim(),
    textProbe,
  };
};

async function measureAt(win, size) {
  await new Promise((resolve) => {
    win.setContentSize(size.width, size.height);
    // Two animation frames after resize so container queries settle.
    win.webContents
      .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
      .then(resolve);
  });
  return win.webContents.executeJavaScript(`(${MEASURE.toString()})()`);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: sizes[0].width,
      height: sizes[0].height,
      useContentSize: true,
      show: false,
      backgroundColor: '#0a0a0b',
      webPreferences: {
        preload: path.join(__dirname, '../dist/preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    await win.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
    // Let React mount and first effects run before measuring.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const results = [];
    for (const size of sizes) {
      results.push(await measureAt(win, size));
    }

    console.log(`REPORT:${JSON.stringify(results)}`);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error('[ui-probe-main]', error);
    app.exit(1);
  }
});
