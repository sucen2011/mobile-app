export type TabKey = 'overview' | 'entry' | 'records' | 'report' | 'settings';

export interface SyncState {
  pendingCount: number;
  lanOn: boolean;
  syncing: boolean;
  syncMsg: string;
  live?: boolean; // #10 SSE 实时通道是否已连上
}
