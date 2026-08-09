// 日期选择字段（零新增依赖，纯 RN 自绘月历）
//
// 背景 / 根因：
//   进货录入里的「下单日期 / 进货日期 / 送货日期」原本是裸 <TextInput>，
//   只能手打 "YYYY-MM-DD"，点了只会弹键盘，不会出日期选择器。
//   项目未安装 @react-native-community/datetimepicker，也不为此加依赖，
//   所以用 RN 原生 Modal + 自绘月历实现，交互对齐原生 picker。
//
// 实现约束：
//   · 触发器用 Pressable 包 View，**不用 TextInput + editable={false}** ——
//     Android 上 editable={false} 会把文字强制渲染成灰色，且仍可能抢焦点。
//   · 选中态用 primaryVivid 实心，**不用 primary(#C2470A)**：
//     theme 硬约束 R2「主橙实心按钮每屏 ≤1」，那个配额留给录单页的主 CTA。
//   · Modal 走独立 native window，拿不到父级 safe area，底部自己补 BOTTOM_INSET。
//
// 用法：
//   <DatePickerField value={date} onChange={setDate} />                    // 必填
//   <DatePickerField value={arrivalDate} onChange={setArrivalDate} allowEmpty />  // 可空
import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';
import { toLocalDateStr } from '../utils/dateLabel';
import { BOTTOM_INSET } from './SafeArea';

const WEEK_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/** 唯一新增色值：禁用/占位文字（theme 无等价 token，textAppTertiary 0.55 在此处偏亮） */
const TEXT_DISABLED = 'rgba(255,255,255,0.28)';

/** 解析 YYYY-MM-DD；非法/空串返回 null（不抛错，避免脏数据把表单打崩） */
function parseISO(v: string | undefined | null): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  // 反查一次，挡掉 2026-02-31 这类"格式对但日期不存在"的输入
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt;
}

/** 生成某月的 6×7 网格（含前后补白，null = 非本月） */
function buildMonthGrid(year: number, month: number): (number | null)[] {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 允许清空（送货日期这类可空字段），弹层里出现「清除」入口 */
  allowEmpty?: boolean;
  /** 弹层标题 */
  title?: string;
  disabled?: boolean;
}

