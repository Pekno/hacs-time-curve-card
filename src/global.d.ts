/** Injected at build time by Vite `define` (see vite.config.ts / vitest.config.ts). */
declare const __CARD_VERSION__: string;

interface Window {
  customCards?: {
    type: string;
    name: string;
    description?: string;
    preview?: boolean;
    documentationURL?: string;
  }[];
}
