// 营业日结算口径：展示层「今日」对应真实日期的前一天（可配置 offset）

// 取本地时区下的 YYYY-MM-DD 日期字符串（不依赖 UTC）
export function toLocalDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function applyDayOffset(isoDate: string, offsetDays: number): string {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + offsetDays);
  return toLocalDateStr(d);
}

const CN_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// 兼容英文短日期如 "Sun Aug 23" / "Tue Aug 18 2026 08:00:00 GMT+0800"
function parseEnglishDate(s: string): Date | null {
  const m = /([a-z]{3})\s+(\d{1,2})(?:\s+\d{4})?/i.exec(s);
  if (!m) return null;
  const mon = MONTH_MAP[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(m[2]);
  const year = new Date().getFullYear();
  const d = new Date(year, mon, day);
  return isNaN(d.getTime()) ? null : d;
}

// 押金流水等场景：把 YYYY-MM-DD / Date.toDateString() 显示成「8月18日 周二」
export function formatChineseDate(isoDate: string): string {
  if (!isoDate) return '';
  // 先尝试标准解析（含 T 的 ISO 或 YYYY-MM-DD）
  let d = new Date(isoDate.includes('T') ? isoDate : isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) {
    d = new Date(isoDate);
  }
  // 再尝试英文短日期兜底（如旧版脏数据里的 "Sun Aug 23"）
  if (isNaN(d.getTime())) {
    const ed = parseEnglishDate(isoDate);
    if (ed) d = ed;
  }
  if (isNaN(d.getTime())) return isoDate;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${CN_WEEK[d.getDay()]}`;
}

export function formatDayLabel(
  isoDate: string,
  offsetDays: number,
  options?: { withRealDate?: boolean }
): string {
  const displayDate = applyDayOffset(isoDate, offsetDays);
  const today = toLocalDateStr(new Date());

  let label: string;
  if (displayDate === today) {
    label = '今日';
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (displayDate === toLocalDateStr(yesterday)) {
      label = '昨日';
    } else {
      label = displayDate;
    }
  }

  if (options?.withRealDate) {
    return `${label} ${isoDate}`;
  }
  return label;
}
