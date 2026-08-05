/**
 * 样品库管理服务
 *
 * 功能：CRUD、用量变更、溯源、搜索
 */

import { getDb, withTransaction } from "../db/database";
import type { Sample, SampleType, SampleUsageLog } from "../db/schema";

// ─── 类型 ────────────────────────────────────────────────────

export interface SampleInput {
  name: string;
  type: SampleType;
  source_experiment_id?: number | null;
  project_id?: number | null;
  location_json?: string;
  volume_ul: number;
  concentration?: string;
  concentration_unit?: string;
  storage_temp?: '-80' | '-20' | '4' | 'RT';
  expiry_date?: string | null;
  notes?: string;
}

export interface SampleWithMeta extends Sample {
  source_experiment_name: string | null;
  project_name: string | null;
}

export interface LineageNode {
  experimentId: number;
  experimentName: string;
  date: string;
  keySteps: string[];
}

// ─── 常量 ────────────────────────────────────────────────────

export const SAMPLE_TYPE_CONFIG: Record<SampleType, { label: string; icon: string; color: string }> = {
  bacteria:  { label: "菌液",     icon: "bug",              color: "bg-emerald-100 text-emerald-700" },
  plasmid:   { label: "质粒",     icon: "git-network",      color: "bg-blue-100 text-blue-700" },
  competent: { label: "感受态",   icon: "sparkles",         color: "bg-purple-100 text-purple-700" },
  pcr_product:{ label: "PCR产物", icon: "color-filter",     color: "bg-orange-100 text-orange-700" },
  rna:       { label: "RNA",      icon: "leaf",             color: "bg-red-100 text-red-700" },
  dna:       { label: "DNA",      icon: "git-branch",       color: "bg-teal-100 text-teal-700" },
  protein:   { label: "蛋白",     icon: "nutrition",        color: "bg-amber-100 text-amber-700" },
  other:     { label: "其他",     icon: "ellipse",          color: "bg-gray-100 text-gray-600" },
};

export const STORAGE_TEMP_LABELS: Record<string, string> = {
  '-80': '-80°C 超低温',
  '-20': '-20°C 冷冻',
  '4':   '4°C 冷藏',
  'RT':  '室温',
};

// ════════════════════════════════════════════════════════════

/** 创建样品 */
export async function createSample(data: SampleInput): Promise<number> {
  const name = data.name.trim();
  if (!name) throw new Error("样品名称不能为空");
  if (!Number.isFinite(data.volume_ul) || data.volume_ul < 0) throw new Error("体积必须为 >= 0 的有限数值");

  const db = await getDb();
  const result = await db.runAsync(
    `INSERT INTO samples (name, type, source_experiment_id, project_id, location_json, volume_ul, concentration, concentration_unit, storage_temp, expiry_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, data.type, data.source_experiment_id ?? null, data.project_id ?? null,
      data.location_json ?? "{}", data.volume_ul, data.concentration ?? "", data.concentration_unit ?? "ng/μL",
      data.storage_temp ?? "-20", data.expiry_date ?? null, data.notes ?? "",
    ]
  );
  return result.lastInsertRowId;
}

/**
 * 变更体积（delta 正=补充，负=消耗）
 *
 * 事务内完成「读样品 → 算新体积 → UPDATE → INSERT 日志」四步，
 * 杜绝读改写竞态；返回实际新体积（钳制在 0，UI 可提示"实际只扣到 0"）。
 */
export async function updateVolume(
  sampleId: number,
  deltaUl: number,
  experimentId: number | null,
  operation: SampleUsageLog["operation"],
  note: string = ""
): Promise<number> {
  if (!Number.isFinite(deltaUl)) throw new Error("变更量无效");
  // operation 与符号一致性校验
  if (operation === "add" && deltaUl <= 0) throw new Error("add 操作要求 deltaUl > 0");
  if (operation === "use" && deltaUl > 0) throw new Error("use 操作要求 deltaUl <= 0");

  return withTransaction(async (db) => {
    const sample = await db.getFirstAsync<Sample>("SELECT * FROM samples WHERE id = ?", [sampleId]);
    if (!sample) throw new Error("样品不存在");

    const newVolume = Math.max(0, sample.volume_ul + deltaUl);
    // 实际扣减值：钳制后实际扣 min(volume_ul, |delta|)；补充时为 0
    const actualDeducted = sample.volume_ul - newVolume;

    // 补液回弹：depleted 样品补液后恢复 active（discarded 永不恢复，
    // CHECK 约束保证 status 单值，split 成两个 boolean 避免 TS2367 判重）
    const wasDepleted = sample.status === "depleted";
    const notDiscarded = sample.status !== "discarded";
    let newStatus: Sample["status"] = sample.status;
    if (newVolume <= 0) {
      newStatus = "depleted";
    } else if (deltaUl > 0 && wasDepleted && notDiscarded) {
      newStatus = "active";
    }

    await db.runAsync("UPDATE samples SET volume_ul = ?, status = ? WHERE id = ?", [newVolume, newStatus, sampleId]);
    await db.runAsync(
      `INSERT INTO sample_usage_logs (sample_id, experiment_id, used_volume_ul, remaining_after_ul, operation, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sampleId, experimentId, actualDeducted, newVolume, operation, note]
    );
    return newVolume;
  });
}

