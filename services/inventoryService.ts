/**
 * 试剂盒库存管理服务
 *
 * 功能：
 *  - 用量扣减（deductKitUsage）
 *  - 剩余次数计算（getRemainingRuns）
 *  - 消耗统计与耗尽预测（getUsageStats）
 *  - 低量预警通知
 *  - 手动调库
 */

import * as SQLite from "expo-sqlite";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ReactionTemplate } from "../db/schema";

// ─── 类型 ────────────────────────────────────────────────────

export interface ComponentStock {
  id: number;
  name: string;
  unit: string;
  current_qty: number;
  initial_qty: number;
  low_threshold: number;
  storage_condition: string;
  /** 低于阈值 */
  isLow: boolean;
  /** 健康度 0-1 */
  health: number;
}

export interface RemainingRuns {
  runs: number;
  limitingComponent: string;
  limitingComponentQty: number;
  perReactionQty: number;
}

export interface DeductionPreview {
  componentName: string;
  unit: string;
  perReaction: number;
  totalDeduct: number;
  currentQty: number;
  afterDeduction: number;
  willBeLow: boolean;
}

export interface UsageStat {
  date: string;
  totalUsed: number;
  experiments: number;
}

// ─── 通知去重 ────────────────────────────────────────────────

const NOTIFY_COOLDOWN_KEY = "inventory_notify_";

async function shouldNotify(componentId: number): Promise<boolean> {
  const key = `${NOTIFY_COOLDOWN_KEY}${componentId}`;
  const last = await AsyncStorage.getItem(key);
  if (!last) return true;
  const elapsed = Date.now() - parseInt(last);
  return elapsed > 24 * 60 * 60 * 1000; // 24h
}

async function markNotified(componentId: number): Promise<void> {
  await AsyncStorage.setItem(
    `${NOTIFY_COOLDOWN_KEY}${componentId}`,
    String(Date.now())
  );
}

// ─── 库存健康色 ──────────────────────────────────────────────

export function healthColor(health: number): { bg: string; text: string; label: string } {
  if (health >= 0.5) return { bg: "bg-emerald-100", text: "text-emerald-700", label: "充足" };
  if (health >= 0.2) return { bg: "bg-amber-100", text: "text-amber-700", label: "偏低" };
  return { bg: "bg-red-100", text: "text-red-700", label: "不足" };
}

// ════════════════════════════════════════════════════════════
// 核心函数
// ════════════════════════════════════════════════════════════

/**
 * 扣减试剂盒用量
 *
 * @param kitId            试剂盒 ID
 * @param experimentId     关联实验 ID（可为 null）
 * @param reactionCount    反应管数
 * @param templateId       使用的反应体系模板 ID
 */
