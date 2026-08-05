/**
 * LabFlow LLM 服务
 *
 * 支持提供商：
 *  - Anthropic (Claude Sonnet 4)
 *  - DeepSeek (OpenAI 兼容协议)
 *
 * API Key 通过 SecureStore（iOS Keychain / Android Keystore）加密持久化，
 * 用户在设置页输入。旧版本存于 AsyncStorage 的值会在首次读取时自动迁移。
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Experiment, Todo } from "../db/schema";
import { getSecret, setSecret } from "../utils/secureStore";
import { todayLocal } from "../utils/date";

// ─── API 端点 ────────────────────────────────────────────────

const API_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
};

// ─── 类型定义 ────────────────────────────────────────────────

export type LLMProvider = "anthropic" | "deepseek";

export interface LLMSettings {
  provider: LLMProvider;
  apiKey: string;
  model: string;
}

export interface LLMResponse {
  success: boolean;
  content: string;
  error?: string;
}

export interface TimelineItem {
  time: string;
  task: string;
  duration_min: number;
  notes: string;
}

export interface DailyPlan {
  date: string;
  summary: string;
  timeline: TimelineItem[];
  tips: string[];
}

// ─── 设置管理 ────────────────────────────────────────────────

/** 保存 LLM 设置（供 useLLMSettings Hook 使用） */
export async function saveLLMSettings(settings: LLMSettings): Promise<void> {
  await Promise.all([
    setSecret("api_key_deepseek", settings.apiKey),
    setSecret("llm_provider", settings.provider),
    setSecret("llm_model", settings.model),
  ]);
  // 清理旧版 AsyncStorage 明文值（一次性迁移）
  try {
    await AsyncStorage.multiRemove(["api_key_deepseek", "llm_provider", "llm_model"]);
  } catch {
    /* 旧值清理失败可忽略，读取时会走回退逻辑 */
  }
}

/**
 * 读取密钥：优先 SecureStore，未命中时回退 AsyncStorage 旧值，
 * 读到旧值后写入 SecureStore 并删除 AsyncStorage 键（平滑迁移）。
 */
async function readSecretWithMigration(key: string): Promise<string | null> {
  try {
    const secured = await getSecret(key);
    if (secured !== null) return secured;
  } catch {
    /* SecureStore 不可用时回退 AsyncStorage */
  }
  try {
    const legacy = await AsyncStorage.getItem(key);
    if (legacy !== null) {
      try {
        await setSecret(key, legacy);
        await AsyncStorage.removeItem(key);
      } catch {
        /* 迁移失败不影响本次读取 */
      }
    }
    return legacy;
  } catch {
    return null;
  }
}

/** 读取 LLM 设置 */
export async function getLLMSettings(): Promise<LLMSettings | null> {
  const [apiKey, providerRaw, model] = await Promise.all([
    readSecretWithMigration("api_key_deepseek"),
    readSecretWithMigration("llm_provider"),
    readSecretWithMigration("llm_model"),
  ]);
  const provider = (providerRaw as LLMProvider) || "deepseek";
  if (!apiKey) return null;
  return { provider, apiKey, model: model || (provider === "anthropic" ? "claude-sonnet-4-20250514" : "deepseek-chat") };
}

/** 仅获取 API Key */
export async function getAPIKey(): Promise<string> {
  return (await readSecretWithMigration("api_key_deepseek")) ?? "";
}

/** 检查是否已配置 */
export async function hasLLMConfig(): Promise<boolean> {
  const key = await getAPIKey();
  return key.length > 0;
}

// ─── 通用 LLM 调用 ───────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callLLM(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number; jsonMode?: boolean }
): Promise<LLMResponse> {
  const settings = await getLLMSettings();
  if (!settings || !settings.apiKey) {
    return {
      success: false,
      content: "",
      error: "未配置 LLM API Key，请在设置中输入",
    };
  }

  const { provider, apiKey, model } = settings;

  try {
    if (provider === "anthropic") {
      return await callAnthropic(apiKey, model, messages, options);
    } else {
      return await callDeepSeek(apiKey, model, messages, options);
    }
  } catch (error: any) {
    return {
      success: false,
      content: "",
      error: error.message ?? "API 请求失败",
    };
  }
}

// ─── Anthropic API ───────────────────────────────────────────

/** 带 60 秒超时的 fetch，超时抛出 "请求超时，请重试" */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (controller.signal.aborted) {
      throw new Error("请求超时，请重试");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callAnthropic(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number; jsonMode?: boolean }
): Promise<LLMResponse> {
  // Anthropic 的 system prompt 在顶层，不在 messages 中
  const systemMsg = messages.find((m) => m.role === "system");
  const userMsgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: "user" as const, content: m.content }));

  const body: Record<string, unknown> = {
    model,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.5,
    messages: userMsgs,
  };

  if (systemMsg) {
    body.system = systemMsg.content;
  }

  // Anthropic 不支持 response_format，通过 prompt 约束 JSON

  const response = await fetchWithTimeout(API_ENDPOINTS.anthropic, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    return {
      success: false,
      content: "",
      error: `Anthropic 错误 ${response.status}: ${err}`,
    };
  }

  const data = await response.json();
  const content = data.content?.[0]?.text ?? "";
  return { success: true, content };
}

