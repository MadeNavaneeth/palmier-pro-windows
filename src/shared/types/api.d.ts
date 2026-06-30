/**
 * Global type augmentation so the renderer can access window.palmier
 * with full type safety. Import PalmierAPI from the preload module.
 */

import type { PalmierAPI } from '../../preload/index';

declare global {
  interface Window {
    palmier: PalmierAPI;
  }
}

export {};
