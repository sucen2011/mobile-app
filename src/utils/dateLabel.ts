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