// ─── DeepSeek API (OpenAI 兼容) ──────────────────────────────

async function callDeepSeek(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number; jsonMode?: boolean }
): Promise<LLMResponse> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options?.temperature ?? 0.5,
    max_tokens: options?.maxTokens ?? 4096,
    stream: false,
  };

  if (options?.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetchWithTimeout(API_ENDPOINTS.deepseek, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    return {
      success: false,
      content: "",
      error: `DeepSeek 错误 ${response.status}: ${err}`,
    };
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  return { success: true, content };
}

// ─── 每日计划生成 ────────────────────────────────────────────

/** Prompt 模板 */
function buildDailyPlanPrompt(
  experiments: Experiment[],
  todos: Todo[],
  date: string
): { system: string; user: string } {
  // 构建实验描述
  const expDesc =
    experiments.length === 0
      ? "今天没有安排实验。"
      : experiments
          .map(
            (e, i) =>
              `${i + 1}. ${e.name}${e.scheduled_time ? ` (预定时间: ${e.scheduled_time})` : ""}${e.description ? ` — ${e.description}` : ""}`
          )
          .join("\n");

  // 构建待办描述
  const todoDesc =
    todos.length === 0
      ? "没有待办事项。"
      : todos
          .map(
            (t, i) =>
              `${i + 1}. [${t.priority === "urgent" ? "紧急" : t.priority === "high" ? "高" : t.priority === "medium" ? "中" : "低"}优先级] ${t.title}${t.due_date ? ` (截止: ${t.due_date})` : ""}`
          )
          .join("\n");

  const system = `你是一个专业的实验室科研助手，精通分子生物学、生物化学、细胞生物学等实验技术。

你的任务是根据提供的实验安排和待办事项，为研究人员规划今天（${date}）合理的工作时间表。

规划原则：
1. 考虑每个实验步骤的预估时长，在步骤间合理安排缓冲时间
2. 高优先级/紧急待办放在精力最好的时段
3. PCR 扩增、孵育、离心等等待期间可并行安排其他任务
4. 避免连续高强度实验超过 3 小时，中间穿插休息或低强度任务
5. 上午（9-12点）安排需要高度专注的实验，下午安排数据分析和文书工作
6. 实验耗材准备应放在对应实验开始前
7. 留出 12:00-13:00 午餐和 17:30 后的收尾整理时间

请以严格的 JSON 格式返回，不要包含任何其他文本：
{
  "summary": "一句话总结今天的整体安排",
  "timeline": [
    {
      "time": "09:00-09:30",
      "task": "具体任务名称",
      "duration_min": 30,
      "notes": "补充说明或注意事项"
    }
  ],
  "tips": ["实用建议1", "实用建议2", ...]
}`;

  const user = `日期：${date}

=== 今日实验 ===
${expDesc}

=== 待办事项 ===
${todoDesc}

请生成今天的详细实验工作计划。`;

  return { system, user };
}

/** 解析 LLM 返回的 JSON */
function parsePlanJSON(raw: string, date: string): DailyPlan | null {
  try {
    // 尝试提取 JSON 块
    let jsonStr = raw;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);

    // 验证必需字段
    if (!Array.isArray(parsed.timeline)) return null;
    if (!Array.isArray(parsed.tips)) parsed.tips = [];
    if (!parsed.summary) parsed.summary = "";

    return {
      date,
      summary: String(parsed.summary),
      timeline: parsed.timeline.map((item: any) => ({
        time: String(item.time ?? ""),
        task: String(item.task ?? ""),
        duration_min: Number(item.duration_min ?? 30),
        notes: String(item.notes ?? ""),
      })),
      tips: parsed.tips.map(String),
    };
  } catch {
    return null;
  }
}

/**
 * 生成每日实验计划（主函数）
 *
 * @param experiments - 今日实验列表
 * @param todos        - 全部未完成待办
 * @returns DailyPlan 或 null（失败时）
 */
export async function generateDailyPlan(
  experiments: Experiment[],
  todos: Todo[]
): Promise<{ plan: DailyPlan | null; error?: string }> {
  const today = todayLocal();
  const { system, user } = buildDailyPlanPrompt(experiments, todos, today);

  const response = await callLLM(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.5, maxTokens: 4096, jsonMode: true }
  );

  if (!response.success) {
    return { plan: null, error: response.error };
  }

  const plan = parsePlanJSON(response.content, today);
  if (!plan) {
    return { plan: null, error: "无法解析 AI 返回的计划数据，请重试" };
  }

  return { plan };
}

/**
 * 获取实验步骤建议
 */
export async function getExperimentSuggestions(
  experimentName: string,
  description: string
): Promise<LLMResponse> {
  const systemPrompt = `你是一个经验丰富的科研人员，请为以下实验提供详细的 SOP 步骤建议。
返回格式（严格遵守 JSON）：
{
  "steps": [
    {
      "step_num": 1,
      "title": "步骤标题",
      "description": "详细说明",
      "duration_min": 15,
      "timer_required": true
    }
  ],
  "safety_notes": ["注意事项1"]
}`;

  return callLLM(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `实验名称：${experimentName}\n描述：${description}`,
      },
    ],
    { temperature: 0.5, jsonMode: true }
  );
}
