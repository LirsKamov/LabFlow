import { useState, useCallback } from "react";
import { getDb } from "../db/database";
import { formatDateTimeCN } from "../utils/date";
import type { Todo } from "../db/schema";

// ─── Hook ────────────────────────────────────────────────────

export function useTodos(projectId: number | null) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(false);

  /** 加载指定项目下的所有待办 */
  const loadTodos = useCallback(async () => {
    if (projectId === null) {
      setTodos([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<Todo>(
        `SELECT * FROM todos
         WHERE project_id = ?
         ORDER BY done ASC,
           CASE priority
             WHEN 'urgent' THEN 0
             WHEN 'high'   THEN 1
             WHEN 'medium' THEN 2
             WHEN 'low'    THEN 3
           END ASC,
           due_date ASC NULLS LAST`,
        [projectId]
      );
      setTodos(rows);
    } catch (error) {
      console.error("[useTodos] 加载失败:", error);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  /** 添加待办 */
  const addTodo = useCallback(
    async (
      title: string,
      priority: Todo["priority"] = "medium",
      dueDate: string | null = null
    ): Promise<number> => {
      if (projectId === null) throw new Error("未指定项目");
      const trimmed = title.trim();
      if (!trimmed) throw new Error("请输入待办内容");
      try {
        const db = await getDb();
        const result = await db.runAsync(
          "INSERT INTO todos (project_id, title, priority, due_date, done) VALUES (?, ?, ?, ?, 0)",
          [projectId, trimmed, priority, dueDate]
        );
        await loadTodos();
        return result.lastInsertRowId;
      } catch (error) {
        console.error("[useTodos] 添加待办失败:", error);
        throw error;
      }
    },
    [projectId, loadTodos]
  );

  /** 切换完成状态 */
  const toggleTodo = useCallback(
    async (id: number, currentDone: 0 | 1): Promise<void> => {
      const newDone = currentDone === 1 ? 0 : 1;
      try {
        const db = await getDb();
        await db.runAsync(
          "UPDATE todos SET done = ?, completed_at = ? WHERE id = ?",
          [newDone, newDone === 1 ? formatDateTimeCN(new Date()) : null, id]
        );
        await loadTodos();
      } catch (error) {
        console.error("[useTodos] 切换待办状态失败:", error);
        throw error;
      }
    },
    [loadTodos]
  );

  /** 删除待办 */
  const deleteTodo = useCallback(
    async (id: number): Promise<void> => {
      try {
        const db = await getDb();
        await db.runAsync("DELETE FROM todos WHERE id = ?", [id]);
        await loadTodos();
      } catch (error) {
        console.error("[useTodos] 删除待办失败:", error);
        throw error;
      }
    },
    [loadTodos]
  );

  /** 完成率 */
  const completionRate = (): number => {
    if (todos.length === 0) return 0;
    const done = todos.filter((t) => t.done === 1).length;
    return Math.round((done / todos.length) * 100);
  };

  return {
    todos,
    loading,
    loadTodos,
    addTodo,
    toggleTodo,
    deleteTodo,
    completionRate,
  };
}
