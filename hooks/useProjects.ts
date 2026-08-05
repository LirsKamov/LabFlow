import { useState, useCallback } from "react";
import { Alert } from "react-native";
import { getDb, withTransaction } from "../db/database";
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
      const db = await getDb();
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
    } finally {
      setLoading(false);
    }
  }, []);

  /** 创建项目 */
  const createProject = useCallback(
    async (name: string, description: string): Promise<number> => {
      try {
        const db = await getDb();
        const result = await db.runAsync(
          "INSERT INTO projects (name, description, status) VALUES (?, ?, 'active')",
          [name.trim(), description.trim()]
        );
        await loadProjects();
        return result.lastInsertRowId;
      } catch (error) {
        console.error("[useProjects] 创建项目失败:", error);
        throw error;
      }
    },
    [loadProjects]
  );

  /** 更新项目 */
  const updateProject = useCallback(
    async (id: number, data: { name: string; description: string }): Promise<void> => {
      try {
        const db = await getDb();
        await db.runAsync(
          `UPDATE projects
           SET name = ?, description = ?, updated_at = datetime('now','localtime')
           WHERE id = ?`,
          [data.name.trim(), data.description.trim(), id]
        );
        await loadProjects();
      } catch (error) {
        console.error("[useProjects] 更新项目失败:", error);
        throw error;
      }
    },
    [loadProjects]
  );

  /** 删除项目（事务：先删关联待办，再将实验/样品 project_id 置 NULL，最后删项目） */
  const deleteProject = useCallback(
    async (id: number): Promise<void> => {
      try {
        await withTransaction(async (db) => {
          // 1. 级联删除该项目下的所有待办（外键约束在 FK OFF 时不会自动处理）
          await db.runAsync("DELETE FROM todos WHERE project_id = ?", [id]);
          // 2. 关联实验与样品解除关联
          await db.runAsync(
            "UPDATE experiments SET project_id = NULL WHERE project_id = ?",
            [id]
          );
          await db.runAsync(
            "UPDATE samples SET project_id = NULL WHERE project_id = ?",
            [id]
          );
          // 3. 删除项目本身
          await db.runAsync("DELETE FROM projects WHERE id = ?", [id]);
        });
        await loadProjects();
      } catch (error) {
        console.error("[useProjects] 删除项目失败:", error);
        throw error;
      }
    },
    [loadProjects]
  );

  /** 切换项目状态 */
  const updateStatus = useCallback(
    async (id: number, status: Project["status"]): Promise<void> => {
      try {
        const db = await getDb();
        await db.runAsync(
          "UPDATE projects SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
          [status, id]
        );
        await loadProjects();
      } catch (error) {
        console.error("[useProjects] 切换状态失败:", error);
        Alert.alert("操作失败", "切换项目状态失败，请重试");
      }
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
