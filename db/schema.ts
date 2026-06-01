/**
 * LabFlow 数据库 Schema
 * 使用 expo-sqlite 进行本地数据持久化
 *
 * 表结构：
 * - projects:      科研项目
 * - todos:         待办事项
 * - experiments:   实验安排
 * - sop_steps:     实验标准操作步骤
 * - records:       实验记录
 * - daily_plans:   AI 生成的每日日程
 */

// ─── 建表 SQL ───────────────────────────────────────────────

/** 项目表 */
export const CREATE_PROJECTS = `
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  description   TEXT    DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','completed','archived','paused')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

/** 待办事项表 */
export const CREATE_TODOS = `
CREATE TABLE IF NOT EXISTS todos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER,
  title         TEXT    NOT NULL,
  description   TEXT    DEFAULT '',
  due_date      TEXT,
  priority      TEXT    NOT NULL DEFAULT 'medium'
                        CHECK(priority IN ('low','medium','high','urgent')),
  done          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  completed_at  TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);
`;

/** 实验安排表 */
export const CREATE_EXPERIMENTS = `
CREATE TABLE IF NOT EXISTS experiments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER,
  kit_id          INTEGER,
  reaction_template_id INTEGER,
  name            TEXT    NOT NULL,
  description     TEXT    DEFAULT '',
  scheduled_date  TEXT    NOT NULL,
  scheduled_time  TEXT,
  status          TEXT    NOT NULL DEFAULT 'planned'
                          CHECK(status IN ('planned','in_progress','completed','cancelled','paused')),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY (kit_id)     REFERENCES kits(id)     ON DELETE SET NULL,
  FOREIGN KEY (reaction_template_id) REFERENCES reaction_templates(id) ON DELETE SET NULL
);
`;

/** 实验 SOP 步骤表 */
export const CREATE_SOP_STEPS = `
CREATE TABLE IF NOT EXISTS sop_steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id   INTEGER NOT NULL,
  step_num        INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  description     TEXT    DEFAULT '',
  duration_min    INTEGER DEFAULT 0,
  timer_required  INTEGER NOT NULL DEFAULT 0,
  notes           TEXT    DEFAULT '',
  completed       INTEGER NOT NULL DEFAULT 0,
  completed_at    TEXT,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
);
`;

/** 数据库迁移（按版本累积） — 新建数据库无需执行，保留空数组供后续可能的结构变更 */
export const MIGRATIONS: readonly string[] = [];

/** 实验记录表 */
export const CREATE_RECORDS = `
CREATE TABLE IF NOT EXISTS records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id   INTEGER,
  title           TEXT    DEFAULT '',
  content         TEXT    NOT NULL DEFAULT '',
  images_json     TEXT    DEFAULT '[]',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE SET NULL
);
`;

/** AI 日程表 */
export const CREATE_DAILY_PLANS = `
CREATE TABLE IF NOT EXISTS daily_plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT    NOT NULL UNIQUE,
  plan_json     TEXT    NOT NULL DEFAULT '{}',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

// ─── 索引 ───────────────────────────────────────────────────

