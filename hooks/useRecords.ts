import { useState, useCallback } from "react";
import * as SQLite from "expo-sqlite";
import type { Record as DBRecord } from "../db/schema";

// ─── 扩展类型 ────────────────────────────────────────────────

/** 带关联信息的记录 */
export interface RecordWithMeta extends DBRecord {
  experiment_name: string | null;
  project_name: string | null;
  project_id: number | null;
}

/** 按日期分组 */
export interface DateGroup {
  date: string; // "2026-05-31"
  dateLabel: string; // "5月31日 周二"
  records: RecordWithMeta[];
}

/** 按项目分组 */
export interface ProjectGroup {
  project_id: number | null;
  project_name: string;
  records: RecordWithMeta[];
}

/** 实验选项（用于新建记录时选择） */
export interface ExperimentOption {
  id: number;
  name: string;
  project_name: string | null;
}

// ─── Hook ────────────────────────────────────────────────────

export function useRecords() {
  const [records, setRecords] = useState<RecordWithMeta[]>([]);
  const [experimentOptions, setExperimentOptions] = useState<ExperimentOption[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 加载所有记录（带关联名称） ──
  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const rows = await db.getAllAsync<RecordWithMeta>(
        `SELECT
          r.*,
          e.name AS experiment_name,
          p.name AS project_name,
          p.id   AS project_id
        FROM records r
        LEFT JOIN experiments e ON r.experiment_id = e.id
        LEFT JOIN projects    p ON e.project_id    = p.id
        ORDER BY r.created_at DESC
        LIMIT 100`
      );
      setRecords(rows);
    } catch (err) {
      console.error("[useRecords] 加载失败:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── 加载实验选项列表 ──
  const loadExperimentOptions = useCallback(async () => {
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const rows = await db.getAllAsync<ExperimentOption>(
        `SELECT
          e.id,
          e.name,
          p.name AS project_name
        FROM experiments e
        LEFT JOIN projects p ON e.project_id = p.id
        ORDER BY e.scheduled_date DESC
        LIMIT 50`
      );
      setExperimentOptions(rows);
    } catch (err) {
      console.error("[useRecords] 加载实验选项失败:", err);
    }
  }, []);

  // ── 关键词搜索 ──
  const searchRecords = useCallback(async (keyword: string) => {
    if (!keyword.trim()) {
      await loadRecords();
      return;
    }
    setLoading(true);
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const like = `%${keyword.trim()}%`;
      const rows = await db.getAllAsync<RecordWithMeta>(
        `SELECT
          r.*,
          e.name AS experiment_name,
          p.name AS project_name,
          p.id   AS project_id
        FROM records r
        LEFT JOIN experiments e ON r.experiment_id = e.id
        LEFT JOIN projects    p ON e.project_id    = p.id
        WHERE r.title   LIKE ?
           OR r.content LIKE ?
           OR e.name    LIKE ?
           OR p.name    LIKE ?
        ORDER BY r.created_at DESC
        LIMIT 100`,
        [like, like, like, like]
      );
      setRecords(rows);
    } catch (err) {
      console.error("[useRecords] 搜索失败:", err);
    } finally {
      setLoading(false);
    }
  }, [loadRecords]);

  // ── 创建记录 ──
  const createRecord = useCallback(
    async (
      experimentId: number | null,
      title: string,
      content: string,
      imagesJson: string = "[]"
    ): Promise<number> => {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const result = await db.runAsync(
        `INSERT INTO records (experiment_id, title, content, images_json)
         VALUES (?, ?, ?, ?)`,
        [experimentId, title.trim() || "无标题", content.trim(), imagesJson]
      );
      await loadRecords();
      return result.lastInsertRowId;
    },
    [loadRecords]
  );

  // ── 删除记录 ──
  const deleteRecord = useCallback(
    async (id: number): Promise<void> => {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      await db.runAsync("DELETE FROM records WHERE id = ?", [id]);
      await loadRecords();
    },
    [loadRecords]
  );

  // ── 按日期分组（时间线视图） ──
  const getDateGroups = useCallback((): DateGroup[] => {
    const groups: Record<string, RecordWithMeta[]> = {};
    for (const rec of records) {
      const dateKey = rec.created_at?.split(" ")[0] ?? "未知日期";
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(rec);
    }
    return Object.entries(groups).map(([date, recs]) => ({
      date,
      dateLabel: formatDateLabel(date),
      records: recs,
    }));
  }, [records]);

  // ── 按项目分组 ──
  const getProjectGroups = useCallback((): ProjectGroup[] => {
    const groups: Record<string, RecordWithMeta[]> = {
      __unassigned__: [],
    };
    for (const rec of records) {
      const key = rec.project_name ?? "__unassigned__";
      if (!groups[key]) groups[key] = [];
      groups[key].push(rec);
    }
    return Object.entries(groups)
      .filter(([, recs]) => recs.length > 0)
      .map(([name, recs]) => ({
        project_id: recs[0]?.project_id ?? null,
        project_name: name === "__unassigned__" ? "独立记录" : name,
        records: recs,
      }));
  }, [records]);

  return {
    records,
    experimentOptions,
    loading,
    loadRecords,
    loadExperimentOptions,
    searchRecords,
    createRecord,
    deleteRecord,
    getDateGroups,
    getProjectGroups,
  };
}

// ─── 工具函数 ────────────────────────────────────────────────

/** 格式化日期为中文标签 */
function formatDateLabel(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const wd = weekdays[d.getDay()];

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    if (dateStr === todayStr) return "今天";
    if (dateStr === yesterdayStr) return "昨天";
    return `${month}月${day}日 ${wd}`;
  } catch {
    return dateStr;
  }
}
