import { toLocalDateString, todayLocal, formatDateLabel, formatDateTimeCN } from "../utils/date";

describe("utils/date 本地时区工具", () => {
  it("toLocalDateString 凌晨边界使用本地日期而非 UTC 前一天", () => {
    expect(toLocalDateString(new Date(2026, 7, 6, 0, 30))).toBe("2026-08-06");
  });

  it("toLocalDateString 对给定本地日期串一致", () => {
    expect(toLocalDateString(new Date(2026, 0, 3, 23, 59))).toBe("2026-01-03");
  });

  it("todayLocal 返回 YYYY-MM-DD 格式", () => {
    expect(todayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("todayLocal 与 toLocalDateString(new Date()) 一致", () => {
    expect(todayLocal()).toBe(toLocalDateString(new Date()));
  });

  it("formatDateLabel 对本地今天的日期串返回「今天」", () => {
    const today = todayLocal();
    expect(formatDateLabel(today)).toBe("今天");
  });

  it("formatDateLabel 对本地昨天返回「昨天」", () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterday = toLocalDateString(d);
    expect(formatDateLabel(yesterday)).toBe("昨天");
  });

  it("formatDateLabel 同年日期返回 MM月DD日", () => {
    const year = new Date().getFullYear();
    expect(formatDateLabel(`${year}-01-01`)).toBe("1月1日");
  });

  it("formatDateLabel 跨年日期返回 YYYY年MM月DD日", () => {
    const otherYear = new Date().getFullYear() - 1;
    expect(formatDateLabel(`${otherYear}-12-31`)).toBe(`${otherYear}年12月31日`);
  });

  it("formatDateTimeCN 返回本地 YYYY-MM-DD HH:mm 补零格式", () => {
    expect(formatDateTimeCN(new Date(2026, 7, 6, 9, 5))).toBe("2026-08-06 09:05");
  });

  it("时区回归：固定本地凌晨时间不会因 UTC 解析错位", () => {
    const local = new Date(2026, 7, 6, 0, 30);
    const utcSlice = local.toISOString().split("T")[0];
    expect(toLocalDateString(local)).toBe("2026-08-06");
    expect(toLocalDateString(local)).not.toBe(utcSlice);
  });
});
