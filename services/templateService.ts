/**
 * 实验模板复用服务
 *
 * 功能：
 *  - 保存实验为模板（saveAsTemplate）
 *  - 实例化模板创建新实验（instantiateTemplate）
 *  - 模板搜索/过滤（getTemplates）
 *  - 自动检测可变字段（detectVariableFields）
 */

import * as SQLite from "expo-sqlite";
import type { VariableField, SopStep } from "../db/schema";

// ─── 类型 ────────────────────────────────────────────────────

export interface TemplateSummary {
  id: number;
  name: string;
  description: string;
  tags: string;
  use_count: number;
  created_at: string;
  step_count: number;
  kit_name: string | null;
  source_experiment_name: string | null;
  variable_fields_json: string;
  sop_steps_json: string;
  kit_id: number | null;
  reaction_template_id: number | null;
}

export interface TemplateFilter {
  tag?: string;
  kit_id?: number;
  keyword?: string;
}

// ════════════════════════════════════════════════════════════

/**
 * 保存实验为模板
 */
export async function saveAsTemplate(
  experimentId: number,
  name: string,
  description: string,
  variableFields: VariableField[],
  tags: string,
  kitId?: number | null,
  reactionTemplateId?: number | null
): Promise<number> {
  const db = await SQLite.openDatabaseAsync("labflow.db");

  // 深拷贝该实验的所有 sop_steps
  const steps = await db.getAllAsync<SopStep>(
    "SELECT step_num, title, description, duration_min, timer_required FROM sop_steps WHERE experiment_id = ? ORDER BY step_num ASC",
    [experimentId]
  );

  const sopStepsJson = JSON.stringify(
    steps.map((s) => ({
      step_num: s.step_num,
      title: s.title,
      description: s.description,
      duration_min: s.duration_min,
      timer_required: s.timer_required === 1,
    }))
  );

  const fieldsJson = JSON.stringify(variableFields);

  const result = await db.runAsync(
    `INSERT INTO experiment_templates
     (name, description, source_experiment_id, kit_id, sop_steps_json, reaction_template_id, variable_fields_json, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, description, experimentId, kitId ?? null, sopStepsJson, reactionTemplateId ?? null, fieldsJson, tags]
  );

  return result.lastInsertRowId;
}

/**
 * 实例化模板 → 创建新实验
 */
export async function instantiateTemplate(
  templateId: number,
  projectId: number | null,
  scheduledDate: string,
  variables: Record<string, string>
): Promise<{ experimentId: number; name: string }> {
  const db = await SQLite.openDatabaseAsync("labflow.db");

  const tmpl = await db.getFirstAsync<{
    name: string; sop_steps_json: string; kit_id: number | null;
    reaction_template_id: number | null;
  }>(
    "SELECT name, sop_steps_json, kit_id, reaction_template_id FROM experiment_templates WHERE id = ?",
    [templateId]
  );
  if (!tmpl) throw new Error("模板不存在");

  // 替换步骤中的 {{key}} 占位符
  let stepsJson = tmpl.sop_steps_json;
  for (const [key, value] of Object.entries(variables)) {
    const re = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    stepsJson = stepsJson.replace(re, value);
  }

  const steps: {
    step_num: number; title: string; description: string;
    duration_min: number; timer_required: boolean;
  }[] = JSON.parse(stepsJson);

  // 实验名也替换变量
  let expName = tmpl.name;
  for (const [key, value] of Object.entries(variables)) {
    expName = expName.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  // 创建实验
  const expResult = await db.runAsync(
    `INSERT INTO experiments (project_id, kit_id, reaction_template_id, name, scheduled_date, status)
     VALUES (?, ?, ?, ?, ?, 'planned')`,
    [projectId, tmpl.kit_id, tmpl.reaction_template_id, expName, scheduledDate]
  );
  const experimentId = expResult.lastInsertRowId;

  // 批量插入步骤
  for (const s of steps) {
    await db.runAsync(
      `INSERT INTO sop_steps (experiment_id, step_num, title, description, duration_min, timer_required)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [experimentId, s.step_num, s.title, s.description, s.duration_min, s.timer_required ? 1 : 0]
    );
  }

  // 增加使用次数
  await db.runAsync(
    "UPDATE experiment_templates SET use_count = use_count + 1 WHERE id = ?",
    [templateId]
  );

  return { experimentId, name: expName };
}

