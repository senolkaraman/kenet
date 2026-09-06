interface KenetScreen {
  id: string;
  label: string;
  thumbnail: string;
}

interface KenetFsEntry {
  name: string;
  isDir: boolean;
  size: number;
  modifiedAt: number | null;
}

interface KenetFsListResult {
  ok: boolean;
  entries?: KenetFsEntry[];
  error?: string;
}

interface Window {
  kenetControl: {
    send(command: unknown): void;
    requestElevation(): Promise<{ started: boolean; reason?: string }>;
    recordAudit(event: string, details: string): void;
    listAudit(): Promise<Array<{ timestamp: string; event: string; details: string }>>;
    notifyIncoming?(name: string): void;
    clearAttention?(): void;
    readClipboard?(): Promise<string>;
    writeClipboard?(text: string): Promise<void>;
    listScreens?(): Promise<KenetScreen[]>;
    setPreferredScreen?(id: string): Promise<void>;
    setFullscreen?(on: boolean): Promise<boolean>;
    minimizeWindow?(): void;
    closeWindow?(): void;
    saveIncomingFile?(name: string, data: ArrayBuffer): Promise<{ saved: boolean; path?: string }>;
    getStartupPrefs?(): Promise<{ startWithWindows: boolean; runInBackground: boolean }>;
    setStartupPrefs?(prefs: { startWithWindows?: boolean; runInBackground?: boolean }): Promise<{ ok: boolean }>;
    openExternal?(url: string): Promise<void>;
    listClipboardFiles?(): Promise<Array<{ path: string; name: string; size: number }>>;
    readClipboardFile?(filePath: string): Promise<{ name: string; data: ArrayBuffer } | null>;
    stageClipboardFile?(batch: string, name: string, data: ArrayBuffer): Promise<string | null>;
    commitClipboardFiles?(paths: string[]): Promise<boolean>;
    listDrives?(): Promise<KenetFsListResult>;
    listDir?(dirPath: string): Promise<KenetFsListResult>;
    readFileForTransfer?(filePath: string): Promise<{ ok: boolean; name?: string; data?: ArrayBuffer; error?: string }>;
    writeFileToDir?(dir: string, name: string, data: ArrayBuffer): Promise<{ ok: boolean; path?: string; error?: string }>;
    saveToDownloads?(name: string, data: ArrayBuffer): Promise<{ saved: boolean; path?: string }>;
    pickFile?(): Promise<{ ok: boolean; path?: string; name?: string }>;
    setPrivacyMode?(on: boolean): Promise<{ ok: boolean }>;
    privacyHeartbeat?(): void;
    showOverlay?(): Promise<{ ok: boolean }>;
    hideOverlay?(): Promise<{ ok: boolean }>;
    overlayDraw?(stroke: unknown): void;
    startRecording?(suggestedName: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    recordingChunk?(data: ArrayBuffer): void;
    stopRecording?(): Promise<{ ok: boolean; path?: string }>;
    revealRecording?(filePath: string): Promise<void>;
    getNetworkInfo?(): Promise<{ mac: string; subnet: string }>;
    sendWakePacket?(mac: string): Promise<{ ok: boolean }>;
  };
}
