import { useState, useCallback } from "react";
import * as SQLite from "expo-sqlite";
import type { Experiment, Todo, DailyPlan as _DP } from "../db/schema";
import { generateDailyPlan, type DailyPlan } from "../services/llm";

/**
 * AI 每日规划 Hook
 *
 * 功能：
 *  - 从 daily_plans 表加载/保存今日规划
 *  - 调用 LLM 生成新规划
 *  - 缓存到本地数据库避免重复调用
 */

export function useDailyPlan() {
  const [plan, setPlan] = useState<DailyPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── 从数据库加载今日规划 ──
  const loadTodayPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const today = new Date().toISOString().split("T")[0];

      const row = await db.getFirstAsync<{ plan_json: string }>(
        "SELECT plan_json FROM daily_plans WHERE date = ?",
        [today]
      );

      if (row?.plan_json) {
        try {
          const parsed = JSON.parse(row.plan_json) as DailyPlan;
          setPlan(parsed);
        } catch {
          setPlan(null);
        }
      } else {
        setPlan(null);
      }
    } catch (err) {
      console.error("[useDailyPlan] 加载失败:", err);
      setPlan(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── 生成新规划 ──
  const generate = useCallback(
    async (
      experiments: Experiment[],
      todos: Todo[]
    ): Promise<DailyPlan | null> => {
      setGenerating(true);
      setError(null);
      try {
        const result = await generateDailyPlan(experiments, todos);

        if (!result.plan) {
          setError(result.error ?? "生成失败，请重试");
          return null;
        }

        setPlan(result.plan);

        // 保存到数据库
        const db = await SQLite.openDatabaseAsync("labflow.db");
        const today = new Date().toISOString().split("T")[0];
        await db.runAsync(
          `INSERT INTO daily_plans (date, plan_json)
           VALUES (?, ?)
           ON CONFLICT(date) DO UPDATE SET
             plan_json = excluded.plan_json,
             updated_at = datetime('now','localtime')`,
          [today, JSON.stringify(result.plan)]
        );

        return result.plan;
      } catch (err: any) {
        setError(err.message ?? "生成失败");
        return null;
      } finally {
        setGenerating(false);
      }
    },
    []
  );

  // ── 清除今日规划 ──
  const clearPlan = useCallback(async () => {
    const db = await SQLite.openDatabaseAsync("labflow.db");
    const today = new Date().toISOString().split("T")[0];
    await db.runAsync("DELETE FROM daily_plans WHERE date = ?", [today]);
    setPlan(null);
    setError(null);
  }, []);

  return {
    plan,
    loading,
    generating,
    error,
    loadTodayPlan,
    generate,
    clearPlan,
  };
}
