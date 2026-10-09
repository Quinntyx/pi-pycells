export interface PtcSettings {
  /** Idle/silence timeout per cell (re-arms on activity), in ms. */
  executionTimeoutMs: number;
  /** Maximum text returned directly to the model before head/tail collapsing. */
  outputPreviewChars: number;
  /** Emergency per-cell capture ceiling; output below this is always persisted in full. */
  maxSpoolChars: number;
  debugLogging: boolean;
  autoRecover?: boolean;
  autoRecoverMaxAttempts?: number;
  maxPythonSessions: number;
  scriptsDir?: string;
  /** Reusable notebook library; env fallback is PTC_LIBRARY_DIR. */
  libraryDir?: string;
  /** Whether the subagent status footer is shown in exec_cell results. */
  subagentFooter: boolean;
}
