import { describe, expect, it, vi } from 'vitest';

const dispatchShortcut = vi.hoisted(() => vi.fn());

vi.mock('../lib/shortcut-dispatcher', () => ({ dispatchShortcut }));
vi.mock('../store/project', () => ({
  useProjectStore: () => ({
    name: 'Test project',
    hasUnsavedChanges: true,
    isLoaded: true,
  }),
}));

const { TitleBar } = await import('./TitleBar');

type ElementNode = {
  props?: Record<string, unknown>;
};

function findByAriaLabel(value: unknown, label: string): ElementNode | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findByAriaLabel(child, label);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const node = value as ElementNode;
  if (node.props?.['aria-label'] === label) return node;
  return findByAriaLabel(node.props?.children, label);
}

describe('TitleBar save action', () => {
  it('routes the visible Save button through the shared saveProject dispatcher', () => {
    dispatchShortcut.mockClear();

    const saveButton = findByAriaLabel(TitleBar({}), 'Save project');
    expect(saveButton).not.toBeNull();
    (saveButton!.props!.onClick as () => void)();

    expect(dispatchShortcut).toHaveBeenCalledWith('saveProject');
  });
});