/** 更新样品信息（字段白名单，杜绝任意列写入） */
export async function updateSample(sampleId: number, data: Partial<SampleInput>): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  const fields: { key: keyof SampleInput; col: string }[] = [
    { key: "name", col: "name" },
    { key: "type", col: "type" },
    { key: "volume_ul", col: "volume_ul" },
    { key: "concentration", col: "concentration" },
    { key: "concentration_unit", col: "concentration_unit" },
    { key: "location_json", col: "location_json" },
    { key: "storage_temp", col: "storage_temp" },
    { key: "expiry_date", col: "expiry_date" },
    { key: "source_experiment_id", col: "source_experiment_id" },
    { key: "project_id", col: "project_id" },
    { key: "notes", col: "notes" },
  ];
  for (const f of fields) {
    const v = data[f.key];
    if (v !== undefined) { sets.push(`${f.col} = ?`); vals.push(v); }
  }
  if (sets.length === 0) return;
  vals.push(sampleId);
  await db.runAsync(`UPDATE samples SET ${sets.join(", ")} WHERE id = ?`, vals);
}

/** 标记废弃（幂等：已废弃时直接返回，不重复插日志） */
export async function discardSample(sampleId: number): Promise<void> {
  await withTransaction(async (db) => {
    const sample = await db.getFirstAsync<{ status: Sample["status"] }>("SELECT status FROM samples WHERE id = ?", [sampleId]);
    if (!sample) throw new Error("样品不存在");
    if (sample.status === "discarded") return; // 幂等
    await db.runAsync("UPDATE samples SET status = 'discarded' WHERE id = ?", [sampleId]);
    await db.runAsync(
      "INSERT INTO sample_usage_logs (sample_id, used_volume_ul, remaining_after_ul, operation, note) VALUES (?, 0, 0, 'discard', '标记废弃')",
      [sampleId]
    );
  });
}

/** 按项目获取 */
export async function getSamplesByProject(projectId: number): Promise<SampleWithMeta[]> {
  const db = await getDb();
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.project_id = ? AND s.status != 'discarded' ORDER BY s.created_at DESC`, [projectId]
  );
}

/** 按类型获取 */
export async function getSamplesByType(type: SampleType): Promise<SampleWithMeta[]> {
  const db = await getDb();
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.type = ? AND s.status != 'discarded' ORDER BY s.created_at DESC`, [type]
  );
}

/** 转义 LIKE 通配符（% / _ / \ → 反斜杠转义，配合 ESCAPE '\'） */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 搜索（LIKE 通配符已转义，% / _ 作为字面量匹配） */
export async function searchSamples(keyword: string): Promise<SampleWithMeta[]> {
  const db = await getDb();
  const like = `%${escapeLike(keyword.trim())}%`;
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE (s.name LIKE ? ESCAPE '\\' OR s.notes LIKE ? ESCAPE '\\') AND s.status != 'discarded' ORDER BY s.created_at DESC`, [like, like]
  );
}

/** 获取所有样品（按存储温度分组用） */
export async function getAllSamples(): Promise<SampleWithMeta[]> {
  const db = await getDb();
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.status != 'discarded' ORDER BY s.storage_temp, s.created_at DESC`
  );
}

