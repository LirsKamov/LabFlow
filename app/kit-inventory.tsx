import { useState, useCallback, useRef, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  RefreshControl, LayoutAnimation, Platform, UIManager, Animated,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import {
  getKitSummaries, getKitComponents, getRemainingRuns,
  getUsageHistory, getUsageStats, adjustInventory, healthColor,
  type ComponentStock, type RemainingRuns,
} from "../services/inventoryService";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Sub-components ──────────────────────────────────────────

function HealthBar({ health }: { health: number }) {
  const animRef = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(animRef, { toValue: health, duration: 500, useNativeDriver: false }).start();
  }, [health]);
  const color = health >= 0.5 ? "#10b981" : health >= 0.2 ? "#f59e0b" : "#ef4444";
  return (
    <View className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
      <Animated.View className="h-full rounded-full" style={{ width: animRef.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }), backgroundColor: color }} />
    </View>
  );
}

// ─── Main Screen ─────────────────────────────────────────────

export default function KitInventoryScreen() {
  const [kits, setKits] = useState<Awaited<ReturnType<typeof getKitSummaries>>>([]);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [components, setComponents] = useState<ComponentStock[]>([]);
  const [runs, setRuns] = useState<RemainingRuns | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [stats, setStats] = useState<{ depletionDate: string | null; avgDailyUse: number }>({ depletionDate: null, avgDailyUse: 0 });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Manual adjust
  const [adjustComponentId, setAdjustComponentId] = useState<number | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const loadKits = useCallback(async () => {
    try { setKits(await getKitSummaries()); } catch (e) { console.error(e); }
  }, []);

  useFocusEffect(useCallback(() => { loadKits(); }, [loadKits]));

  const onRefresh = async () => { setRefreshing(true); await loadKits(); if (selectedKitId) await loadDetail(selectedKitId); setRefreshing(false); };

  const loadDetail = async (kitId: number) => {
    setLoading(true);
    try {
      const [comps, r, hist, s] = await Promise.all([
        getKitComponents(kitId), getRemainingRuns(kitId),
        getUsageHistory(kitId), getUsageStats(kitId),
      ]);
      setComponents(comps); setRuns(r); setHistory(hist);
      setStats({ depletionDate: s.depletionDate, avgDailyUse: s.avgDailyUse });
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const openKit = (id: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSelectedKitId(id);
    loadDetail(id);
  };
  const goBack = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSelectedKitId(null);
    setAdjustComponentId(null);
  };

  const handleAdjust = async () => {
    if (!adjustComponentId || !adjustDelta) return;
    const delta = parseFloat(adjustDelta);
    if (isNaN(delta)) { Alert.alert("提示", "请输入有效数量"); return; }
    try {
      await adjustInventory(adjustComponentId, delta, adjustReason || "手动调整");
      Alert.alert("已更新", delta >= 0 ? "库存已增加" : "库存已扣减");
      setAdjustComponentId(null); setAdjustDelta(""); setAdjustReason("");
      if (selectedKitId) await loadDetail(selectedKitId);
      await loadKits();
    } catch (e: any) { Alert.alert("失败", e?.message); }
  };

  // ════════════════════════════════════════════════════════════
  // Kit Detail View
  // ════════════════════════════════════════════════════════════
  if (selectedKitId !== null) {
    const kit = kits.find((k) => k.id === selectedKitId);
    return (
      <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
        <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center">
          <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={goBack}>
            <Ionicons name="arrow-back" size={22} color="#374151" />
          </TouchableOpacity>
          <View className="flex-1">
            <Text className="text-lg font-bold text-gray-900">{kit?.name ?? "试剂盒详情"}</Text>
            {kit?.brand ? <Text className="text-gray-400 text-xs">{kit.brand}</Text> : null}
          </View>
        </View>

        <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#2563eb"]} />}>

          {loading ? <ActivityIndicator size="large" color="#3b82f6" style={{ marginTop: 40 }} /> : (
            <>
              {/* Summary */}
              {runs && (
                <View className="bg-white rounded-2xl p-4 mb-4 border border-gray-100 flex-row justify-between items-center">
                  <View>
                    <Text className="text-gray-500 text-xs">预估剩余</Text>
                    <Text className="text-2xl font-bold text-gray-800">{runs.runs} <Text className="text-sm text-gray-400">次</Text></Text>
                  </View>
                  <View className="items-end">
                    <Text className="text-gray-500 text-xs">限制组分</Text>
                    <Text className="text-sm font-semibold text-amber-600">{runs.limitingComponent}</Text>
                    <Text className="text-gray-400 text-xs">每反应用 {runs.perReactionQty} μL</Text>
                  </View>
                </View>
              )}

              {/* Depletion forecast */}
              {stats.depletionDate && (
                <View className="bg-blue-50 rounded-xl p-3 mb-4 flex-row items-center">
                  <Ionicons name="calendar" size={16} color="#3b82f6" />
                  <Text className="text-blue-700 text-xs ml-2">预计 {stats.depletionDate} 耗尽（日均消耗 {stats.avgDailyUse.toFixed(1)}）</Text>
                </View>
              )}

              {/* Components */}
              <Text className="text-sm font-bold text-gray-700 mb-2">内容物库存</Text>
              {components.map((c) => {
                const hc = healthColor(c.health);
                return (
                  <View key={c.id} className="bg-white rounded-2xl p-4 mb-2 border border-gray-100">
                    <View className="flex-row items-start justify-between mb-1">
                      <View className="flex-1 mr-2">
                        <View className="flex-row items-center">
                          <Text className="font-semibold text-gray-800 text-sm">{c.name}</Text>
                          {c.isLow && <View className="bg-red-100 rounded-md px-1.5 py-0.5 ml-2"><Text className="text-red-600 text-xs font-bold">⚠ 库存偏低</Text></View>}
                        </View>
                        <Text className="text-gray-400 text-xs mt-0.5">{c.current_qty.toFixed(1)} / {c.initial_qty.toFixed(1)} {c.unit} · {c.storage_condition}</Text>
                      </View>
                      <View className={`px-2 py-0.5 rounded-md ${hc.bg}`}><Text className={`text-xs font-semibold ${hc.text}`}>{hc.label}</Text></View>
                    </View>
                    <HealthBar health={c.health} />
                    <View className="flex-row justify-between mt-1">
                      <Text className="text-gray-400 text-xs">{Math.round(c.health * 100)}%</Text>
                      <TouchableOpacity onPress={() => { setAdjustComponentId(c.id); setAdjustDelta(""); setAdjustReason(""); }}>
                        <Text className="text-primary-600 text-xs font-semibold">手动调整</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}

              {/* Usage History */}
              <Text className="text-sm font-bold text-gray-700 mt-6 mb-2">用量历史</Text>
              {history.length === 0 ? (
                <Text className="text-gray-400 text-xs py-4 text-center">暂无使用记录</Text>
              ) : history.map((h) => (
                <View key={h.id} className="bg-white rounded-xl px-4 py-3 mb-1.5 border border-gray-50">
                  <View className="flex-row justify-between">
                    <Text className="text-xs font-semibold text-gray-700">{h.component_name}</Text>
                    <Text className="text-xs text-gray-400">{h.used_at}</Text>
                  </View>
                  <Text className="text-xs text-gray-500 mt-0.5">-{h.used_qty.toFixed(1)} {h.unit} · {h.note}</Text>
                  {h.experiment_name && <Text className="text-xs text-blue-500 mt-0.5">实验: {h.experiment_name}</Text>}
                </View>
              ))}
              <View className="h-6" />
            </>
          )}
        </ScrollView>

        {/* Manual Adjust Modal */}
        {adjustComponentId !== null && (
          <View className="absolute inset-0 bg-black/40 justify-center items-center px-6">
            <View className="bg-white rounded-2xl p-5 w-full">
              <Text className="text-lg font-bold text-gray-900 mb-4">手动调整库存</Text>
              <Text className="text-sm text-gray-600 mb-2">数量（正数=补货，负数=扣减）</Text>
              <TextInput className="input-field mb-3" value={adjustDelta} onChangeText={setAdjustDelta} keyboardType="decimal-pad" placeholder="如 +100 或 -50" />
              <Text className="text-sm text-gray-600 mb-2">原因</Text>
              <TextInput className="input-field mb-4" value={adjustReason} onChangeText={setAdjustReason} placeholder="如：补货、损耗纠正" />
              <View className="flex-row space-x-3">
                <TouchableOpacity className="flex-1 bg-gray-100 py-3 rounded-xl items-center" onPress={() => setAdjustComponentId(null)}>
                  <Text className="text-gray-600 font-semibold">取消</Text>
                </TouchableOpacity>
                <TouchableOpacity className="flex-1 bg-primary-600 py-3 rounded-xl items-center" onPress={handleAdjust}>
                  <Text className="text-white font-semibold">确认调整</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════
  // Kit List View
  // ════════════════════════════════════════════════════════════
  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center justify-between">
        <View>
          <Text className="text-xl font-bold text-gray-900">试剂盒库存</Text>
          <Text className="text-gray-400 text-xs mt-0.5">{kits.length} 个试剂盒</Text>
        </View>
        <TouchableOpacity className="bg-primary-600 w-10 h-10 rounded-full items-center justify-center" onPress={() => router.push("/kit-parser")}>
          <Ionicons name="add" size={24} color="white" />
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#2563eb"]} />}>

        {kits.length === 0 ? (
          <View className="items-center py-16">
            <Ionicons name="cube-outline" size={48} color="#d1d5db" />
            <Text className="text-gray-400 mt-3 text-lg">暂无试剂盒</Text>
            <Text className="text-gray-300 text-sm mt-1">点击 + 解析说明书添加</Text>
          </View>
        ) : kits.map((kit) => {
          const hc = healthColor(kit.overallHealth);
          return (
            <TouchableOpacity key={kit.id} className="bg-white rounded-2xl p-5 mb-3 border border-gray-100" activeOpacity={0.9} onPress={() => openKit(kit.id)}>
              <View className="flex-row items-start justify-between mb-2">
                <View className="flex-1 mr-2">
                  <Text className="font-bold text-gray-900 text-base">{kit.name}</Text>
                  {kit.brand ? <Text className="text-gray-400 text-xs">{kit.brand}</Text> : null}
                </View>
                <View className={`px-2.5 py-1 rounded-lg ${hc.bg}`}><Text className={`text-xs font-bold ${hc.text}`}>{hc.label}</Text></View>
              </View>
              <View className="flex-row items-center justify-between">
                <View className="flex-row items-center space-x-3">
                  <View className="flex-row items-center"><Ionicons name="cube" size={13} color="#9ca3af" /><Text className="text-gray-400 text-xs ml-1">{kit.componentCount} 组分</Text></View>
                  <View className="flex-row items-center"><Ionicons name="repeat" size={13} color="#9ca3af" /><Text className="text-gray-400 text-xs ml-1">约 {kit.remainingRuns} 次</Text></View>
                </View>
                <Ionicons name="chevron-forward" size={16} color="#d1d5db" />
              </View>
              <View className="mt-3"><HealthBar health={kit.overallHealth} /></View>
            </TouchableOpacity>
          );
        })}
        <View className="h-6" />
      </ScrollView>
    </SafeAreaView>
  );
}
