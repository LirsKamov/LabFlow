/**
 * 样品库管理服务
 *
 * 功能：CRUD、用量变更、溯源、搜索
 */

import * as SQLite from "expo-sqlite";
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
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const result = await db.runAsync(
    `INSERT INTO samples (name, type, source_experiment_id, project_id, location_json, volume_ul, concentration, concentration_unit, storage_temp, expiry_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name, data.type, data.source_experiment_id ?? null, data.project_id ?? null,
      data.location_json ?? "{}", data.volume_ul, data.concentration ?? "", data.concentration_unit ?? "ng/μL",
      data.storage_temp ?? "-20", data.expiry_date ?? null, data.notes ?? "",
    ]
  );
  return result.lastInsertRowId;
}

/** 变更体积（delta 正=补充，负=消耗/discard） */
export async function updateVolume(
  sampleId: number,
  deltaUl: number,
  experimentId: number | null,
  operation: SampleUsageLog["operation"],
  note: string = ""
): Promise<void> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const sample = await db.getFirstAsync<Sample>("SELECT * FROM samples WHERE id = ?", [sampleId]);
  if (!sample) throw new Error("样品不存在");

  const newVolume = Math.max(0, sample.volume_ul + deltaUl);
  const newStatus = newVolume <= 0 ? "depleted" : sample.status;

  await db.runAsync("UPDATE samples SET volume_ul = ?, status = ? WHERE id = ?", [newVolume, newStatus, sampleId]);
  await db.runAsync(
    `INSERT INTO sample_usage_logs (sample_id, experiment_id, used_volume_ul, remaining_after_ul, operation, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sampleId, experimentId, Math.abs(deltaUl), newVolume, operation, note]
  );
}

/** 更新样品信息 */
export async function updateSample(sampleId: number, data: Partial<SampleInput>): Promise<void> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const sets: string[] = [];
  const vals: any[] = [];
  if (data.name !== undefined) { sets.push("name = ?"); vals.push(data.name); }
  if (data.concentration !== undefined) { sets.push("concentration = ?"); vals.push(data.concentration); }
  if (data.concentration_unit !== undefined) { sets.push("concentration_unit = ?"); vals.push(data.concentration_unit); }
  if (data.location_json !== undefined) { sets.push("location_json = ?"); vals.push(data.location_json); }
  if (data.notes !== undefined) { sets.push("notes = ?"); vals.push(data.notes); }
  if (data.storage_temp !== undefined) { sets.push("storage_temp = ?"); vals.push(data.storage_temp); }
  if (sets.length === 0) return;
  vals.push(sampleId);
  await db.runAsync(`UPDATE samples SET ${sets.join(", ")} WHERE id = ?`, vals);
}

/** 标记废弃 */
export async function discardSample(sampleId: number): Promise<void> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  await db.runAsync("UPDATE samples SET status = 'discarded' WHERE id = ?", [sampleId]);
  await db.runAsync(
    "INSERT INTO sample_usage_logs (sample_id, used_volume_ul, remaining_after_ul, operation, note) VALUES (?, 0, 0, 'discard', '标记废弃')",
    [sampleId]
  );
}

/** 按项目获取 */
export async function getSamplesByProject(projectId: number): Promise<SampleWithMeta[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.project_id = ? AND s.status != 'discarded' ORDER BY s.created_at DESC`, [projectId]
  );
}

/** 按类型获取 */
export async function getSamplesByType(type: SampleType): Promise<SampleWithMeta[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.type = ? AND s.status != 'discarded' ORDER BY s.created_at DESC`, [type]
  );
}

/** 搜索 */
export async function searchSamples(keyword: string): Promise<SampleWithMeta[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const like = `%${keyword}%`;
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE (s.name LIKE ? OR s.notes LIKE ?) AND s.status != 'discarded' ORDER BY s.created_at DESC`, [like, like]
  );
}

/** 获取所有样品（按存储温度分组用） */
export async function getAllSamples(): Promise<SampleWithMeta[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getAllAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.status != 'discarded' ORDER BY s.storage_temp, s.created_at DESC`
  );
}

/** 获取单个样品 */
export async function getSample(sampleId: number): Promise<SampleWithMeta | null> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getFirstAsync<SampleWithMeta>(
    `SELECT s.*, e.name AS source_experiment_name, p.name AS project_name
     FROM samples s LEFT JOIN experiments e ON s.source_experiment_id = e.id LEFT JOIN projects p ON s.project_id = p.id
     WHERE s.id = ?`, [sampleId]
  );
}

/** 获取样品使用日志 */
export async function getSampleUsageLogs(sampleId: number): Promise<(SampleUsageLog & { experiment_name: string | null })[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getAllAsync(
    `SELECT ul.*, e.name AS experiment_name FROM sample_usage_logs ul LEFT JOIN experiments e ON ul.experiment_id = e.id
     WHERE ul.sample_id = ? ORDER BY ul.created_at DESC`, [sampleId]
  );
}

/** 样品溯源（递归追溯 source_experiment_id 链） */
export async function getSampleLineage(sampleId: number): Promise<LineageNode[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const lineage: LineageNode[] = [];
  let currentId: number | null = sampleId;

  // 先拿到样品自身的 source_experiment_id
  const sample = await db.getFirstAsync<{ source_experiment_id: number | null }>(
    "SELECT source_experiment_id FROM samples WHERE id = ?", [sampleId]
  );
  if (!sample?.source_experiment_id) return lineage;

  let expId: number | null = sample.source_experiment_id;
  const visited = new Set<number>();
  const maxDepth = 10;

  while (expId && lineage.length < maxDepth && !visited.has(expId)) {
    visited.add(expId);
    const exp = await db.getFirstAsync<{ name: string; scheduled_date: string }>(
      "SELECT name, scheduled_date FROM experiments WHERE id = ?", [expId]
    );
    if (!exp) break;

    const steps = await db.getAllAsync<{ title: string }>(
      "SELECT title FROM sop_steps WHERE experiment_id = ? ORDER BY step_num ASC LIMIT 5", [expId]
    );

    lineage.push({
      experimentId: expId,
      experimentName: exp.name,
      date: exp.scheduled_date,
      keySteps: steps.map((s) => s.title),
    });

    // 查找该实验的源样品
    const nextSample = await db.getFirstAsync<{ source_experiment_id: number | null }>(
      "SELECT source_experiment_id FROM samples WHERE source_experiment_id = ? LIMIT 1", [expId]
    );
    expId = nextSample?.source_experiment_id ?? null;
  }

  return lineage;
}

/** 获取实验列表（供下拉选择） */
export async function getExperimentOptions(): Promise<{ id: number; name: string; date: string }[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getAllAsync(
    "SELECT id, name, scheduled_date AS date FROM experiments ORDER BY scheduled_date DESC LIMIT 100"
  );
}
