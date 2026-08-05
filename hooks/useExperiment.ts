import { useState, useCallback, useMemo } from "react";
import { Alert } from "react-native";
import { getDb } from "../db/database";
import { todayLocal } from "../utils/date";
import type { Experiment, SopStep } from "../db/schema";

/**
 * 实验执行 Hook
 *
 * 功能：
 *  - 加载今日/全部实验列表
 *  - 加载选中实验的 SOP 步骤
 *  - 切换步骤完成状态
 *  - 更新步骤备注
 *  - 计算整体进度
 */

export function useExperiment() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedExperiment, setSelectedExperiment] =
    useState<Experiment | null>(null);
  const [steps, setSteps] = useState<SopStep[]>([]);
  const [loading, setLoading] = useState(false);

  // ── 加载今日实验 ──
  const loadTodayExperiments = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();
      const today = todayLocal();
      const rows = await db.getAllAsync<Experiment>(
        `SELECT * FROM experiments
         WHERE scheduled_date = ? AND status != 'cancelled'
         ORDER BY
           CASE status
             WHEN 'in_progress' THEN 0
             WHEN 'planned'     THEN 1
             WHEN 'paused'      THEN 2
             WHEN 'completed'   THEN 3
           END,
           scheduled_time ASC NULLS LAST`,
        [today]
      );
      setExperiments(rows);
    } catch (err) {
      console.error("[useExperiment] 加载实验失败:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── 加载全部实验（不限今日） ──
  const loadAllExperiments = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<Experiment>(
        `SELECT * FROM experiments
         WHERE status != 'cancelled'
         ORDER BY scheduled_date DESC, scheduled_time ASC NULLS LAST
         LIMIT 50`
      );
      setExperiments(rows);
    } catch (err) {
      console.error("[useExperiment] 加载全部实验失败:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── 选择实验并加载其 SOP 步骤 ──
  const selectExperiment = useCallback(async (exp: Experiment) => {
    setSelectedExperiment(exp);
    setLoading(true);
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<SopStep>(
        `SELECT * FROM sop_steps
         WHERE experiment_id = ?
         ORDER BY step_num ASC`,
        [exp.id]
      );
      setSteps(rows);
    } catch (err) {
      console.error("[useExperiment] 加载步骤失败:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── 取消选择 ──
  const deselectExperiment = useCallback(() => {
    setSelectedExperiment(null);
    setSteps([]);
  }, []);

  // ── 切换步骤完成状态 ──
  const toggleStepCompleted = useCallback(
    async (stepId: number): Promise<void> => {
      const step = steps.find((s) => s.id === stepId);
      if (!step) return;

      const newVal = step.completed === 1 ? 0 : 1;
      try {
        const db = await getDb();
        await db.runAsync(
          `UPDATE sop_steps
           SET completed = ?,
               completed_at = ?
           WHERE id = ?`,
          [newVal, newVal === 1 ? new Date().toISOString() : null, stepId]
        );

        // 更新本地状态
        setSteps((prev) =>
          prev.map((s) =>
            s.id === stepId
              ? {
                  ...s,
                  completed: newVal as 0 | 1,
                  completed_at: newVal === 1 ? new Date().toISOString() : null,
                }
              : s
          )
        );
      } catch (err) {
        console.error("[useExperiment] 切换步骤状态失败:", err);
        Alert.alert("操作失败", "更新步骤状态失败，请重试");
      }
    },
    [steps]
  );

  // ── 更新步骤备注 ──
  const updateStepNotes = useCallback(
    async (stepId: number, notes: string): Promise<void> => {
      try {
        const db = await getDb();
        await db.runAsync("UPDATE sop_steps SET notes = ? WHERE id = ?", [
          notes,
          stepId,
        ]);
        setSteps((prev) =>
          prev.map((s) => (s.id === stepId ? { ...s, notes } : s))
        );
      } catch (err) {
        console.error("[useExperiment] 更新备注失败:", err);
        Alert.alert("保存失败", "备注保存失败，请重试");
      }
    },
    []
  );

  // ── 更新实验状态（乐观更新，不重查数据库，保持当前视图数据） ──
  const updateExperimentStatus = useCallback(
    async (expId: number, status: Experiment["status"]): Promise<void> => {
      try {
        const db = await getDb();
        await db.runAsync(
          `UPDATE experiments
           SET status = ?, updated_at = datetime('now','localtime')
           WHERE id = ?`,
          [status, expId]
        );
        // 乐观更新本地列表与选中实验
        setExperiments((prev) =>
          prev.map((e) => (e.id === expId ? { ...e, status } : e))
        );
        setSelectedExperiment((prev) =>
          prev?.id === expId ? { ...prev, status } : prev
        );
      } catch (err) {
        console.error("[useExperiment] 更新实验状态失败:", err);
        Alert.alert("操作失败", "更新实验状态失败，请重试");
      }
    },
    []
  );

  // ── 总体进度 ──
  const overallProgress = useMemo((): {
    done: number;
    total: number;
    percent: number;
  } => {
    const total = steps.length;
    const done = steps.filter((s) => s.completed === 1).length;
    const percent = total === 0 ? 0 : Math.round((done / total) * 100);
    return { done, total, percent };
  }, [steps]);

  return {
    experiments,
    selectedExperiment,
    steps,
    loading,
    overallProgress,
    loadTodayExperiments,
    loadAllExperiments,
    selectExperiment,
    deselectExperiment,
    toggleStepCompleted,
    updateStepNotes,
    updateExperimentStatus,
  };
}