export async function deductKitUsage(
  kitId: number,
  experimentId: number | null,
  reactionCount: number,
  templateId: number
): Promise<{ success: boolean; error?: string; lowComponents?: string[] }> {
  try {
    const db = await SQLite.openDatabaseAsync("labflow.db");

    // 读取反应模板
    const tmpl = await db.getFirstAsync<ReactionTemplate>(
      "SELECT * FROM reaction_templates WHERE id = ? AND kit_id = ?",
      [templateId, kitId]
    );
    if (!tmpl) return { success: false, error: "未找到反应体系模板" };

    const components = JSON.parse(tmpl.components_json) as {
      name: string;
      vol_ul: number;
      ratio: string;
    }[];

    // 读取内容物
    const allComponents = await db.getAllAsync<{
      id: number;
      name: string;
      unit: string;
      current_qty: number;
      low_threshold: number;
    }>("SELECT id, name, unit, current_qty, low_threshold FROM kit_components WHERE kit_id = ?", [kitId]);

    const lowComponents: string[] = [];

    // 批量扣减
    for (const comp of components) {
      const match = allComponents.find(
        (c) => c.name.toLowerCase() === comp.name.toLowerCase()
      );
      if (!match) continue; // 模板中的组分在库存中不存在，跳过

      const deductQty = comp.vol_ul * reactionCount;
      const newQty = Math.max(0, match.current_qty - deductQty);

      // 更新库存
      await db.runAsync(
        "UPDATE kit_components SET current_qty = ? WHERE id = ?",
        [newQty, match.id]
      );

      // 写入使用日志
      await db.runAsync(
        `INSERT INTO usage_logs (kit_id, experiment_id, component_id, used_qty, unit, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [kitId, experimentId, match.id, deductQty, match.unit, `反应 ×${reactionCount}，模板: ${tmpl.template_name}`]
      );

      // 检查低量预警
      if (newQty <= match.low_threshold) {
        lowComponents.push(match.name);
        if (await shouldNotify(match.id)) {
          const kit = await db.getFirstAsync<{ name: string }>(
            "SELECT name FROM kits WHERE id = ?", [kitId]
          );
          await Notifications.scheduleNotificationAsync({
            content: {
              title: "⚠️ 试剂库存不足",
              body: `「${kit?.name ?? "试剂盒"}」的「${match.name}」库存不足！当前剩余：${newQty.toFixed(1)} ${match.unit}`,
              sound: "default",
              data: { type: "inventory", componentId: match.id },
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 1, channelId: "labflow-daily" },
          });
          await markNotified(match.id);
        }
      }
    }

    return { success: true, lowComponents };
  } catch (err: any) {
    return { success: false, error: err?.message ?? "扣减失败" };
  }
}

/**
 * 获取试剂盒剩余可用次数
 * 对所有组分：Math.floor(current_qty / per_reaction_qty)，取最小值
 */
export async function getRemainingRuns(
  kitId: number,
  templateId?: number
): Promise<RemainingRuns | null> {
  try {
    const db = await SQLite.openDatabaseAsync("labflow.db");

    // 获取模板
    let templateComponents: { name: string; vol_ul: number }[] = [];

    if (templateId) {
      const tmpl = await db.getFirstAsync<{ components_json: string }>(
        "SELECT components_json FROM reaction_templates WHERE id = ?", [templateId]
      );
      if (tmpl) templateComponents = JSON.parse(tmpl.components_json);
    } else {
      // 使用第一个模板
      const tmpl = await db.getFirstAsync<{ components_json: string }>(
        "SELECT components_json FROM reaction_templates WHERE kit_id = ? LIMIT 1", [kitId]
      );
      if (tmpl) templateComponents = JSON.parse(tmpl.components_json);
    }

    if (templateComponents.length === 0) return null;

    // 获取内容物
    const components = await db.getAllAsync<{
      name: string;
      current_qty: number;
    }>("SELECT name, current_qty FROM kit_components WHERE kit_id = ?", [kitId]);

    let minRuns = Infinity;
    let limiting = "";

    for (const tc of templateComponents) {
      const match = components.find((c) => c.name.toLowerCase() === tc.name.toLowerCase());
      if (!match || tc.vol_ul <= 0) continue;
      const runs = Math.floor(match.current_qty / tc.vol_ul);
      if (runs < minRuns) {
        minRuns = runs;
        limiting = tc.name;
      }
    }

    const limitingComp = components.find((c) => c.name === limiting);
    const limitingTemplate = templateComponents.find((c) => c.name === limiting);

    return {
      runs: minRuns === Infinity ? 0 : minRuns,
      limitingComponent: limiting,
      limitingComponentQty: limitingComp?.current_qty ?? 0,
      perReactionQty: limitingTemplate?.vol_ul ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * 获取库存消耗统计 & 耗尽预测
 */
export async function getUsageStats(
  kitId: number,
  days = 30
): Promise<{
  stats: UsageStat[];
  depletionDate: string | null;
  avgDailyUse: number;
}> {
  try {
    const db = await SQLite.openDatabaseAsync("labflow.db");
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split("T")[0];

    const rows = await db.getAllAsync<{ date: string; total_used: number; exp_count: number }>(
      `SELECT date(used_at) AS date, SUM(used_qty) AS total_used, COUNT(DISTINCT experiment_id) AS exp_count
       FROM usage_logs
       WHERE kit_id = ? AND date(used_at) >= ?
       GROUP BY date(used_at)
       ORDER BY date DESC`,
      [kitId, sinceStr]
    );

    const stats: UsageStat[] = rows.map((r) => ({
      date: r.date,
      totalUsed: r.total_used,
      experiments: r.exp_count,
    }));

    // 平均每日消耗
    const totalUsed = stats.reduce((s, r) => s + r.totalUsed, 0);
    const activeDays = stats.length || 1;
    const avgDailyUse = totalUsed / activeDays;

    // 取最小剩余次数的组分作为耗尽预测基准
    const runs = await getRemainingRuns(kitId);
    let depletionDate: string | null = null;
    if (runs && avgDailyUse > 0) {
      const daysLeft = Math.floor(runs.runs / (avgDailyUse || 1));
      const d = new Date();
      d.setDate(d.getDate() + daysLeft);
      depletionDate = d.toISOString().split("T")[0];
    }

    return { stats, depletionDate, avgDailyUse };
  } catch {
    return { stats: [], depletionDate: null, avgDailyUse: 0 };
  }
}

/**
 * 获取试剂盒所有内容物库存（含健康度）
 */
export async function getKitComponents(kitId: number): Promise<ComponentStock[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const rows = await db.getAllAsync<ComponentStock>(
    "SELECT * FROM kit_components WHERE kit_id = ? ORDER BY name", [kitId]
  );
  return rows.map((c) => ({
    ...c,
    isLow: c.current_qty <= c.low_threshold,
    health: c.initial_qty > 0 ? Math.max(0, Math.min(1, c.current_qty / c.initial_qty)) : 1,
  }));
}

/**
 * 获取试剂盒列表（含健康度总览）
 */
export async function getKitSummaries(): Promise<
  {
    id: number; name: string; brand: string;
    componentCount: number; overallHealth: number; remainingRuns: number;
  }[]
> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const kits = await db.getAllAsync<{ id: number; name: string; brand: string }>(
    "SELECT id, name, brand FROM kits ORDER BY created_at DESC"
  );
  const result = [];
  for (const kit of kits) {
    const components = await getKitComponents(kit.id);
    const overallHealth = components.length > 0
      ? components.reduce((s, c) => s + c.health, 0) / components.length
      : 1;
    const runs = await getRemainingRuns(kit.id);
    result.push({
      ...kit,
      componentCount: components.length,
      overallHealth,
      remainingRuns: runs?.runs ?? 0,
    });
  }
  return result;
}

/**
 * 获取用量历史
 */
export async function getUsageHistory(kitId: number, limit = 50) {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getAllAsync<{
    id: number; component_name: string; used_qty: number; unit: string;
    used_at: string; note: string; experiment_name: string | null;
  }>(
    `SELECT ul.id, kc.name AS component_name, ul.used_qty, ul.unit, ul.used_at, ul.note, e.name AS experiment_name
     FROM usage_logs ul
     JOIN kit_components kc ON ul.component_id = kc.id
     LEFT JOIN experiments e ON ul.experiment_id = e.id
     WHERE ul.kit_id = ?
     ORDER BY ul.used_at DESC LIMIT ?`,
    [kitId, limit]
  );
}

/**
 * 手动调整库存（补货/纠错）
 */
export async function adjustInventory(
  componentId: number,
  delta: number,
  reason: string
): Promise<void> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const comp = await db.getFirstAsync<{ kit_id: number; current_qty: number; unit: string; name: string }>(
    "SELECT kit_id, current_qty, unit, name FROM kit_components WHERE id = ?", [componentId]
  );
  if (!comp) throw new Error("内容物不存在");
  const newQty = Math.max(0, comp.current_qty + delta);
  await db.runAsync("UPDATE kit_components SET current_qty = ? WHERE id = ?", [newQty, componentId]);
  await db.runAsync(
    "INSERT INTO usage_logs (kit_id, component_id, used_qty, unit, note) VALUES (?, ?, ?, ?, ?)",
    [comp.kit_id, componentId, Math.abs(delta), comp.unit, `${delta >= 0 ? "补货" : "纠错"}: ${reason} (${delta >= 0 ? "+" : ""}${delta} ${comp.unit})`]
  );
}

/**
 * 获取扣减预览（在确认前展示将消耗的用量）
 */
export async function getDeductionPreview(
  kitId: number,
  templateId: number,
  reactionCount: number
): Promise<DeductionPreview[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const tmpl = await db.getFirstAsync<{ components_json: string }>(
    "SELECT components_json FROM reaction_templates WHERE id = ?", [templateId]
  );
  if (!tmpl) return [];
  const templateComponents = JSON.parse(tmpl.components_json) as { name: string; vol_ul: number }[];
  const stockComponents = await db.getAllAsync<{ name: string; unit: string; current_qty: number; low_threshold: number }>(
    "SELECT name, unit, current_qty, low_threshold FROM kit_components WHERE kit_id = ?", [kitId]
  );

  return templateComponents.map((tc) => {
    const match = stockComponents.find((s) => s.name.toLowerCase() === tc.name.toLowerCase());
    const totalDeduct = tc.vol_ul * reactionCount;
    const currentQty = match?.current_qty ?? 0;
    const afterDeduction = currentQty - totalDeduct;
    return {
      componentName: tc.name,
      unit: match?.unit ?? "μL",
      perReaction: tc.vol_ul,
      totalDeduct,
      currentQty,
      afterDeduction: Math.max(0, afterDeduction),
      willBeLow: afterDeduction <= (match?.low_threshold ?? 0),
    };
  });
}