/** 获取单个样品 */
export async function getSample(sampleId: number): Promise<SampleWithMeta | null> {
  const db = await getDb();
  return await db.getFirstAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.id = ?`, [sampleId]
  );
}

/** 获取样品使用日志 */
export async function getSampleUsageLogs(sampleId: number): Promise<(SampleUsageLog & { experiment_name: string | null })[]> {
  const db = await getDb();
  return await db.getAllAsync(
    `SELECT ul.*, e.name AS experiment_name FROM sample_usage_logs ul LEFT JOIN experiments e ON ul.experiment_id = e.id
     WHERE ul.sample_id = ? ORDER BY ul.created_at DESC`, [sampleId]
  );
}

/**
 * 样品溯源（血缘链基于 sample_usage_logs 追溯）
 *
 * 从当前样品出发：
 *  1. 查 sample.source_experiment_id（哪个实验产生了我），无则终止
 *  2. 记录该实验为血缘节点（name/scheduled_date/前 5 步 steps）
 *  3. 查该实验的输入样品：
 *     SELECT DISTINCT sample_id FROM sample_usage_logs
 *     WHERE experiment_id = ? AND operation = 'use'
 *  4. 取第一个输入样品作为下一跳（若输入就是当前样品或已访问则终止）
 * visited 防环 + maxDepth = 10
 */
export async function getSampleLineage(sampleId: number): Promise<LineageNode[]> {
  return withTransaction(async (db) => {
    const lineage: LineageNode[] = [];
    const visitedExps = new Set<number>();
    const visitedSamples = new Set<number>();
    const maxDepth = 10;

    let currentSampleId: number | null = sampleId;

    while (currentSampleId && lineage.length < maxDepth) {
      // 显式类型标注：规避 TS7022（while 循环体内 const 推断回环）
      const sample: { source_experiment_id: number | null } | null = await db.getFirstAsync<{ source_experiment_id: number | null }>(
        "SELECT source_experiment_id FROM samples WHERE id = ?", [currentSampleId]
      );
      if (!sample?.source_experiment_id) break;

      const expId: number = sample.source_experiment_id;
      if (visitedExps.has(expId)) break;
      visitedExps.add(expId);
      visitedSamples.add(currentSampleId);

      const exp: { name: string; scheduled_date: string } | null = await db.getFirstAsync<{ name: string; scheduled_date: string }>(
        "SELECT name, scheduled_date FROM experiments WHERE id = ?", [expId]
      );
      if (!exp) break;

      const steps: { title: string }[] = await db.getAllAsync<{ title: string }>(
        "SELECT title FROM sop_steps WHERE experiment_id = ? ORDER BY step_num ASC LIMIT 5", [expId]
      );

      lineage.push({
        experimentId: expId,
        experimentName: exp.name,
        date: exp.scheduled_date,
        keySteps: steps.map((s) => s.title),
      });

      // 查该实验的输入样品（usage 日志），取第一个未访问的作为下一跳
      const inputSamples: { sample_id: number }[] = await db.getAllAsync<{ sample_id: number }>(
        "SELECT DISTINCT sample_id FROM sample_usage_logs WHERE experiment_id = ? AND operation = 'use'",
        [expId]
      );
      const next: { sample_id: number } | undefined = inputSamples.find((s) => s.sample_id !== currentSampleId && !visitedSamples.has(s.sample_id));
      currentSampleId = next?.sample_id ?? null;
    }

    return lineage;
  });
}

/** 获取实验列表（供下拉选择） */
export async function getExperimentOptions(): Promise<{ id: number; name: string; date: string }[]> {
  const db = await getDb();
  return await db.getAllAsync(
    "SELECT id, name, scheduled_date AS date FROM experiments ORDER BY scheduled_date DESC LIMIT 100"
  );
}