/**
 * 获取模板列表（支持过滤）
 */
export async function getTemplates(filter?: TemplateFilter): Promise<TemplateSummary[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  let sql = `
    SELECT
      et.*,
      k.name AS kit_name,
      e.name AS source_experiment_name,
      (SELECT COUNT(*) FROM json_each(et.sop_steps_json)) AS step_count
    FROM experiment_templates et
    LEFT JOIN kits k ON et.kit_id = k.id
    LEFT JOIN experiments e ON et.source_experiment_id = e.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (filter?.keyword) {
    sql += " AND (et.name LIKE ? OR et.description LIKE ? OR et.tags LIKE ?)";
    const kw = `%${filter.keyword}%`;
    params.push(kw, kw, kw);
  }
  if (filter?.tag) {
    sql += " AND et.tags LIKE ?";
    params.push(`%${filter.tag}%`);
  }
  if (filter?.kit_id !== undefined) {
    sql += " AND et.kit_id = ?";
    params.push(filter.kit_id);
  }

  sql += " ORDER BY et.use_count DESC, et.created_at DESC LIMIT 100";

  return await db.getAllAsync<TemplateSummary>(sql, params as any[]);
}

/**
 * 获取所有标签（去重）
 */
export async function getAllTags(): Promise<string[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const rows = await db.getAllAsync<{ tags: string }>(
    "SELECT DISTINCT tags FROM experiment_templates WHERE tags != ''"
  );
  const tagSet = new Set<string>();
  for (const r of rows) {
    r.tags.split(",").forEach((t) => {
      const trimmed = t.trim();
      if (trimmed) tagSet.add(trimmed);
    });
  }
  return Array.from(tagSet).sort();
}

/**
 * 自动检测实验步骤中的可变字段
 * 扫描描述，识别常见的参数化模式
 */
export async function detectVariableFields(
  experimentId: number
): Promise<VariableField[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const steps = await db.getAllAsync<{ title: string; description: string }>(
    "SELECT title, description FROM sop_steps WHERE experiment_id = ?",
    [experimentId]
  );

  const allText = steps.map((s) => `${s.title} ${s.description}`).join(" ");
  const fields: VariableField[] = [];

  // 检测模式
  const patterns: { regex: RegExp; key: string; label: string; type: VariableField["type"]; unit?: string }[] = [
    { regex: /(\d+(?:\.\d+)?)\s*ng\/μ[lL]/g, key: "dna_conc", label: "DNA浓度", type: "number", unit: "ng/μL" },
    { regex: /(\d+(?:\.\d+)?)\s*μ[lL]/g, key: "volume", label: "体积", type: "number", unit: "μL" },
    { regex: /(\d+)\s*管/g, key: "tube_count", label: "反应管数", type: "number", unit: "管" },
    { regex: /(\d+(?:\.\d+)?)\s*(?:mM|μM|nM)/g, key: "conc", label: "浓度", type: "number", unit: "μM" },
    { regex: /样品|样本|Sample/gi, key: "sample_name", label: "样品名称", type: "text" },
    { regex: /引物|Primer/gi, key: "primer_name", label: "引物名称", type: "text" },
    { regex: /基因|Gene|靶标/gi, key: "target_gene", label: "靶标基因", type: "text" },
  ];

  const seen = new Set<string>();
  for (const p of patterns) {
    if (seen.has(p.key)) continue;
    const match = p.regex.test(allText);
    if (match) {
      seen.add(p.key);
      // 重置 lastIndex
      p.regex.lastIndex = 0;
      const m = p.regex.exec(allText);
      const defaultValue = m ? m[1] : "";
      fields.push({
        key: p.key,
        label: p.label,
        type: p.type,
        unit: p.unit,
        default: defaultValue,
      });
    }
  }

  // 始终添加通用字段
  if (!seen.has("sample_name")) {
    fields.push({ key: "sample_name", label: "样品名称", type: "text", default: "" });
  }
  if (!seen.has("operator")) {
    fields.push({ key: "operator", label: "操作人", type: "text", default: "" });
  }

  return fields;
}
