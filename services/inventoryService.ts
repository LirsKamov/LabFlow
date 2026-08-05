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

import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getDb, withTransaction } from "../db/database";
import { toLocalDateString } from "../utils/date";
import type { ReactionTemplate, UsageLog } from "../db/schema";

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
 *
 * 扣减+日志在同一事务内；低量通知在事务外发送，
 * 避免通知失败回滚扣减。
 */
export async function deductKitUsage(
  kitId: number,
  experimentId: number | null,
  reactionCount: number,
  templateId: number
): Promise<{ success: boolean; error?: string; lowComponents?: string[] }> {
  try {
    const lowItems: { id: number; name: string; unit: string; qty: number }[] = [];

    await withTransaction(async (db) => {
      // 读取反应模板
      const tmpl = await db.getFirstAsync<ReactionTemplate>(
        "SELECT * FROM reaction_templates WHERE id = ? AND kit_id = ?",
        [templateId, kitId]
      );
      if (!tmpl) throw new Error("未找到反应体系模板");

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

      // 批量扣减
      for (const comp of components) {
        const match = allComponents.find(
          (c) => c.name.trim().toLowerCase() === comp.name.trim().toLowerCase()
        );
        if (!match) continue; // 模板中的组分在库存中不存在，跳过

        const deductQty = comp.vol_ul * reactionCount;
        const newQty = Math.max(0, match.current_qty - deductQty);

        // 更新库存
        await db.runAsync(
          "UPDATE kit_components SET current_qty = ? WHERE id = ?",
          [newQty, match.id]
        );

        // 写入使用日志（operation = 'use' 消耗）
        await db.runAsync(
          `INSERT INTO usage_logs (kit_id, experiment_id, component_id, used_qty, unit, note, operation)
           VALUES (?, ?, ?, ?, ?, ?, 'use')`,
          [kitId, experimentId, match.id, deductQty, match.unit, `反应 ×${reactionCount}，模板: ${tmpl.template_name}`]
        );

        // 记录低量组分（通知在事务外做）
        if (newQty <= match.low_threshold) {
          lowItems.push({ id: match.id, name: match.name, unit: match.unit, qty: newQty });
        }
      }
    });

    // 低量通知（事务外，失败不影响已提交的扣减）
    for (const item of lowItems) {
      if (await shouldNotify(item.id)) {
        const db = await getDb();
        const kit = await db.getFirstAsync<{ name: string }>(
          "SELECT name FROM kits WHERE id = ?", [kitId]
        );
        await Notifications.scheduleNotificationAsync({
          content: {
            title: "⚠️ 试剂库存不足",
            body: `「${kit?.name ?? "试剂盒"}」的「${item.name}」库存不足！当前剩余：${item.qty.toFixed(1)} ${item.unit}`,
            sound: "default",
            data: { type: "inventory", componentId: item.id },
          },
          trigger: { seconds: 1, channelId: "labflow-daily" },
        });
        await markNotified(item.id);
      }
    }

    return { success: true, lowComponents: lowItems.map((i) => i.name) };
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
    const db = await getDb();

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
      const match = components.find((c) => c.name.trim().toLowerCase() === tc.name.trim().toLowerCase());
      if (!match || tc.vol_ul <= 0) continue;
      const runs = Math.floor(match.current_qty / tc.vol_ul);
      if (runs < minRuns) {
        minRuns = runs;
        limiting = tc.name;
      }
    }

    const limitingComp = components.find((c) => c.name.trim() === limiting.trim());
    const limitingTemplate = templateComponents.find((c) => c.name.trim() === limiting.trim());

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
 *
 * 统计口径与补货/纠错分离：SUM 只统计 operation='use' 的消耗，
 * 避免补货正数冲抵消耗导致耗尽预测偏早（老数据迁移后默认 'use'）。
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
    const db = await getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = toLocalDateString(since);

    const rows = await db.getAllAsync<{ date: string; total_used: number; exp_count: number }>(
      `SELECT date(used_at) AS date,
              SUM(CASE WHEN operation = 'use' THEN used_qty ELSE 0 END) AS total_used,
              COUNT(DISTINCT CASE WHEN operation = 'use' THEN experiment_id END) AS exp_count
       FROM usage_logs
       WHERE kit_id = ? AND operation = 'use' AND date(used_at) >= ?
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
      depletionDate = toLocalDateString(d);
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
  const db = await getDb();
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
 *
 * 一条聚合 SQL 同时拿 kits + componentCount + 健康度（消除 N+1）；
 * remainingRuns 仍需逐 kit 调用 getRemainingRuns（内部两次查询可接受）。
 */
export async function getKitSummaries(): Promise<
  {
    id: number; name: string; brand: string;
    componentCount: number; overallHealth: number; remainingRuns: number;
  }[]
> {
  const db = await getDb();
  // SQLite 无标量 MIN/MAX，健康度用 CASE 钳制到 [0,1] 后取 AVG（NULL 被忽略）
  const rows = await db.getAllAsync<{ id: number; name: string; brand: string; component_count: number; health: number }>(
    `SELECT k.id, k.name, k.brand,
            COUNT(kc.id) AS component_count,
            COALESCE(AVG(
              CASE WHEN kc.initial_qty > 0 THEN
                (CASE
                  WHEN kc.current_qty >= kc.initial_qty THEN 1.0
                  WHEN kc.current_qty <= 0 THEN 0.0
                  ELSE kc.current_qty / kc.initial_qty
                END)
              END
            ), 1) AS health
     FROM kits k LEFT JOIN kit_components kc ON kc.kit_id = k.id
     GROUP BY k.id
     ORDER BY k.created_at DESC`
  );

  const result: { id: number; name: string; brand: string; componentCount: number; overallHealth: number; remainingRuns: number }[] = [];
  for (const kit of rows) {
    const runs = await getRemainingRuns(kit.id);
    result.push({
      id: kit.id,
      name: kit.name,
      brand: kit.brand,
      componentCount: kit.component_count,
      overallHealth: kit.health,
      remainingRuns: runs?.runs ?? 0,
    });
  }
  return result;
}

/**
 * 获取用量历史
 */
export async function getUsageHistory(kitId: number, limit = 50) {
  const db = await getDb();
  return await db.getAllAsync<UsageLog & {
    component_name: string;
    experiment_name: string | null;
  }>(
    `SELECT ul.id, kc.name AS component_name, ul.used_qty, ul.unit, ul.used_at, ul.note, ul.operation, e.name AS experiment_name
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
 *
 * operation 与消耗统计口径分离：delta >= 0 记 'restock'，否则 'adjust'，
 * 两者都不计入 getUsageStats 的消耗 SUM。
 */
export async function adjustInventory(
  componentId: number,
  delta: number,
  reason: string
): Promise<void> {
  const db = await getDb();
  const comp = await db.getFirstAsync<{ kit_id: number; current_qty: number; unit: string; name: string }>(
    "SELECT kit_id, current_qty, unit, name FROM kit_components WHERE id = ?", [componentId]
  );
  if (!comp) throw new Error("内容物不存在");
  const newQty = Math.max(0, comp.current_qty + delta);
  await db.runAsync("UPDATE kit_components SET current_qty = ? WHERE id = ?", [newQty, componentId]);
  await db.runAsync(
    "INSERT INTO usage_logs (kit_id, component_id, used_qty, unit, note, operation) VALUES (?, ?, ?, ?, ?, ?)",
    [comp.kit_id, componentId, Math.abs(delta), comp.unit, `${delta >= 0 ? "补货" : "纠错"}: ${reason} (${delta >= 0 ? "+" : ""}${delta} ${comp.unit})`, delta >= 0 ? "restock" : "adjust"]
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
  const db = await getDb();
  const tmpl = await db.getFirstAsync<{ components_json: string }>(
    "SELECT components_json FROM reaction_templates WHERE id = ?", [templateId]
  );
  if (!tmpl) return [];
  const templateComponents = JSON.parse(tmpl.components_json) as { name: string; vol_ul: number }[];
  const stockComponents = await db.getAllAsync<{ name: string; unit: string; current_qty: number; low_threshold: number }>(
    "SELECT name, unit, current_qty, low_threshold FROM kit_components WHERE kit_id = ?", [kitId]
  );

  return templateComponents.map((tc) => {
    const match = stockComponents.find((s) => s.name.trim().toLowerCase() === tc.name.trim().toLowerCase());
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
