/**
 * 试剂盒说明书解析服务
 *
 * 双模型流水线：GLM-4V (OCR → HTML) → DeepSeek (结构化解析 → JSON)
 *
 * 架构：
 *   Stage 1: GLM-4V-Plus  图片 → 带语义结构的 HTML（保留表格/列表/标题）
 *   Stage 2: DeepSeek      HTML → 解析为 ParsedKit JSON
 *
 * 设计优势：
 *   - HTML 作为中间格式：<table> 保证体系数字不错位，
 *     <ol> 保证步骤编号有序，<span class="uncertain"> 传递不确定标记
 *   - GLM-4V 专精中文文档 OCR，DeepSeek 专精结构化推理
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system";

// ─── 类型定义 ────────────────────────────────────────────────

export interface ParsedComponent {
  name: string;
  unit: string;
  qty_per_kit: string;
  storage: string;
}

export interface ParsedSopStep {
  step_num: number;
  title: string;
  description: string;
  duration_min: number;
  timer_required: boolean;
}

export interface ParsedReactionTemplate {
  name: string;
  total_vol: number;
  components: { name: string; vol_ul: number; ratio: string }[];
}

export interface ParsedKit {
  kitName: string;
  brand: string;
  components: ParsedComponent[];
  sopSteps: ParsedSopStep[];
  reactionTemplates: ParsedReactionTemplate[];
  warnings: string[];
  _ocrHtml?: string; // 调试/审核用 OCR 中间结果
}

// ─── API Key 管理 ────────────────────────────────────────────

async function getApiKeys(): Promise<{ glm: string; deepseek: string }> {
  const [glm, deepseek] = await Promise.all([
    AsyncStorage.getItem("api_key_glm"),
    AsyncStorage.getItem("api_key_deepseek"),
  ]);
  if (!glm) throw new Error("GLM API Key 未设置，请在设置页填写");
  if (!deepseek) throw new Error("DeepSeek API Key 未设置，请在设置页填写");
  return { glm, deepseek };
}

// ─── GLM-4V 调用（智谱AI，兼容 OpenAI 格式） ──────────────────

async function callGLM(
  messages: object[],
  apiKey: string,
  model = "glm-4v-plus"
): Promise<string> {
  const resp = await fetch(
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: 4096 }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GLM API 错误 ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ─── DeepSeek 调用（兼容 OpenAI 格式） ────────────────────────

async function callDeepSeek(
  messages: object[],
  apiKey: string,
  model = "deepseek-chat"
): Promise<string> {
  const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: 4096 }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`DeepSeek API 错误 ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ─── Stage 1：图片预处理 ─────────────────────────────────────

async function imageToBase64(uri: string): Promise<string> {
  return await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/** 构建 GLM 多图 content 数组 */
function buildGLMImageContent(
  base64Images: string[],
  mimeType = "image/jpeg"
): object[] {
  const content: object[] = [];
  base64Images.forEach((b64, idx) => {
    content.push({
      type: "image_url",
      image_url: { url: `data:${mimeType};base64,${b64}` },
    });
    content.push({
      type: "text",
      text: `（以上为说明书第 ${idx + 1} 页）`,
    });
  });
  return content;
}

// ─── Stage 2：GLM-4V OCR → HTML ──────────────────────────────

const GLM_OCR_SYSTEM = `你是专业的实验室试剂盒说明书OCR助手。
请将用户提供的说明书图片内容完整转录为结构化HTML，规则如下：
1. 用 <h1>/<h2>/<h3> 标记各级标题
2. 操作步骤必须用 <ol><li> 有序列表
3. 试剂盒内容物清单用 <table>，列顺序：组分名称 | 规格/数量 | 保存条件
4. 反应体系配置表也用 <table>，列顺序：组分 | 每管用量(μL) | 说明
5. 保留所有温度、时间、离心转速等数字，不要省略
6. 化学名称、货号等专有名词原样保留
7. 如果某页内容不清晰，在对应位置插入 <span class="uncertain">不确定内容</span>
8. 只输出HTML内容，不要输出任何解释文字`;

