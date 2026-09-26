import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaProbeResult } from '../../main/ipc/media';
import { createEmptyProject } from '../../shared/types/project';
import { useTimelineStore } from './timeline';

describe('timeline media import', () => {
  beforeEach(() => {
    useTimelineStore.getState().controller.loadProject(createEmptyProject());
  });

  it('continues converting ordinary probe seconds into project frames', () => {
    const project = createEmptyProject('24 fps import');
    project.settings.fps = 24;
    useTimelineStore.getState().controller.loadProject(project);

    const [assetId] = useTimelineStore.getState().importAssets([{
      path: 'C:/media/ordinary.mp4',
      filename: 'ordinary.mp4',
      type: 'video',
      duration: 5,
      fileSize: 1,
    } satisfies MediaProbeResult]);

    expect(useTimelineStore.getState().project.media.find(
      (asset) => asset.id === assetId,
    )?.duration).toBe(120);
  });
});
