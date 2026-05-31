import { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as SQLite from "expo-sqlite";
import AsyncStorage from "@react-native-async-storage/async-storage";

export default function SettingsScreen() {
  const [glmKey, setGlmKey] = useState("");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [showGlm, setShowGlm] = useState(false);
  const [showDeepseek, setShowDeepseek] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [g, d] = await Promise.all([
        AsyncStorage.getItem("api_key_glm"),
        AsyncStorage.getItem("api_key_deepseek"),
      ]);
      setGlmKey(g ?? "");
      setDeepseekKey(d ?? "");
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await AsyncStorage.multiSet([
        ["api_key_glm", glmKey.trim()],
        ["api_key_deepseek", deepseekKey.trim()],
      ]);
      Alert.alert("已保存", "API Key 已保存到本地设备");
    } catch (e: any) { Alert.alert("保存失败", e?.message); }
    finally { setSaving(false); }
  };

  const handleClearKeys = () => {
    Alert.alert("清除设置", "确定清除所有 API Key？", [
      { text: "取消", style: "cancel" },
      { text: "清除", style: "destructive", onPress: async () => {
        await AsyncStorage.multiRemove(["api_key_glm", "api_key_deepseek"]);
        setGlmKey(""); setDeepseekKey("");
      }},
    ]);
  };

  const handleClearAllData = () => {
    Alert.alert("⚠️ 危险操作", "这将永久删除所有项目、实验、待办、记录和 AI 规划数据！\n\n此操作不可撤销。", [
      { text: "取消", style: "cancel" },
      { text: "确认清除所有数据", style: "destructive", onPress: () => {
        Alert.alert("最终确认", "你确定要清除 LabFlow 的全部数据吗？", [
          { text: "取消", style: "cancel" },
          { text: "我确定，清除全部", style: "destructive", onPress: async () => {
            try {
              const db = await SQLite.openDatabaseAsync("labflow.db");
              const tables = ["daily_plans","record_images","records","sop_steps","experiments","todos","projects","sample_usage_logs","samples","usage_logs","kit_components","reaction_templates","experiment_templates","kits"];
              for (const t of tables) {
                try { await db.execAsync(`DELETE FROM ${t}`); } catch {}
              }
              await AsyncStorage.multiRemove(["api_key_glm", "api_key_deepseek"]);
              setGlmKey(""); setDeepseekKey("");
              Alert.alert("已清除", "所有数据已被删除");
            } catch (err: any) { Alert.alert("操作失败", err?.message ?? "请重试"); }
          }},
        ]);
      }},
    ]);
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center">
        <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-gray-900">设置</Text>
      </View>

      <ScrollView className="flex-1 px-5 pt-5" showsVerticalScrollIndicator={false}>
        <Text className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">AI 服务配置</Text>

        <View className="bg-white rounded-2xl p-5 border border-gray-100 mb-5">
          {/* GLM */}
          <View className="mb-4">
            <View className="flex-row items-center justify-between mb-1.5">
              <Text className="text-sm font-semibold text-gray-700">GLM API Key（智谱AI）</Text>
              <TouchableOpacity onPress={() => setShowGlm(!showGlm)}>
                <Ionicons name={showGlm ? "eye-off-outline" : "eye-outline"} size={18} color="#9ca3af" />
              </TouchableOpacity>
            </View>
            <TextInput className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 mb-1" placeholder="用于说明书OCR识别" placeholderTextColor="#d1d5db" value={glmKey} onChangeText={setGlmKey} secureTextEntry={!showGlm} autoCapitalize="none" autoCorrect={false} />
            <Text className="text-gray-400 text-xs">open.bigmodel.cn 获取</Text>
          </View>

          {/* DeepSeek */}
          <View className="mb-4">
            <View className="flex-row items-center justify-between mb-1.5">
              <Text className="text-sm font-semibold text-gray-700">DeepSeek API Key</Text>
              <TouchableOpacity onPress={() => setShowDeepseek(!showDeepseek)}>
                <Ionicons name={showDeepseek ? "eye-off-outline" : "eye-outline"} size={18} color="#9ca3af" />
              </TouchableOpacity>
            </View>
            <TextInput className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-800 mb-1" placeholder="用于结构化解析和AI规划" placeholderTextColor="#d1d5db" value={deepseekKey} onChangeText={setDeepseekKey} secureTextEntry={!showDeepseek} autoCapitalize="none" autoCorrect={false} />
            <Text className="text-gray-400 text-xs">platform.deepseek.com 获取</Text>
          </View>

          <Text className="text-gray-400 text-xs mb-4">API Key 仅存储在本地设备，不会上传到任何服务器。</Text>
          <View className="flex-row space-x-3">
            <TouchableOpacity className="flex-1 bg-gray-100 py-3 rounded-xl items-center" onPress={() => router.back()}>
              <Text className="text-gray-600 font-semibold text-sm">返回</Text>
            </TouchableOpacity>
            <TouchableOpacity className="flex-1 bg-primary-600 py-3 rounded-xl items-center" onPress={handleSave} disabled={saving}>
              <Text className="text-white font-semibold text-sm">{saving ? "保存中..." : "保存设置"}</Text>
            </TouchableOpacity>
          </View>
          {(glmKey || deepseekKey) ? (
            <TouchableOpacity className="mt-4 flex-row items-center justify-center" onPress={handleClearKeys}>
              <Ionicons name="trash-outline" size={16} color="#ef4444" />
              <Text className="text-red-500 text-sm ml-1">清除 API 设置</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <Text className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">数据管理</Text>
        <View className="bg-white rounded-2xl border border-gray-100 mb-5 overflow-hidden">
          <TouchableOpacity className="flex-row items-center justify-between px-5 py-4 border-b border-gray-50" onPress={() => router.push("/export")}>
            <View className="flex-row items-center"><Ionicons name="download-outline" size={20} color="#6b7280" /><Text className="text-gray-700 text-sm ml-3">数据导出中心</Text></View>
            <Ionicons name="chevron-forward" size={16} color="#d1d5db" />
          </TouchableOpacity>
          <TouchableOpacity className="flex-row items-center justify-between px-5 py-4 border-b border-gray-50" onPress={() => Alert.alert("数据库位置", "数据存储在应用内部 SQLite 数据库中 (labflow.db)")}>
            <View className="flex-row items-center"><Ionicons name="server-outline" size={20} color="#6b7280" /><Text className="text-gray-700 text-sm ml-3">数据库信息</Text></View>
            <Ionicons name="chevron-forward" size={16} color="#d1d5db" />
          </TouchableOpacity>
          <TouchableOpacity className="flex-row items-center justify-between px-5 py-4" onPress={handleClearAllData}>
            <View className="flex-row items-center"><Ionicons name="warning-outline" size={20} color="#ef4444" /><Text className="text-red-600 text-sm ml-3">清除所有数据</Text></View>
            <Ionicons name="chevron-forward" size={16} color="#d1d5db" />
          </TouchableOpacity>
        </View>

        <Text className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">关于</Text>
        <View className="bg-white rounded-2xl border border-gray-100 mb-5 overflow-hidden">
          <View className="flex-row items-center justify-between px-5 py-4 border-b border-gray-50"><Text className="text-gray-700 text-sm">版本</Text><Text className="text-gray-400 text-sm">1.0.0</Text></View>
          <View className="flex-row items-center justify-between px-5 py-4"><Text className="text-gray-700 text-sm">技术栈</Text><Text className="text-gray-400 text-xs">React Native · Expo SDK 51 · SQLite</Text></View>
        </View>
        <View className="items-center py-6"><Text className="text-gray-300 text-xs">LabFlow — 科研实验管理助手</Text></View>
      </ScrollView>
    </SafeAreaView>
  );
}