export default function DatePickerField({
  value,
  onChange,
  placeholder = 'YYYY-MM-DD',
  allowEmpty = false,
  title = '选择日期',
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false);
  // 弹层内正在浏览的年月（不等于已选值，用户可以翻月而不选）
  const [cursor, setCursor] = useState(() => parseISO(value) ?? new Date());

  const today = useMemo(() => toLocalDateStr(new Date()), []);
  const selected = value?.trim() || '';

  const openPicker = () => {
    if (disabled) return;
    // 每次打开都对齐到当前值所在月份，避免上次翻月的残留
    setCursor(parseISO(value) ?? new Date());
    setOpen(true);
  };

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const grid = useMemo(() => buildMonthGrid(year, month), [year, month]);

  const shiftMonth = (delta: number) => setCursor(new Date(year, month + delta, 1));
  const shiftYear = (delta: number) => setCursor(new Date(year + delta, month, 1));

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        style={({ pressed }) => [
          styles.field,
          disabled && styles.fieldDisabled,
          pressed && !disabled && styles.fieldPressed,
        ]}
        onPress={openPicker}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${title}${selected ? `，当前 ${selected}` : '，未选择'}`}
      >
        <Text
          style={[
            styles.fieldText,
            !selected && styles.fieldPlaceholder,
            disabled && styles.fieldTextDisabled,
          ]}
          numberOfLines={1}
        >
          {selected || placeholder}
        </Text>
        <Text style={styles.fieldIcon}>📅</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        {/* 点遮罩关闭；面板从底部升起 */}
        <Pressable style={styles.scrim} onPress={() => setOpen(false)}>
          {/* 吃掉冒泡：点面板内部不关闭 */}
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.grabber} />
            <Text style={styles.panelTitle}>{title}</Text>

            <View style={styles.navRow}>
              <Pressable style={styles.navBtn} onPress={() => shiftYear(-1)} hitSlop={8}>
                <Text style={styles.navText}>«</Text>
              </Pressable>
              <Pressable style={styles.navBtn} onPress={() => shiftMonth(-1)} hitSlop={8}>
                <Text style={styles.navText}>‹</Text>
              </Pressable>
              <Text style={styles.navLabel}>
                {year} 年 {month + 1} 月
              </Text>
              <Pressable style={styles.navBtn} onPress={() => shiftMonth(1)} hitSlop={8}>
                <Text style={styles.navText}>›</Text>
              </Pressable>
              <Pressable style={styles.navBtn} onPress={() => shiftYear(1)} hitSlop={8}>
                <Text style={styles.navText}>»</Text>
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {WEEK_LABELS.map((w) => (
                <Text key={w} style={styles.weekCell}>
                  {w}
                </Text>
              ))}
            </View>

            <View style={styles.grid}>
              {grid.map((day, i) => {
                if (day === null) return <View key={`b${i}`} style={styles.dayCell} />;
                const iso = toLocalDateStr(new Date(year, month, day));
                const isSelected = iso === selected;
                const isToday = iso === today;
                return (
                  <Pressable
                    key={iso}
                    style={({ pressed }) => [
                      styles.dayCell,
                      isToday && !isSelected && styles.dayToday,
                      isSelected && styles.daySelected,
                      pressed && !isSelected && styles.dayPressed,
                    ]}
                    onPress={() => commit(iso)}
                    accessibilityRole="button"
                    accessibilityLabel={iso}
                  >
                    <Text style={[styles.dayText, isSelected && styles.dayTextSelected]}>{day}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.actions}>
              <Pressable style={styles.actionBtn} onPress={() => setOpen(false)} hitSlop={8}>
                <Text style={styles.actionText}>取消</Text>
              </Pressable>
              {allowEmpty && (
                <Pressable style={styles.actionBtn} onPress={() => commit('')} hitSlop={8}>
                  <Text style={styles.actionText}>清除</Text>
                </Pressable>
              )}
              <Pressable style={styles.actionBtn} onPress={() => commit(today)} hitSlop={8}>
                <Text style={[styles.actionText, styles.actionPrimary]}>今天</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const S = theme.size;
const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: S.controlLg,
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space(1.5),
    paddingVertical: theme.space(1),
  },
  fieldPressed: { borderColor: theme.color.primaryVivid },
  fieldDisabled: { opacity: 0.6 },
  fieldText: { flex: 1, fontSize: theme.font.size.md, color: theme.color.text },
  fieldPlaceholder: { color: theme.color.textMuted },
  fieldTextDisabled: { color: TEXT_DISABLED },
  fieldIcon: { fontSize: theme.font.size.md, marginLeft: theme.space(1) },

  // 底部升起的面板
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: theme.color.surfaceApp,
    borderTopLeftRadius: theme.radius.xxl,
    borderTopRightRadius: theme.radius.xxl,
    borderTopWidth: 1,
    borderColor: theme.color.borderApp,
    paddingHorizontal: theme.spaceScale[4],
    paddingTop: theme.spaceScale[2],
    // Modal 是独立 native window，拿不到父级 safe area，底部自己补 Home Indicator
    paddingBottom: theme.spaceScale[4] + BOTTOM_INSET,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.color.borderApp,
    marginBottom: theme.spaceScale[3],
  },
  panelTitle: {
    fontSize: theme.font.sizeV4.h4,
    fontWeight: theme.font.weight.semibold,
    color: theme.color.textApp,
    marginBottom: theme.spaceScale[3],
    textAlign: 'center',
  },

  navRow: { flexDirection: 'row', alignItems: 'center', marginBottom: theme.spaceScale[2] },
  navBtn: { width: S.tapMin, height: S.tapMin, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 20, color: theme.color.primaryVivid },
  navLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: theme.font.sizeV4.body,
    color: theme.color.textApp,
    fontWeight: theme.font.weight.medium,
  },

  weekRow: { flexDirection: 'row', marginBottom: 4 },
  weekCell: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    fontSize: theme.font.sizeV4.micro,
    color: theme.color.textAppTertiary,
    paddingVertical: 4,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: `${100 / 7}%`,
    height: S.tapMin,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.sm,
  },
  dayToday: { borderWidth: 1, borderColor: theme.color.primaryVivid },
  // R2 约束：主橙实心配额留给录单主 CTA，这里用 primaryVivid
  daySelected: { backgroundColor: theme.color.primaryVivid },
  dayPressed: { backgroundColor: theme.color.navHoverBg },
  dayText: { fontSize: theme.font.sizeV4.bodySm, color: theme.color.textApp },
  dayTextSelected: { color: theme.color.ctaText, fontWeight: theme.font.weight.semibold },

  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: theme.spaceScale[3],
    borderTopWidth: 1,
    borderTopColor: theme.color.dividerApp,
    paddingTop: theme.spaceScale[2],
  },
  actionBtn: {
    minHeight: S.tapMin,
    minWidth: 56,
    paddingHorizontal: theme.spaceScale[4],
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { fontSize: theme.font.sizeV4.body, color: theme.color.textAppSecondary },
  actionPrimary: { color: theme.color.primaryVivid, fontWeight: theme.font.weight.semibold },
});
