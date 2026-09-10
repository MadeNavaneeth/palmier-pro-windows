/**
 * Electron entry for the rendered-layout probe (scripts/ui-probe.mjs).
 *
 * Mirrors src/main/application.ts's window configuration -- same preload,
 * same context-isolation settings, same background -- but skips feature
 * registration, single-instance locking, and the auto-updater so the probe
 * measures pure renderer layout. Reads UI_PROBE_SIZES, loads the built
 * renderer at each size, runs the measurement script, and prints one line
 * REPORT:[...] for the driver to parse.
 *
 * The probe starts a project before measuring. Without that it only ever
 * rendered the welcome screen, so the workspace -- panels, preview, timeline,
 * every layout that this gate exists to protect -- was never on screen and a
 * crash in a workspace component could pass the gate. `createNew` is pure
 * renderer state, so clicking the button is the real first-run path.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const sizes = JSON.parse(process.env.UI_PROBE_SIZES || '[]');

/**
 * The two workspace states this probe measures.
 *
 * `default` is every panel in its own region. `tabs` groups Media with Agent
 * and Inspector with Export (#286), which is what puts the tab strip on screen —
 * measuring only the default layout would leave the tab UI unverified, exactly
 * the gap that let a crashing preview pass this gate unnoticed.
 */
const GROUPED_PANELS = JSON.stringify([['media', 'agent'], ['inspector', 'export']]);

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
    // Proof the workspace -- not the welcome screen -- is what was measured.
    // A blank render after a crash would otherwise report zero offenders.
    // The playback-speed control belongs to the preview toolbar and renders
    // whenever the workspace does (unlike, say, the "behind the clock" dot,
    // which only appears when the preview actually lags).
    workspaceReady: Boolean(document.querySelector('[aria-label="Playback speed"]')),
  };
};

/**
 * Start a real project so the workspace mounts, and fail loudly if it does not.
 *
 * Clicking the welcome screen's button is the actual first-run path; the store
 * action behind it is pure renderer state, so nothing needs to be stubbed.
 * On failure the page text is reported, because "did not mount" without the
 * rendered content is indistinguishable from a React crash.
 */
async function startProject(win) {
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('[data-new-project]');
      if (!button) return false;
      button.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error('welcome screen had no new-project button');

  const mounted = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        if (document.querySelector('[aria-label="Playback speed"]')) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    })
  `);
  if (!mounted) {
    const diagnostics = await win.webContents.executeJavaScript(`
      JSON.stringify({
        elements: document.querySelectorAll('body *').length,
        text: document.body.innerText.slice(0, 300),
        hasWelcomeButton: Boolean(document.querySelector('[data-new-project]')),
      })
    `);
    throw new Error(`workspace did not mount after starting a project: ${diagnostics}`);
  }
}

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

/** Wait for React to mount, start a project, and let the workspace settle. */
async function prepareWorkspace(win) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await startProject(win);
  await new Promise((resolve) => setTimeout(resolve, 500));
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

    // Surface renderer errors instead of letting a crashed workspace read as a
    // clean zero-offender run.
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) console.log(`[renderer] ${message}`);
    });

    const results = [];

    // State 1: every panel in its own region.
    await prepareWorkspace(win);
    for (const size of sizes) {
      results.push({ ...(await measureAt(win, size)), panelState: 'default' });
    }

    // State 2: tabbed regions, persisted the way the store persists them.
    await win.webContents.executeJavaScript(
      `localStorage.setItem('palmier.layout.panelGroups', ${JSON.stringify(GROUPED_PANELS)})`,
    );
    await win.webContents.reload();
    await prepareWorkspace(win);
    for (const size of sizes) {
      results.push({ ...(await measureAt(win, size)), panelState: 'tabs' });
    }

    // A grouped workspace must actually have rendered a tab strip.
    const tablists = await win.webContents.executeJavaScript(
      `document.querySelectorAll('[role="tablist"]').length`,
    );
    if (!Number.isInteger(tablists) || tablists < 2) {
      throw new Error(`grouped workspace rendered ${tablists} tablist(s), expected at least 2`);
    }

    console.log(`REPORT:${JSON.stringify(results)}`);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error('[ui-probe-main]', error);
    app.exit(1);
  }
});
