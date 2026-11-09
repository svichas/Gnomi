/// <reference types="vite/client" />

// What preload/index.ts exposes; a key goes in and never comes back out.
type KeyedProvider = import('../../providers.ts').KeyedProvider;
type ProviderEntry = import('../../providers.ts').ProviderEntry;

interface Window {
  gnomi: {
    /** Only the key's mask comes back. `remembered` is false when this computer has no secure key storage: the key then lasts for this session only. */
    saveKey(provider: KeyedProvider, key: string): Promise<ProviderEntry>;
    listProviders(): Promise<import('../../providers.ts').ProviderList>;
    clearKey(provider: KeyedProvider): Promise<void>;
    /** The engine's zero-cost check of a saved key, or of the project's saved local endpoint; main keeps the result. */
    testKey(provider: import('@gnomi/simulation/types.ts').ProviderId): Promise<import('../../providers.ts').KeyTest>;
    /** The Figma token goes to main and never comes back; only its mask does. Frames are then read by the engine, not the page. */
    saveFigmaToken(token: string): Promise<import('../../providers.ts').FigmaEntry>;
    clearFigmaToken(): Promise<void>;
    /** The engine asks Figma whether it accepts the saved token; main keeps the result. */
    testFigmaToken(): Promise<import('../../providers.ts').KeyTest>;
    /** Audiences saved for any project to start from, newest first. */
    listAudiences(): Promise<import('@gnomi/engine/audience/file.ts').SavedAudience[]>;
    /** Saving under a name already saved replaces that audience. */
    saveAudience(name: string, audience: import('@gnomi/simulation/types.ts').Audience, schema: import('@gnomi/simulation/types.ts').PersonaSchema): Promise<import('@gnomi/engine/audience/file.ts').SavedAudience>;
    /** The saved audiences that remain. */
    deleteAudience(id: string): Promise<import('@gnomi/engine/audience/file.ts').SavedAudience[]>;
    listProjects(): Promise<import('../../projects.ts').ProjectCatalog>;
    /** Every project's saved runs, newest first. */
    listRuns(): Promise<import('../../projects.ts').WorkspaceRun[]>;
    projectAction(action: import('../../projects.ts').ProjectAction): Promise<import('../../projects.ts').ProjectActionResult>;
    /** Shrunk evidence screenshots as data URLs, by blob path; one that cannot be read is absent. */
    reportThumbnails(paths: string[]): Promise<Record<string, string>>;
    /** Asks where to save, then writes the file (printing PDF from the HTML); the path, or null when the user canceled. */
    saveReport(format: import('../../reports.ts').ReportFormat, runId: string, content: string): Promise<string | null>;
    /** The local path of a file the user picked or dropped, for import_asset { path }. */
    pathForFile(file: File): string;
    /**
     * Where the check for a newer release on GitHub stands, starting one unless a check is running or a download waits
     * for the restart; each later step comes through onUpdate. Null in development builds, which have no releases.
     */
    checkUpdate(): Promise<import('../../main/release.ts').UpdateState | null>;
    /** Each step of a check and download as it happens; the result stops listening. */
    onUpdate(listener: (state: import('../../main/release.ts').UpdateState) => void): () => void;
    /** Quits, installs the downloaded release and opens Gnomi again. */
    installUpdate(): Promise<void>;
    /** Opens the latest release's download page in the default browser. */
    openReleases(): Promise<void>;
  };
}