async function ocrWithGLM(
  base64Images: string[],
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  onProgress?.(`GLM-4V 正在识别 ${base64Images.length} 页说明书...`);

  const BATCH_SIZE = 8;
  const htmlChunks: string[] = [];

  for (let i = 0; i < base64Images.length; i += BATCH_SIZE) {
    const batch = base64Images.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    onProgress?.(
      `识别第 ${batchNum} 批（共 ${Math.ceil(base64Images.length / BATCH_SIZE)} 批）...`
    );

    const imageContent = buildGLMImageContent(batch);
    const messages = [
      { role: "system", content: GLM_OCR_SYSTEM },
      {
        role: "user",
        content: [
          ...imageContent,
          { type: "text", text: "请将以上说明书页面内容转为结构化HTML。" },
        ],
      },
    ];

    const html = await callGLM(messages, apiKey);
    htmlChunks.push(html);
  }

  return htmlChunks.join("\n<!-- next-batch -->\n");
}

// ─── Stage 3：DeepSeek 结构化解析 → JSON ─────────────────────

const DEEPSEEK_PARSE_SYSTEM = `你是专业的分子生物学实验助手。
用户会提供一份试剂盒说明书的HTML内容（由OCR生成）。
请从HTML中提取关键信息，严格按以下JSON格式输出，不要输出任何其他文字：

{
  "kitName": "试剂盒完整名称",
  "brand": "品牌/厂商名称",
  "components": [
    {
      "name": "组分名称",
      "unit": "单位（μL/mL/mg/U等）",
      "qty_per_kit": "每盒数量（如500μL、1000U）",
      "storage": "保存条件（如-20°C、4°C）"
    }
  ],
  "sopSteps": [
    {
      "step_num": 1,
      "title": "步骤简短标题（≤10字）",
      "description": "完整操作描述",
      "duration_min": 5,
      "timer_required": true
    }
  ],
  "reactionTemplates": [
    {
      "name": "反应体系名称（如20μL PCR体系）",
      "total_vol": 20,
      "components": [
        { "name": "组分名", "vol_ul": 10, "ratio": "1/2体积" }
      ]
    }
  ],
  "warnings": ["OCR中不确定或明显异常的内容，用自然语言描述"]
}

提取规则：
- duration_min：从描述中推断（"95°C 3min"→3，"冰上5分钟"→5，无时间信息→0）
- timer_required：涉及温度孵育/PCR循环/离心等等待步骤为true，纯操作步骤为false
- 若存在多个反应体系（20μL和50μL），分别列出
- HTML中 <span class="uncertain"> 标记的内容放入 warnings
- 组分单位统一：液体用μL或mL，粉末用mg，酶用U或ng
- 若某字段无法确定，用空字符串""而不是null`;

async function parseWithDeepSeek(
  ocrHtml: string,
  apiKey: string,
  onProgress?: (msg: string) => void
): Promise<ParsedKit> {
  onProgress?.("DeepSeek 正在解析结构化数据...");

  const truncatedHtml =
    ocrHtml.length > 12000
      ? ocrHtml.slice(0, 10000) + "\n<!-- 内容已截断 -->"
      : ocrHtml;

  const messages = [
    { role: "system", content: DEEPSEEK_PARSE_SYSTEM },
    {
      role: "user",
      content: `以下是试剂盒说明书的HTML内容，请提取结构化数据：\n\n${truncatedHtml}`,
    },
  ];

  const raw = await callDeepSeek(messages, apiKey);

  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/gi, "")
    .trim();

  let parsedRaw: unknown;
  try {
    const jsonBlock = extractJsonBlock(cleaned);
    parsedRaw = JSON.parse(jsonBlock);
  } catch (err: any) {
    const msg = err?.message ?? "";
    if (msg.includes("未找到 JSON") || msg.includes("JSON 不完整")) {
      throw new Error(`${msg} 原始返回：\n${raw.slice(0, 300)}`);
    }
    throw new Error(
      `DeepSeek 返回内容无法解析为JSON。原始返回：\n${raw.slice(0, 500)}`
    );
  }

  return normalizeParsedKit(parsedRaw);
}

// ─── JSON 提取与结构校验 ─────────────────────────────────────

