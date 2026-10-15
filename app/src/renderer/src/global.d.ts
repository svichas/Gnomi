/// <reference types="vite/client" />

// What preload/index.ts exposes; a key goes in and never comes back out.
type KeyedProvider = Exclude<import('@gnomi/engine/types.ts').ProviderId, 'openai_compatible'>; // the local endpoint needs no key

interface Window {
  gnomi: {
    /** `remembered` is false when this computer has no secure key storage: the key then lasts for this session only. */
    saveKey(provider: KeyedProvider, key: string): Promise<{ remembered: boolean }>;
    hasKey(provider: KeyedProvider): Promise<boolean>;
    clearKey(provider: KeyedProvider): Promise<void>;
    listProjects(): Promise<import('../../projects.ts').ProjectCatalog>;
    projectAction(action: import('../../projects.ts').ProjectAction): Promise<import('../../projects.ts').ProjectActionResult>;
  };
}
