/** 底部 5 个 Tab。原 'goods'（商品）已改为 'supply'（供采），商品管理入口移至「经营」页。 */
export type TabKey = 'home' | 'business' | 'barrel' | 'supply' | 'mine';

export interface SyncState {
  pendingCount: number;
  lanOn: boolean;
  syncing: boolean;
  syncMsg: string;
  live?: boolean; // #10 SSE 实时通道是否已连上
}