/** 逐字符括号配平提取第一个完整的 JSON 对象块，防止截断/围栏残留 */
function extractJsonBlock(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) {
    throw new Error("DeepSeek 返回内容中未找到 JSON 数据块");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  throw new Error("DeepSeek 返回的 JSON 不完整（可能被截断）");
}

function toStr(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(v: unknown): boolean {
  return Boolean(v);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** 对 AI 返回的任意结构做逐字段强校验与兜底，杜绝审核页崩溃 */
function normalizeParsedKit(raw: unknown): ParsedKit {
  const obj = asRecord(raw);

  const kitName = toStr(obj.kitName);
  const componentsRaw = Array.isArray(obj.components) ? obj.components : [];
  if (!kitName && componentsRaw.length === 0) {
    throw new Error("AI 返回的数据结构异常，请重试");
  }

  const components: ParsedComponent[] = componentsRaw.map((c) => {
    const co = asRecord(c);
    return {
      name: toStr(co.name),
      unit: toStr(co.unit),
      qty_per_kit: toStr(co.qty_per_kit),
      storage: toStr(co.storage),
    };
  });

  const sopSteps: ParsedSopStep[] = (Array.isArray(obj.sopSteps) ? obj.sopSteps : [])
    .map((s) => {
      const so = asRecord(s);
      return {
        step_num: toNum(so.step_num),
        title: toStr(so.title),
        description: toStr(so.description),
        duration_min: toNum(so.duration_min, 0),
        timer_required: toBool(so.timer_required),
      };
    })
    .sort((a, b) => a.step_num - b.step_num);

  const reactionTemplates: ParsedReactionTemplate[] = (
    Array.isArray(obj.reactionTemplates) ? obj.reactionTemplates : []
  ).map((rt) => {
    const ro = asRecord(rt);
    const comps = Array.isArray(ro.components) ? ro.components : [];
    return {
      name: toStr(ro.name),
      total_vol: toNum(ro.total_vol, 0),
      components: comps.map((c) => {
        const co = asRecord(c);
        return {
          name: toStr(co.name),
          vol_ul: toNum(co.vol_ul, 0),
          ratio: toStr(co.ratio),
        };
      }),
    };
  });

  const warnings: string[] = (Array.isArray(obj.warnings) ? obj.warnings : []).map(
    (w) => toStr(w)
  );

  return { kitName, brand: toStr(obj.brand), components, sopSteps, reactionTemplates, warnings };
}

// ─── 主入口函数 ──────────────────────────────────────────────

export interface ParseOptions {
  onProgress?: (stage: string, message: string) => void;
  keepOcrHtml?: boolean;
}

/**
 * 主解析函数：图片数组 → ParsedKit
 */
export async function parseKitManual(
  imageUris: string[],
  options: ParseOptions = {}
): Promise<ParsedKit> {
  const { onProgress, keepOcrHtml = false } = options;
  const progress = (stage: string, msg: string) => onProgress?.(stage, msg);

  progress("init", "读取 API 配置...");
  const { glm, deepseek } = await getApiKeys();

  progress("preprocess", `预处理 ${imageUris.length} 张图片...`);
  const base64List = await Promise.all(imageUris.map(imageToBase64));

  const ocrHtml = await ocrWithGLM(base64List, glm, (msg) =>
    progress("ocr", msg)
  );

  const result = await parseWithDeepSeek(ocrHtml, deepseek, (msg) =>
    progress("parse", msg)
  );

  if (keepOcrHtml) {
    result._ocrHtml = ocrHtml;
  }

  progress("done", "解析完成");
  return result;
}

/**
 * 纯文字输入模式：跳过 GLM，直接用 DeepSeek 解析
 */
export async function parseKitText(
  rawText: string,
  onProgress?: (msg: string) => void
): Promise<ParsedKit> {
  onProgress?.("读取 API 配置...");
  const { deepseek } = await getApiKeys();

  const pseudoHtml = `<pre>${rawText.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
  return parseWithDeepSeek(pseudoHtml, deepseek, onProgress);
}

// ─── 辅助：PDF / 图片 读 base64 ──────────────────────────────

export async function readPDFAsBase64(uri: string): Promise<string> {
  return await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

export async function readImageAsBase64(uri: string): Promise<string> {
  return await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}
