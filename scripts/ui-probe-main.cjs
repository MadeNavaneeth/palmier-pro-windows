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

/**
 * Every panel visible, persisted with the grouping above because a region only
 * renders a tab strip when it holds more than one VISIBLE member: App.tsx
 * computes `visible = dockedMembers(group, panels, detached)` and
 * `tabbed = visible.length > 1`, and `<PanelTabs>` is the only `role="tablist"`
 * in the app. Visibility is persisted separately from the grouping, under
 * `palmier.layout.panels` as a `PanelVisibility` record
 * (`Record<'media' | 'inspector' | 'agent' | 'export', boolean>`), and the
 * store's first-run default hides Agent and Export (ui.ts `DEFAULT_PANELS`).
 * Writing only the grouping therefore left the tablist assertion resting on
 * whatever visibility the machine happened to have persisted: with the default,
 * both grouped regions hold one visible member, no tab strip renders, and the
 * probe failed for a reason that had nothing to do with the layout it measures.
 */
const VISIBLE_PANELS = JSON.stringify({ media: true, inspector: true, agent: true, export: true });

// The renderer fires a few preboot IPC calls during mount; feature
// registration is intentionally skipped here, so answer them with no-ops to
// keep the probe output clean.
//
// `editor:sync-from-renderer` deliberately never resolves, and that is the
// point: useEditorSync clears its pending-local flag only once main accepts the
// window's own snapshot, so an answer that never comes pins the window in
// exactly the state the refused-push path needs — a local write outstanding —
// for the whole run. That is what lets the notice below be produced
// deterministically instead of raced against a 300ms debounce.
ipcMain.removeHandler('editor:sync-from-renderer');
ipcMain.handle('editor:sync-from-renderer', () => new Promise(() => {}));
ipcMain.handle('system:check-ffmpeg', () => null);

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

  // The refused-push notice, measured where it renders. Reported for every
  // state so the rows without one say so explicitly rather than omitting the
  // field, and asserted by the driver so a notice pushed off-screen, or wide
  // enough to be clipped by its column, fails instead of passing quietly.
  let noticeBox = null;
  const noticeEl = document.querySelector('[data-dropped-sync-notice]');
  if (noticeEl) {
    const r = noticeEl.getBoundingClientRect();
    const parent = noticeEl.parentElement;
    const pr = parent ? parent.getBoundingClientRect() : null;
    noticeBox = {
      text: noticeEl.textContent,
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
      // Wider than the column it sits in means the text is clipped rather than
      // wrapped, which is the one way this box could hide its own message.
      clipped: pr ? r.right > pr.right + 1 : false,
    };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
    overflowX: doc.scrollWidth - window.innerWidth,
    overflowY: doc.scrollHeight - window.innerHeight,
    offenderCount: offenders.length,
    offenders,
    noticeBox,
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

/**
 * Put a lost-agent-edit notice on screen, through the real code path.
 *
 * This is the one user-visible thing an app can do to itself without anyone
 * noticing: useEditorSync refuses an inbound push while a local write is
 * outstanding, and the notice that now says so is the only trace of the loss
 * (the agent's own transcript still reads as a success). A layout gate that
 * never renders it would leave the one line a user gets for real data loss
 * unmeasured, so it is driven end to end rather than stubbed: main sends
 * `editor:apply-from-main` in the exact shape and tag it uses for a real agent
 * turn, the window refuses it for the pending-local reason, and the notice
 * appears.
 *
 * The precondition is held open by the probe's own never-resolving
 * `editor:sync-from-renderer` handler (see the top of this file), so this is not
 * a race against a debounce and needs no clip, no gesture and no playback —
 * pressing Play here instead crashes the renderer, because the probe registers
 * no compositor and the canvas is handed a zero-size ImageData.
 *
 * The notice is REQUIRED to be found. A run that quietly failed to reach the
 * conflict path would otherwise report a clean zero offenders, which is the
 * failure mode this whole harness exists to prevent.
 */
async function showDroppedSyncNotice(win) {
  win.webContents.send(
    'editor:apply-from-main',
    JSON.stringify({
      version: 2,
      name: 'Agent state that was refused',
      settings: { width: 1920, height: 1080, fps: 30, sampleRate: 48000, backgroundColor: '#000000' },
      media: [],
      timeline: { tracks: [], clips: [], markers: [], playheadFrame: 0 },
    }),
    { source: 'main', kind: 'edit' },
  );

  const found = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + 3000;
      const tick = () => {
        const el = document.querySelector('[data-dropped-sync-notice]');
        if (el) return resolve(el.textContent);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, 50);
      };
      tick();
    })
  `);
  if (!found) {
    const diagnostics = await win.webContents.executeJavaScript(`
      JSON.stringify({
        elements: document.querySelectorAll('body *').length,
        text: document.body.innerText.slice(0, 200),
      })
    `);
    throw new Error(`a refused push did not produce a notice: ${diagnostics}`);
  }
  return found;
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

    // State 2: tabbed regions, persisted the way the store persists them --
    // the grouping AND the panel visibility, because the tab strips this state
    // exists to measure are rendered from each region's visible members.
    await win.webContents.executeJavaScript(
      `localStorage.setItem('palmier.layout.panelGroups', ${JSON.stringify(GROUPED_PANELS)});`
      + ` localStorage.setItem('palmier.layout.panels', ${JSON.stringify(VISIBLE_PANELS)})`,
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

    // State 3: a lost agent edit is on screen. Measured with the same overflow
    // gate as the two layouts, because the notice is a new line of text in a
    // column that is already tight at 1024x680 -- and the specific failure this
    // catches is a wrapped notice pushing the grid below the fold, which the
    // generic scan reports as an offender rather than as "the notice appeared".
    await showDroppedSyncNotice(win);
    for (const size of sizes) {
      results.push({ ...(await measureAt(win, size)), panelState: 'notice' });
    }
    // The notice has to be inside the viewport, unclipped, at BOTH sizes: a
    // warning about lost work that renders off-screen, or clipped by its own
    // column, is the same as no warning.
    for (const r of results.filter((row) => row.panelState === 'notice')) {
      if (!r.noticeBox) throw new Error(`the notice was gone at ${r.width}x${r.height}`);
      const b = r.noticeBox;
      if (b.right > r.width || b.bottom > r.height || b.clipped) {
        throw new Error(`the notice does not fit ${r.width}x${r.height}: ${JSON.stringify(b)}`);
      }
    }

    console.log(`REPORT:${JSON.stringify(results)}`);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error('[ui-probe-main]', error);
    app.exit(1);
  }
});
