/// <reference types="vite/client" />

// What preload/index.ts exposes; the key goes in and never comes back out.
interface Window {
  gnomi: {
    /** `remembered` is false when this computer has no secure key storage: the key then lasts for this session only. */
    saveKey(key: string): Promise<{ remembered: boolean }>;
    hasKey(): Promise<boolean>;
    clearKey(): Promise<void>;
  };
}
