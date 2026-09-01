export type TabKey = 'home' | 'business' | 'barrel' | 'goods' | 'mine';

export interface SyncState {
  pendingCount: number;
  lanOn: boolean;
  syncing: boolean;
  syncMsg: string;
  live?: boolean; // #10 SSE 实时通道是否已连上
}
