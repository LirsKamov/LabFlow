import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as SQLite from "expo-sqlite";
import { useFocusEffect, router } from "expo-router";
import type { Todo, Experiment } from "../../db/schema";
import { useDailyPlan } from "../../hooks/useDailyPlan";
import { useLLMSettings } from "../../hooks/useLLMSettings";
import type { DailyPlan } from "../../services/llm";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const PRIORITY_CONFIG: Record<string, { label: string; cls: string }> = {
  urgent: { label: "紧急", cls: "text-red-600 bg-red-50" },
  high: { label: "高", cls: "text-orange-600 bg-orange-50" },
  medium: { label: "中", cls: "text-yellow-600 bg-yellow-50" },
  low: { label: "低", cls: "text-green-600 bg-green-50" },
};

// ─── Sub-components ──────────────────────────────────────────

function QuickAction({
  icon, label, color, onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string; color: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity className="flex-1 items-center py-3" activeOpacity={0.7} onPress={onPress}>
      <View className={`w-11 h-11 rounded-2xl items-center justify-center mb-1.5 ${color}`}>
        <Ionicons name={icon} size={22} color="white" />
      </View>
      <Text className="text-xs font-medium text-gray-600">{label}</Text>
    </TouchableOpacity>
  );
}

function TimelineCard({ item, isLast }: { item: DailyPlan["timeline"][0]; isLast: boolean }) {
  return (
    <View className="flex-row">
      <View className="items-center mr-3">
        <View className="w-8 h-8 rounded-full bg-primary-100 items-center justify-center">
          <Ionicons name="time" size={15} color="#3b82f6" />
        </View>
        {!isLast && <View className="w-0.5 flex-1 bg-gray-200 my-0.5" />}
      </View>
      <View className="flex-1 pb-3">
        <View className="flex-row items-center">
          <Text className="text-xs font-bold text-primary-600 bg-primary-50 px-2 py-0.5 rounded-md">{item.time}</Text>
          <Text className="text-gray-400 text-xs ml-2">{item.duration_min}min</Text>
        </View>
        <Text className="text-sm font-semibold text-gray-800 mt-1">{item.task}</Text>
        {item.notes ? <Text className="text-gray-400 text-xs mt-0.5">{item.notes}</Text> : null}
      </View>
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────

export default function TodayScreen() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [summary, setSummary] = useState({ todoCount: 0, todoDone: 0, experimentCount: 0, highPriorityCount: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { plan, loading: planLoading, generating, error: planError, loadTodayPlan, generate, clearPlan } = useDailyPlan();
  const { configured } = useLLMSettings();

  const loadData = useCallback(async () => {
    setLoadError(null);
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const today = new Date().toISOString().split("T")[0];
      const todoRows = await db.getAllAsync<Todo>(
        `SELECT * FROM todos WHERE done = 0 ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, due_date ASC LIMIT 20`
      );
      setTodos(todoRows);
      const expRows = await db.getAllAsync<Experiment>(
        "SELECT * FROM experiments WHERE scheduled_date = ? AND status != 'cancelled' ORDER BY scheduled_time ASC", [today]
      );
      setExperiments(expRows);
      const allTodos = await db.getAllAsync<Todo>("SELECT * FROM todos WHERE done = 0");
      const highP = allTodos.filter((t) => t.priority === "high" || t.priority === "urgent");
      setSummary({ todoCount: allTodos.length, todoDone: 0, experimentCount: expRows.length, highPriorityCount: highP.length });
    } catch (err: any) {
      console.error("[index] load error:", err);
      setLoadError(err?.message ?? "数据加载失败，下拉刷新重试");
    }
  }, []);

  useFocusEffect(useCallback(() => { loadData(); loadTodayPlan(); }, [loadData, loadTodayPlan]));

  const onRefresh = async () => { setRefreshing(true); await loadData(); await loadTodayPlan(); setRefreshing(false); };

  const toggleTodo = async (id: number, cd: 0 | 1) => {
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const nd = cd === 1 ? 0 : 1;
      await db.runAsync("UPDATE todos SET done=?, completed_at=? WHERE id=?", [nd, nd === 1 ? new Date().toISOString() : null, id]);
      await loadData();
    } catch (err: any) { Alert.alert("操作失败", err?.message ?? "请稍后重试"); }
  };

  const handleGenerate = async () => {
    if (!configured) { router.push("/settings"); return; }
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    try {
      const result = await generate(experiments, todos);
      if (!result) {
        Alert.alert("AI 规划失败", planError ?? "请检查网络和 API 配置后重试", [
          { text: "去设置", onPress: () => router.push("/settings") },
          { text: "手动安排", style: "cancel" },
        ]);
      }
    } catch (err: any) {
      const msg = err?.message ?? "";
      if (msg.includes("Network") || msg.includes("fetch") || msg.includes("network") || msg.includes("timeout")) {
        Alert.alert("网络不可用", "无法连接 AI 服务。\n\n可通过下方列表手动安排今日工作。", [
          { text: "知道了", style: "cancel" },
          { text: "重试", onPress: () => handleGenerate() },
        ]);
      } else {
        Alert.alert("AI 规划失败", msg || "未知错误", [
          { text: "取消", style: "cancel" },
          { text: "重试", onPress: () => handleGenerate() },
        ]);
      }
    }
  };

  const pCfg = (p: string) => PRIORITY_CONFIG[p] ?? PRIORITY_CONFIG.medium;
  const todayStr = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  const badge = summary.highPriorityCount > 0 ? String(summary.highPriorityCount) : null;

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <View className="bg-primary-800 px-5 pt-4 pb-5">
        <View className="flex-row items-center justify-between">
          <Text className="text-white text-2xl font-bold">LabFlow</Text>
          <TouchableOpacity className="w-9 h-9 rounded-full bg-white/15 items-center justify-center" onPress={() => router.push("/settings")}>
            <Ionicons name="settings-outline" size={20} color="white" />
          </TouchableOpacity>
        </View>
        <Text className="text-blue-200 text-sm mt-1">{todayStr}</Text>

        <View className="flex-row mt-4 space-x-3">
          <View className="flex-1 bg-white/15 rounded-xl p-3">
            <View className="flex-row items-end justify-between">
              <Text className="text-white text-2xl font-bold">{summary.todoCount}</Text>
              {badge && <View className="bg-red-500 rounded-full px-1.5 py-0.5"><Text className="text-white text-xs font-bold">{badge}</Text></View>}
            </View>
            <Text className="text-blue-200 text-xs">待办事项</Text>
          </View>
          <View className="flex-1 bg-white/15 rounded-xl p-3">
            <Text className="text-white text-2xl font-bold">{summary.experimentCount}</Text>
            <Text className="text-blue-200 text-xs">今日实验</Text>
          </View>
          <View className="flex-1 bg-white/15 rounded-xl p-3">
            <Text className="text-white text-2xl font-bold">{summary.highPriorityCount}</Text>
            <Text className="text-blue-200 text-xs">高优先级</Text>
          </View>
        </View>

        <View className="flex-row mt-4 bg-white/10 rounded-2xl py-1">
          <QuickAction icon="flask" label="开始实验" color="bg-emerald-500" onPress={() => router.push("/(tabs)/experiment")} />
          <QuickAction icon="document-text" label="新建记录" color="bg-blue-500" onPress={() => router.push("/(tabs)/records")} />
          <QuickAction icon="calculator" label="计算工具" color="bg-purple-500" onPress={() => router.push("/(tabs)/tools")} />
          <QuickAction icon="folder" label="项目" color="bg-amber-500" onPress={() => router.push("/(tabs)/projects")} />
        </View>
      </View>

      <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#2563eb"]} tintColor="#2563eb" />}>

        {loadError && (
          <View className="bg-red-50 rounded-2xl p-4 mb-4 border border-red-100 flex-row items-center">
            <Ionicons name="warning-outline" size={20} color="#ef4444" />
            <Text className="text-red-600 text-sm ml-2 flex-1">{loadError}</Text>
            <TouchableOpacity onPress={loadData}><Text className="text-red-600 font-semibold text-sm">重试</Text></TouchableOpacity>
          </View>
        )}

        <View className="flex-row items-center justify-between mb-3">
          <View className="flex-row items-center">
            <Ionicons name="sparkles" size={20} color="#8b5cf6" />
            <Text className="text-lg font-bold text-gray-800 ml-1.5">AI 今日规划</Text>
          </View>
          <View className="flex-row space-x-2">
            {plan && (
              <TouchableOpacity className="flex-row items-center bg-red-50 px-3 py-1.5 rounded-lg"
                onPress={() => Alert.alert("清除规划", "确定清除？", [{ text: "取消", style: "cancel" }, { text: "清除", style: "destructive", onPress: () => clearPlan() }])}>
                <Ionicons name="trash-outline" size={14} color="#ef4444" />
                <Text className="text-red-500 text-xs ml-1">清除</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity className={`flex-row items-center px-3 py-1.5 rounded-lg ${generating ? "bg-gray-100" : configured ? "bg-primary-100" : "bg-amber-50"}`}
              onPress={handleGenerate} disabled={generating}>
              {generating ? (
                <><ActivityIndicator size="small" color="#3b82f6" /><Text className="text-primary-600 text-xs ml-1.5 font-semibold">生成中...</Text></>
              ) : (
                <><Ionicons name={configured ? "refresh" : "key-outline"} size={14} color={configured ? "#3b82f6" : "#d97706"} />
                  <Text className={`text-xs ml-1 font-semibold ${configured ? "text-primary-600" : "text-amber-600"}`}>{configured ? "重新生成" : "配置 API"}</Text></>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {planLoading || generating ? (
          <View className="card items-center py-8 mb-4"><ActivityIndicator size="large" color="#8b5cf6" /><Text className="text-gray-400 mt-3 text-sm">{generating ? "AI 分析中..." : "加载中..."}</Text></View>
        ) : plan ? (
          <View className="mb-4">
            <View className="bg-purple-50 rounded-2xl p-4 mb-3 border border-purple-100">
              <View className="flex-row items-start"><Ionicons name="bulb" size={20} color="#8b5cf6" /><Text className="text-purple-800 text-sm font-medium ml-2 flex-1">{plan.summary || "今日计划已生成"}</Text></View>
            </View>
            <View className="bg-white rounded-2xl p-4 border border-gray-100">
              <Text className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wider">时间轴</Text>
              {plan.timeline.map((item, idx) => (<TimelineCard key={idx} item={item} isLast={idx === plan.timeline.length - 1} />))}
            </View>
            {plan.tips.length > 0 && (
              <View className="bg-white rounded-2xl p-4 mt-3 border border-gray-100">
                <View className="flex-row items-center mb-2"><Ionicons name="information-circle" size={18} color="#f59e0b" /><Text className="text-sm font-semibold text-gray-700 ml-1">AI 建议</Text></View>
                {plan.tips.map((tip, idx) => (<View key={idx} className="flex-row items-start mb-2 last:mb-0"><Text className="text-amber-500 font-bold mr-2 text-xs mt-0.5">{idx + 1}.</Text><Text className="text-gray-600 text-xs flex-1">{tip}</Text></View>))}
              </View>
            )}
          </View>
        ) : planError ? (
          <View className="card items-center py-6 mb-4 border border-red-100">
            <Ionicons name="alert-circle-outline" size={32} color="#ef4444" />
            <Text className="text-red-500 text-sm mt-2 text-center px-4">{planError}</Text>
            <TouchableOpacity className="mt-3 bg-red-50 px-4 py-2 rounded-lg" onPress={handleGenerate}><Text className="text-red-600 font-semibold text-sm">重试</Text></TouchableOpacity>
          </View>
        ) : configured ? (
          <TouchableOpacity className="card items-center py-6 mb-4 border-2 border-dashed border-primary-200" onPress={handleGenerate}>
            <View className="w-14 h-14 rounded-full bg-primary-50 items-center justify-center mb-2"><Ionicons name="sparkles" size={28} color="#3b82f6" /></View>
            <Text className="text-primary-600 font-semibold">点击生成 AI 今日规划</Text>
            <Text className="text-gray-400 text-xs mt-1">AI 将根据实验安排和待办事项智能排程</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity className="card items-center py-6 mb-4 border-2 border-dashed border-amber-200" onPress={() => router.push("/settings")}>
            <View className="w-14 h-14 rounded-full bg-amber-50 items-center justify-center mb-2"><Ionicons name="key-outline" size={28} color="#d97706" /></View>
            <Text className="text-amber-700 font-semibold">配置 LLM API Key</Text>
            <Text className="text-gray-400 text-xs mt-1 text-center px-6">支持 Anthropic Claude 或 DeepSeek 模型</Text>
          </TouchableOpacity>
        )}

        <Text className="text-lg font-bold text-gray-800 mb-3">今日实验安排</Text>
        {experiments.length === 0 ? (
          <View className="card items-center py-6 mb-4"><Ionicons name="flask-outline" size={40} color="#d1d5db" /><Text className="text-gray-400 mt-2">今日暂无实验安排</Text></View>
        ) : experiments.map((exp) => (
          <TouchableOpacity key={exp.id} className="card mb-3 flex-row items-center" activeOpacity={0.7} onPress={() => router.push("/(tabs)/experiment")}>
            <View className={`w-10 h-10 rounded-full items-center justify-center mr-3 ${exp.status === "in_progress" ? "bg-green-100" : "bg-blue-100"}`}>
              <Ionicons name="flask" size={20} color={exp.status === "in_progress" ? "#10b981" : "#3b82f6"} />
            </View>
            <View className="flex-1"><Text className="font-semibold text-gray-800">{exp.name}</Text><Text className="text-gray-500 text-sm mt-0.5">{exp.scheduled_time ?? "全天"} · {exp.status === "in_progress" ? "进行中" : "已安排"}</Text></View>
            <Ionicons name="chevron-forward" size={18} color="#d1d5db" />
          </TouchableOpacity>
        ))}

        <Text className="text-lg font-bold text-gray-800 mt-6 mb-3">待办事项</Text>
        {todos.length === 0 ? (
          <View className="card items-center py-6 mb-8"><Ionicons name="checkmark-circle-outline" size={40} color="#d1d5db" /><Text className="text-gray-400 mt-2">暂无待办事项</Text></View>
        ) : todos.map((todo) => {
          const pc = pCfg(todo.priority);
          return (
            <TouchableOpacity key={todo.id} className="card mb-2 flex-row items-center" activeOpacity={0.7} onPress={() => toggleTodo(todo.id, todo.done)}>
              <View className={`w-6 h-6 rounded-full border-2 mr-3 items-center justify-center ${todo.done === 1 ? "bg-primary-600 border-primary-600" : "border-gray-300"}`}>
                {todo.done === 1 && <Ionicons name="checkmark" size={14} color="white" />}
              </View>
              <View className="flex-1"><Text className={`font-medium ${todo.done === 1 ? "text-gray-400 line-through" : "text-gray-800"}`}>{todo.title}</Text>{todo.due_date && <Text className="text-gray-400 text-xs mt-0.5">{todo.due_date}</Text>}</View>
              <View className={`px-2 py-0.5 rounded-md ${pc.cls}`}><Text className="text-xs font-medium">{pc.label}</Text></View>
            </TouchableOpacity>
          );
        })}
        <View className="h-8" />
      </ScrollView>
    </SafeAreaView>
  );
}
