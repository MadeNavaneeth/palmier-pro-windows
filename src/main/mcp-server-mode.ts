/**
 * Windowless MCP server mode (`--mcp-server`).
 *
 * Runs the Electron main process with no window and hosts the loopback HTTP
 * MCP endpoint, so CI and batch harnesses can drive the editor without a
 * desktop session: spawn the executable with `--mcp-server`, read the
 * `[mcp] {…}` JSON line from stderr for the URL/token, then call the same
 * tools the GUI agent uses (open_project → edits → export_project →
 * save_project).
 *
 * stdio is deliberately not used: Electron on Windows closes a spawned
 * process's stdin immediately, which is why the transport is HTTP.
 */

import { app } from 'electron';
import { EditorController } from '../shared/editor/controller';
import {
  startStandaloneMcpHttp,
  stopStandaloneMcpHttp,
} from './ai/mcp-http-settings';

export async function startMcpServerMode(): Promise<void> {
  const controller = new EditorController();

  // Builtin generation providers + persisted keys, so generate_media works
  // without the GUI. Registering renderer IPC handlers is harmless here.
  const { registerGenerationHandlers } = await import('./generation');
  registerGenerationHandlers();

  const status = await startStandaloneMcpHttp(controller, {
    getTranscriptionRuntime: async () => {
      const { getOpenAiCompatibleRuntime } = await import('./ai/ipc');
      return getOpenAiCompatibleRuntime();
    },
    getVisionRuntime: async () => {
      const { getVisionRuntime } = await import('./ai/ipc-vision');
      return getVisionRuntime();
    },
  });

  if (!status.running) {
    console.error('[mcp] Could not start the loopback endpoint.');
    app.exit(1);
    return;
  }

  // One machine-readable line on stderr: stdout stays clean for whatever the
  // host process wants to do with it, and the token never lands in logs the
  // user did not ask for.
  process.stderr.write(
    `[mcp] ${JSON.stringify({ url: status.url, config: status.config ? JSON.parse(status.config) : null })}\n`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Close the listener before quitting so teardown never races an open
    // socket (a harness may still hold a keep-alive connection).
    void stopStandaloneMcpHttp().finally(() => app.quit());
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
