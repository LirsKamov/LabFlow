import { useState, useCallback, useEffect } from "react";
import {
  saveLLMSettings,
  getLLMSettings,
  hasLLMConfig,
  type LLMProvider,
  type LLMSettings,
} from "../services/llm";

/**
 * LLM 设置管理 Hook
 *
 * 管理 API Key、提供商选择等设置的加载/保存
 */
export function useLLMSettings() {
  const [settings, setSettings] = useState<LLMSettings>({
    provider: "anthropic",
    apiKey: "",
    model: "claude-sonnet-4-20250514",
  });
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  // ── 从 AsyncStorage 加载 ──
  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const saved = await getLLMSettings();
      if (saved) {
        setSettings(saved);
        setConfigured(true);
      }
      const has = await hasLLMConfig();
      setConfigured(has);
    } catch (err) {
      console.error("[useLLMSettings] 加载失败:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // ── 保存设置 ──
  const save = useCallback(
    async (partial: Partial<LLMSettings>): Promise<void> => {
      const updated = { ...settings, ...partial };
      await saveLLMSettings(updated);
      setSettings(updated);
      if (updated.apiKey) setConfigured(true);
    },
    [settings]
  );

  // ── 更新提供商 ──
  const setProvider = useCallback(
    (provider: LLMProvider) => {
      const defaultModels: Record<LLMProvider, string> = {
        anthropic: "claude-sonnet-4-20250514",
        deepseek: "deepseek-chat",
      };
      const updated = {
        ...settings,
        provider,
        model: defaultModels[provider],
      } as LLMSettings;
      setSettings(updated);
      saveLLMSettings(updated);
    },
    [settings]
  );

  // ── 清除设置 ──
  const clear = useCallback(async () => {
    const cleared: LLMSettings = {
      provider: "anthropic",
      apiKey: "",
      model: "claude-sonnet-4-20250514",
    };
    await saveLLMSettings(cleared);
    setSettings(cleared);
    setConfigured(false);
  }, []);

  return {
    settings,
    configured,
    loading,
    loadSettings,
    save,
    setProvider,
    clear,
  };
}
