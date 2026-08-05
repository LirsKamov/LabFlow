/**
 * 本地时区日期工具模块。
 *
 * 背景：项目原有 16 处 toISOString().split("T")[0] 取的是 UTC 日期，
 * 在东八区（UTC+8）凌晨 0:00-7:59 之间会把日期算成前一天，导致记录
 * 归属错误的日期。
 *
 * 解决方案：本模块所有函数一律基于本地时区（getFullYear/getMonth+1/
 * getDate）拼装日期串，禁止使用 toISOString 取日期。
 *
 * 所有调用方（日记、记录、统计等 16 处）后续统一改用本模块。
 */

/** 把 Date 转成本地时区 "YYYY-MM-DD" 日期串（必须逐字段拼装，绝不能用 toISOString） */
export function toLocalDateString(d?: Date): string {
  const date = d ?? new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 返回今天（本地时区）的 "YYYY-MM-DD" 日期串 */
export function todayLocal(): string {
  return toLocalDateString(new Date());
}

/** 返回本地 "YYYY-MM-DD HH:mm" 格式（补零） */
export function formatDateTimeCN(d?: Date): string {
  const date = d ?? new Date();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${toLocalDateString(date)} ${hh}:${mm}`;
}

/**
 * 把本地语义的 "YYYY-MM-DD" 日期串转为显示标签：
 * - 与本地今天相同 → "今天"
 * - 与本地昨天相同 → "昨天"
 * - 与今天同年     → "MM月DD日"
 * - 跨年（与今天年份不同）→ "YYYY年MM月DD日"
 *
 * "YYYY-MM-DD" 字符串直接与本地日期串做字符串比较，避免 new Date("YYYY-MM-DD")
 * 按 UTC 解析带来的时区陷阱。
 */
export function formatDateLabel(dateStr: string): string {
  const today = todayLocal();
  if (dateStr === today) {
    return "今天";
  }

  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = toLocalDateString(yesterdayDate);
  if (dateStr === yesterday) {
    return "昨天";
  }

  const year = dateStr.slice(0, 4);
  const month = dateStr.slice(5, 7);
  const day = dateStr.slice(8, 10);
  if (year === today.slice(0, 4)) {
    return `${Number(month)}月${Number(day)}日`;
  }
  return `${year}年${Number(month)}月${Number(day)}日`;
}
