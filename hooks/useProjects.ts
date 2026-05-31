import { useState, useCallback } from "react";
import * as SQLite from "expo-sqlite";
import type { Project } from "../db/schema";

// ─── 扩展类型：项目 + 统计 ──────────────────────────────────

export interface ProjectWithStats extends Project {
  experiment_count: number;
  todo_count: number;
  todo_done_count: number;
}

// ─── Hook ────────────────────────────────────────────────────

export function useProjects() {
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(false);

  /** 加载所有项目及其统计数据 */
  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const rows = await db.getAllAsync<ProjectWithStats>(
        `SELECT
          p.*,
          COALESCE((SELECT COUNT(*) FROM experiments e WHERE e.project_id = p.id), 0) AS experiment_count,
          COALESCE((SELECT COUNT(*) FROM todos      t WHERE t.project_id = p.id), 0) AS todo_count,
          COALESCE((SELECT COUNT(*) FROM todos      t WHERE t.project_id = p.id AND t.done = 1), 0) AS todo_done_count
        FROM projects p
        ORDER BY
          CASE p.status
            WHEN 'active'    THEN 0
            WHEN 'paused'    THEN 1
            WHEN 'completed' THEN 2
            WHEN 'archived'  THEN 3
          END,
          p.created_at DESC`
      );
      setProjects(rows);
    } catch (error) {
      console.error("[useProjects] 加载失败:", error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  /** 创建项目 */
  const createProject = useCallback(
    async (name: string, description: string): Promise<number> => {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const result = await db.runAsync(
        "INSERT INTO projects (name, description, status) VALUES (?, ?, 'active')",
        [name.trim(), description.trim()]
      );
      await loadProjects();
      return result.lastInsertRowId;
    },
    [loadProjects]
  );

  /** 更新项目 */
  const updateProject = useCallback(
    async (id: number, data: { name: string; description: string }): Promise<void> => {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      await db.runAsync(
        `UPDATE projects
         SET name = ?, description = ?, updated_at = datetime('now','localtime')
         WHERE id = ?`,
        [data.name.trim(), data.description.trim(), id]
      );
      await loadProjects();
    },
    [loadProjects]
  );

  /** 删除项目（级联：其下实验的 project_id 置 NULL，todo 外键约束） */
  const deleteProject = useCallback(
    async (id: number): Promise<void> => {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      // 先将关联实验的 project_id 置 NULL
      await db.runAsync("UPDATE experiments SET project_id = NULL WHERE project_id = ?", [id]);
      await db.runAsync("DELETE FROM projects WHERE id = ?", [id]);
      await loadProjects();
    },
    [loadProjects]
  );

  /** 切换项目状态 */
  const updateStatus = useCallback(
    async (id: number, status: Project["status"]): Promise<void> => {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      await db.runAsync(
        "UPDATE projects SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
        [status, id]
      );
      await loadProjects();
    },
    [loadProjects]
  );

  return {
    projects,
    loading,
    loadProjects,
    createProject,
    updateProject,
    deleteProject,
    updateStatus,
  };
}
