import { useState, useCallback } from "react";
import { getDb } from "../db/database";
import { formatDateLabel } from "../utils/date";
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
  dateLabel: string; // "5月31日" / "今天" / "昨天"
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

// ─── 公共 SQL 片段 ──────────────────────────────────────────

/** 记录列表公共 SELECT（带关联名称），供 loadRecords / searchRecords 复用 */
const RECORD_SELECT_SQL = `
  SELECT
    r.*,
    e.name AS experiment_name,
    p.name AS project_name,
    p.id   AS project_id
  FROM records r
  LEFT JOIN experiments e ON r.experiment_id = e.id
  LEFT JOIN projects    p ON e.project_id    = p.id
`;

/** 转义 LIKE 通配符（配合 ESCAPE '\' 使用） */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// ─── Hook ────────────────────────────────────────────────────

export function useRecords() {
  const [records, setRecords] = useState<RecordWithMeta[]>([]);
  const [experimentOptions, setExperimentOptions] = useState<ExperimentOption[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 加载记录（带关联名称，支持分页；不传参时与旧行为等价） ──
  const loadRecords = useCallback(
    async (params?: { offset?: number; limit?: number }): Promise<void> => {
      const { offset = 0, limit = 100 } = params ?? {};
      setLoading(true);
      try {
        const db = await getDb();
        const rows = await db.getAllAsync<RecordWithMeta>(
          `${RECORD_SELECT_SQL}
           ORDER BY r.created_at DESC
           LIMIT ? OFFSET ?`,
          [limit, offset]
        );
        setRecords(rows);
      } catch (err) {
        console.error("[useRecords] 加载失败:", err);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  /** 获取记录总数（供分页/加载更多使用） */
  const getRecordCount = useCallback(async (): Promise<number> => {
    try {
      const db = await getDb();
      const row = await db.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) AS count FROM records"
      );
      return row?.count ?? 0;
    } catch (err) {
      console.error("[useRecords] 获取记录总数失败:", err);
      return 0;
    }
  }, []);

  // ── 加载实验选项列表 ──
  const loadExperimentOptions = useCallback(async () => {
    try {
      const db = await getDb();
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

  // ── 关键词搜索（LIKE 通配符已转义） ──
  const searchRecords = useCallback(async (keyword: string) => {
    if (!keyword.trim()) {
      await loadRecords();
      return;
    }
    setLoading(true);
    try {
      const db = await getDb();
      const like = `%${escapeLike(keyword.trim())}%`;
      const rows = await db.getAllAsync<RecordWithMeta>(
        `${RECORD_SELECT_SQL}
         WHERE r.title   LIKE ? ESCAPE '\\'
            OR r.content LIKE ? ESCAPE '\\'
            OR e.name    LIKE ? ESCAPE '\\'
            OR p.name    LIKE ? ESCAPE '\\'
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
      const db = await getDb();
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
      const db = await getDb();
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
    getRecordCount,
    loadExperimentOptions,
    searchRecords,
    createRecord,
    deleteRecord,
    getDateGroups,
    getProjectGroups,
  };
}