export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_todos_project    ON todos(project_id);
CREATE INDEX IF NOT EXISTS idx_todos_due_date   ON todos(due_date);
CREATE INDEX IF NOT EXISTS idx_todos_done       ON todos(done);
CREATE INDEX IF NOT EXISTS idx_experiments_date ON experiments(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_experiments_proj ON experiments(project_id);
CREATE INDEX IF NOT EXISTS idx_sop_experiment   ON sop_steps(experiment_id);
CREATE INDEX IF NOT EXISTS idx_records_exp      ON records(experiment_id);
CREATE INDEX IF NOT EXISTS idx_daily_plans_date ON daily_plans(date);
`;

// ─── 全部建表语句（按依赖顺序） — 定义在所有 CREATE_* 之后 ──
// 见文件末尾

// ─── 种子数据：内置 SOP 模板 — 定义在文件末尾 ────────────
// 见文件末尾

// ─── 类型定义 ───────────────────────────────────────────────

export interface Project {
  id: number;
  name: string;
  description: string;
  status: 'active' | 'completed' | 'archived' | 'paused';
  created_at: string;
  updated_at: string;
}

export interface Todo {
  id: number;
  project_id: number | null;
  title: string;
  description: string;
  due_date: string | null;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  done: 0 | 1;
  created_at: string;
  completed_at: string | null;
}

export interface Experiment {
  id: number;
  project_id: number | null;
  kit_id: number | null;
  reaction_template_id: number | null;
  name: string;
  description: string;
  scheduled_date: string;
  scheduled_time: string | null;
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled' | 'paused';
  created_at: string;
  updated_at: string;
}

export interface SopStep {
  id: number;
  experiment_id: number;
  step_num: number;
  title: string;
  description: string;
  duration_min: number;
  timer_required: 0 | 1;
  notes: string;
  completed: 0 | 1;
  completed_at: string | null;
}

export interface Record {
  id: number;
  experiment_id: number | null;
  title: string;
  content: string;
  images_json: string;
  created_at: string;
  updated_at: string;
}

export interface DailyPlan {
  id: number;
  date: string;
  plan_json: string;
  created_at: string;
  updated_at: string;
}

// ─── 试剂盒管理 ──────────────────────────────────────────────

export interface Kit {
  id: number;
  name: string;
  brand: string;
  catalog_no: string;
  manual_pdf_path: string | null;
  parsed_at: string | null;
  created_at: string;
}

export interface KitComponent {
  id: number;
  kit_id: number;
  name: string;
  unit: string;
  initial_qty: number;
  current_qty: number;
  low_threshold: number;
  storage_condition: string;
}

export interface ReactionTemplate {
  id: number;
  kit_id: number;
  template_name: string;
  total_vol_ul: number;
  components_json: string;
  notes: string;
  source: 'parsed' | 'manual';
}

export interface UsageLog {
  id: number;
  kit_id: number;
  experiment_id: number | null;
  component_id: number;
  used_qty: number;
  unit: string;
  used_at: string;
  note: string;
}

export interface ExperimentTemplate {
  id: number;
  name: string;
  description: string;
  source_experiment_id: number | null;
  kit_id: number | null;
  sop_steps_json: string;
  reaction_template_id: number | null;
  variable_fields_json: string;
  tags: string;
  use_count: number;
  created_at: string;
}

export interface VariableField {
  key: string;
  label: string;
  type: 'text' | 'number';
  unit?: string;
  default: string;
}

export type SampleType = 'bacteria' | 'plasmid' | 'competent' | 'pcr_product' | 'rna' | 'dna' | 'protein' | 'other';

export interface Sample {
  id: number;
  name: string;
  type: SampleType;
  source_experiment_id: number | null;
  project_id: number | null;
  location_json: string;
  volume_ul: number;
  concentration: string;
  concentration_unit: string;
  storage_temp: '-80' | '-20' | '4' | 'RT';
  status: 'active' | 'depleted' | 'discarded';
  expiry_date: string | null;
  notes: string;
  created_at: string;
}

export interface SampleUsageLog {
  id: number;
  sample_id: number;
  experiment_id: number | null;
  used_volume_ul: number;
  remaining_after_ul: number;
  operation: 'use' | 'add' | 'discard' | 'transfer';
  note: string;
  created_at: string;
}

export interface Annotation {
  type: 'arrow' | 'circle' | 'rect' | 'text' | 'line';
  id: string;
  x1?: number; y1?: number; x2?: number; y2?: number;
  x?: number; y?: number; w?: number; h?: number;
  cx?: number; cy?: number; r?: number;
  text?: string;
  color: string;
  strokeWidth: number;
  fontSize?: number;
  fontWeight?: string;
  filled?: boolean;
  dashed?: boolean;
}

export interface RecordImage {
  id: number;
  record_id: number;
  original_path: string;
  annotated_path: string | null;
  annotations_json: string;
  width: number;
  height: number;
  caption: string;
  created_at: string;
  updated_at: string;
}

// ─── 试剂盒建表 ──────────────────────────────────────────────

export const CREATE_KITS = `
CREATE TABLE IF NOT EXISTS kits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  brand            TEXT    DEFAULT '',
  catalog_no       TEXT    DEFAULT '',
  manual_pdf_path  TEXT,
  parsed_at        TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

export const CREATE_KIT_COMPONENTS = `
CREATE TABLE IF NOT EXISTS kit_components (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id           INTEGER NOT NULL,
  name             TEXT    NOT NULL,
  unit             TEXT    DEFAULT 'μL',
  initial_qty      REAL    NOT NULL DEFAULT 0,
  current_qty      REAL    NOT NULL DEFAULT 0,
  low_threshold    REAL    NOT NULL DEFAULT 0,
  storage_condition TEXT   DEFAULT '',
  FOREIGN KEY (kit_id) REFERENCES kits(id) ON DELETE CASCADE
);
`;

export const CREATE_REACTION_TEMPLATES = `
CREATE TABLE IF NOT EXISTS reaction_templates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id           INTEGER NOT NULL,
  template_name    TEXT    NOT NULL,
  total_vol_ul     REAL    NOT NULL DEFAULT 20,
  components_json  TEXT    NOT NULL DEFAULT '[]',
  notes            TEXT    DEFAULT '',
  source           TEXT    NOT NULL DEFAULT 'manual' CHECK(source IN ('parsed','manual')),
  FOREIGN KEY (kit_id) REFERENCES kits(id) ON DELETE CASCADE
);
`;

export const CREATE_USAGE_LOGS = `
CREATE TABLE IF NOT EXISTS usage_logs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id           INTEGER NOT NULL,
  experiment_id    INTEGER,
  component_id     INTEGER NOT NULL,
  used_qty         REAL    NOT NULL,
  unit             TEXT    NOT NULL DEFAULT 'μL',
  used_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  note             TEXT    DEFAULT '',
  FOREIGN KEY (kit_id)        REFERENCES kits(id)        ON DELETE CASCADE,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE SET NULL,
  FOREIGN KEY (component_id)  REFERENCES kit_components(id) ON DELETE CASCADE
);
`;

// ─── 试剂盒索引 ──────────────────────────────────────────────

export const CREATE_KIT_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_kit_components_kit  ON kit_components(kit_id);
CREATE INDEX IF NOT EXISTS idx_reaction_tmpl_kit   ON reaction_templates(kit_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_kit      ON usage_logs(kit_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_comp     ON usage_logs(component_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_exp      ON usage_logs(experiment_id);
`;

// ─── 实验模板 ──────────────────────────────────────────────

export const CREATE_EXPERIMENT_TEMPLATES = `
CREATE TABLE IF NOT EXISTS experiment_templates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  description           TEXT    DEFAULT '',
  source_experiment_id  INTEGER,
  kit_id                INTEGER,
  sop_steps_json        TEXT    NOT NULL DEFAULT '[]',
  reaction_template_id  INTEGER,
  variable_fields_json  TEXT    NOT NULL DEFAULT '[]',
  tags                  TEXT    DEFAULT '',
  use_count             INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (source_experiment_id) REFERENCES experiments(id) ON DELETE SET NULL,
  FOREIGN KEY (kit_id)               REFERENCES kits(id)        ON DELETE SET NULL,
  FOREIGN KEY (reaction_template_id) REFERENCES reaction_templates(id) ON DELETE SET NULL
);
`;

export const CREATE_TEMPLATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_tmpl_tags   ON experiment_templates(tags);
CREATE INDEX IF NOT EXISTS idx_tmpl_kit    ON experiment_templates(kit_id);
CREATE INDEX IF NOT EXISTS idx_tmpl_source ON experiment_templates(source_experiment_id);
`;

// ─── 样品库 ──────────────────────────────────────────────

export const CREATE_SAMPLES = `
CREATE TABLE IF NOT EXISTS samples (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  type                  TEXT    NOT NULL DEFAULT 'other'
                                CHECK(type IN ('bacteria','plasmid','competent','pcr_product','rna','dna','protein','other')),
  source_experiment_id  INTEGER,
  project_id            INTEGER,
  location_json         TEXT    NOT NULL DEFAULT '{}',
  volume_ul             REAL    NOT NULL DEFAULT 0,
  concentration         TEXT    DEFAULT '',
  concentration_unit    TEXT    DEFAULT 'ng/μL',
  storage_temp          TEXT    NOT NULL DEFAULT '-20'
                                CHECK(storage_temp IN ('-80','-20','4','RT')),
  status                TEXT    NOT NULL DEFAULT 'active'
                                CHECK(status IN ('active','depleted','discarded')),
  expiry_date           TEXT,
  notes                 TEXT    DEFAULT '',
  created_at            TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (source_experiment_id) REFERENCES experiments(id) ON DELETE SET NULL,
  FOREIGN KEY (project_id)           REFERENCES projects(id)    ON DELETE SET NULL
);
`;

export const CREATE_SAMPLE_USAGE_LOGS = `
CREATE TABLE IF NOT EXISTS sample_usage_logs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id           INTEGER NOT NULL,
  experiment_id       INTEGER,
  used_volume_ul      REAL    NOT NULL DEFAULT 0,
  remaining_after_ul  REAL    NOT NULL,
  operation           TEXT    NOT NULL DEFAULT 'use'
                              CHECK(operation IN ('use','add','discard','transfer')),
  note                TEXT    DEFAULT '',
  created_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (sample_id)     REFERENCES samples(id)     ON DELETE CASCADE,
  FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE SET NULL
);
`;

export const CREATE_SAMPLE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_samples_type     ON samples(type);
CREATE INDEX IF NOT EXISTS idx_samples_project  ON samples(project_id);
CREATE INDEX IF NOT EXISTS idx_samples_status   ON samples(status);
CREATE INDEX IF NOT EXISTS idx_samples_storage  ON samples(storage_temp);
CREATE INDEX IF NOT EXISTS idx_sample_usage_s   ON sample_usage_logs(sample_id);
CREATE INDEX IF NOT EXISTS idx_sample_usage_e   ON sample_usage_logs(experiment_id);
`;

// ─── 图片标注 ──────────────────────────────────────────────

export const CREATE_RECORD_IMAGES = `
CREATE TABLE IF NOT EXISTS record_images (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id         INTEGER NOT NULL,
  original_path     TEXT    NOT NULL,
  annotated_path    TEXT,
  annotations_json  TEXT    NOT NULL DEFAULT '[]',
  width             INTEGER NOT NULL DEFAULT 0,
  height            INTEGER NOT NULL DEFAULT 0,
  caption           TEXT    DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
);
`;

export const CREATE_RECORD_IMAGE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_record_img_record ON record_images(record_id);
`;

// ════════════════════════════════════════════════════════════
// 聚合导出（必须在所有 CREATE_* 常量定义之后）
// ════════════════════════════════════════════════════════════

// 建表顺序严格按外键依赖层级排列：
//   L0 无FK → L1 依赖L0 → L2 依赖L0+L1 → L3 依赖L0+L1+L2
//   索引放在所有表之后
export const ALL_CREATE_STATEMENTS: readonly string[] = [
  // ── L0: 无外键的基础表 ──
  CREATE_PROJECTS,
  CREATE_KITS,
  CREATE_DAILY_PLANS,
  // ── L1: 仅依赖 L0 ──
  CREATE_TODOS,              // FK → projects
  CREATE_KIT_COMPONENTS,     // FK → kits
  // ── L2: 依赖 L0 + L1 ──
  CREATE_REACTION_TEMPLATES, // FK → kits
  CREATE_EXPERIMENTS,        // FK → projects, kits, reaction_templates
  CREATE_SAMPLES,            // FK → projects, experiments
  // ── L3: 依赖 L0 + L1 + L2 ──
  CREATE_SOP_STEPS,          // FK → experiments
  CREATE_RECORDS,            // FK → experiments
  CREATE_USAGE_LOGS,         // FK → kits, experiments, kit_components
  CREATE_EXPERIMENT_TEMPLATES,// FK → experiments, kits, reaction_templates
  CREATE_SAMPLE_USAGE_LOGS,  // FK → samples, experiments
  CREATE_RECORD_IMAGES,      // FK → records
  // ── 索引（最后创建） ──
  CREATE_INDEXES,
  CREATE_KIT_INDEXES,
  CREATE_TEMPLATE_INDEXES,
  CREATE_SAMPLE_INDEXES,
  CREATE_RECORD_IMAGE_INDEXES,
];

/** 建表后执行的迁移（允许失败 — 列可能已存在） */
export const ALL_MIGRATIONS: readonly string[] = MIGRATIONS;

/** 种子数据：内置 SOP 模板 — 暂时置空（experiment_id = 0 会违反外键约束） */
export const SEED_SOP_TEMPLATES = '';
