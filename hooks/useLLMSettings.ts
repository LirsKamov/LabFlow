import { useState, useCallback, useEffect } from "react";
import {
  saveLLMSettings,
  getLLMSettings,
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

  // ── 从 SecureStore 加载（单次读取，getLLMSettings 为空即未配置） ──
  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const saved = await getLLMSettings();
      if (saved) {
        setSettings(saved);
      }
      setConfigured(saved !== null);
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
      setConfigured(updated.apiKey.length > 0);
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
      saveLLMSettings(updated).catch((err) => {
        console.error("[useLLMSettings] 保存失败:", err);
      });
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
    try {
      await saveLLMSettings(cleared);
    } catch (err) {
      console.error("[useLLMSettings] 清除失败:", err);
    }
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
