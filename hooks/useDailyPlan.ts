import { useState, useCallback, useRef } from "react";
import { Alert } from "react-native";
import { getDb } from "../db/database";
import { todayLocal } from "../utils/date";
import type { Experiment, Todo } from "../db/schema";
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
  /** 生成中标记（防双击并发计费） */
  const generatingRef = useRef(false);
  /** 最新已生成/加载的规划（供并发守卫返回） */
  const planRef = useRef<DailyPlan | null>(null);

  // ── 从数据库加载今日规划 ──
  const loadTodayPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const today = todayLocal();
      const db = await getDb();

      const row = await db.getFirstAsync<{ plan_json: string }>(
        "SELECT plan_json FROM daily_plans WHERE date = ?",
        [today]
      );

      if (row?.plan_json) {
        try {
          const parsed = JSON.parse(row.plan_json) as DailyPlan;
          setPlan(parsed);
          planRef.current = parsed;
        } catch {
          setPlan(null);
          planRef.current = null;
        }
      } else {
        setPlan(null);
        planRef.current = null;
      }
    } catch (err) {
      console.error("[useDailyPlan] 加载失败:", err);
      setPlan(null);
      planRef.current = null;
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
      // 并发保护：正在生成时直接返回当前已知规划，防止重复计费
      if (generatingRef.current) return planRef.current;
      generatingRef.current = true;
      setGenerating(true);
      setError(null);
      try {
        const result = await generateDailyPlan(experiments, todos);

        if (!result.plan) {
          setError(result.error ?? "生成失败，请重试");
          return null;
        }

        setPlan(result.plan);
        planRef.current = result.plan;

        // 保存到数据库
        try {
          const db = await getDb();
          const today = todayLocal();
          await db.runAsync(
            `INSERT INTO daily_plans (date, plan_json)
             VALUES (?, ?)
             ON CONFLICT(date) DO UPDATE SET
               plan_json = excluded.plan_json,
               updated_at = datetime('now','localtime')`,
            [today, JSON.stringify(result.plan)]
          );
        } catch (err) {
          console.error("[useDailyPlan] 保存规划失败:", err);
          Alert.alert("保存失败", "规划已生成但保存失败，请检查存储空间");
        }

        return result.plan;
      } catch (err: any) {
        setError(err.message ?? "生成失败");
        return null;
      } finally {
        generatingRef.current = false;
        setGenerating(false);
      }
    },
    []
  );

  // ── 清除今日规划 ──
  const clearPlan = useCallback(async () => {
    try {
      const db = await getDb();
      const today = todayLocal();
      await db.runAsync("DELETE FROM daily_plans WHERE date = ?", [today]);
      setPlan(null);
      planRef.current = null;
      setError(null);
    } catch (err) {
      console.error("[useDailyPlan] 清除失败:", err);
      Alert.alert("清除失败", "清除今日规划失败，请重试");
    }
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
