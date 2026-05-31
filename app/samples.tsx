import { useState, useCallback, useMemo } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  RefreshControl, Modal, Pressable, LayoutAnimation, Platform, UIManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import {
  getAllSamples, getSample, getSampleUsageLogs, getSampleLineage,
  createSample, updateVolume, updateSample, discardSample, searchSamples,
  getSamplesByType, getExperimentOptions,
  SAMPLE_TYPE_CONFIG, STORAGE_TEMP_LABELS,
  type SampleWithMeta, type SampleInput,
} from "../services/sampleService";
import type { SampleType } from "../db/schema";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const TYPE_OPTIONS: SampleType[] = ["bacteria", "plasmid", "competent", "pcr_product", "rna", "dna", "protein", "other"];

// ─── Sub-components ──────────────────────────────────────────

function TypeBadge({ type }: { type: SampleType }) {
  const cfg = SAMPLE_TYPE_CONFIG[type];
  return <View className={`px-2 py-0.5 rounded-md ${cfg.color}`}><Text className="text-xs font-semibold">{cfg.label}</Text></View>;
}

// ─── Main Screen ─────────────────────────────────────────────

export default function SamplesScreen() {
  const [samples, setSamples] = useState<SampleWithMeta[]>([]);
  const [search, setSearch] = useState("");
  const [activeType, setActiveType] = useState<SampleType | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Detail
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SampleWithMeta | null>(null);
  const [detailLogs, setDetailLogs] = useState<any[]>([]);
  const [detailLineage, setDetailLineage] = useState<any[]>([]);
  const [volDelta, setVolDelta] = useState("");
  const [volOp, setVolOp] = useState<"use" | "add">("use");
  const [volExpId, setVolExpId] = useState<number | null>(null);
  const [volNote, setVolNote] = useState("");
  const [experiments, setExperiments] = useState<{ id: number; name: string; date: string }[]>([]);

  // Edit
  const [editName, setEditName] = useState("");
  const [editConc, setEditConc] = useState("");
  const [editUnit, setEditUnit] = useState("");
  const [editLoc, setEditLoc] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // New sample form
  const [newFormVisible, setNewFormVisible] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<SampleType>("other");
  const [newVol, setNewVol] = useState("");
  const [newConc, setNewConc] = useState("");
  const [newConcUnit, setNewConcUnit] = useState("ng/μL");
  const [newLoc, setNewLoc] = useState("");
  const [newTemp, setNewTemp] = useState<"-80" | "-20" | "4" | "RT">("-20");
  const [newExpId, setNewExpId] = useState<number | null>(null);
  const [newNotes, setNewNotes] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let rows: SampleWithMeta[];
      if (search.trim()) rows = await searchSamples(search);
      else if (activeType) rows = await getSamplesByType(activeType);
      else rows = await getAllSamples();
      setSamples(rows);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [search, activeType]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ── Open Detail ──
  const openDetail = async (id: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDetailId(id);
    const [d, logs, lineage, exps] = await Promise.all([
      getSample(id), getSampleUsageLogs(id), getSampleLineage(id), getExperimentOptions(),
    ]);
    setDetail(d); setDetailLogs(logs); setDetailLineage(lineage); setExperiments(exps);
    setEditName(d?.name ?? ""); setEditConc(d?.concentration ?? ""); setEditUnit(d?.concentration_unit ?? "");
    setEditLoc(d?.location_json ?? ""); setEditNotes(d?.notes ?? "");
  };
  const closeDetail = () => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setDetailId(null); setDetail(null); };

  // ── Volume adjust ──
  const handleVolumeChange = async () => {
    if (!detail || !volDelta) return;
    const delta = parseFloat(volDelta);
    if (isNaN(delta) || delta <= 0) { Alert.alert("提示", "请输入有效数量"); return; }
    const actualDelta = volOp === "use" ? -delta : delta;
    try {
      await updateVolume(detail.id, actualDelta, volExpId, volOp, volNote || undefined);
      Alert.alert("已更新");
      setVolDelta(""); setVolNote(""); setVolExpId(null);
      openDetail(detail.id);
      load();
    } catch (e: any) { Alert.alert("失败", e?.message); }
  };

  // ── Save edits ──
  const handleSaveEdits = async () => {
    if (!detail) return;
    try {
      await updateSample(detail.id, {
        name: editName, concentration: editConc, concentration_unit: editUnit,
        location_json: editLoc, notes: editNotes,
      });
      Alert.alert("已保存");
      openDetail(detail.id);
    } catch (e: any) { Alert.alert("失败", e?.message); }
  };

  // ── Discard ──
  const handleDiscard = () => {
    if (!detail) return;
    Alert.alert("标记废弃", `确定将「${detail.name}」标记为废弃吗？`, [
      { text: "取消", style: "cancel" },
      { text: "废弃", style: "destructive", onPress: async () => { await discardSample(detail.id); closeDetail(); load(); } },
    ]);
  };

  // ── Create new sample ──
  const handleCreate = async () => {
    if (!newName.trim()) { Alert.alert("提示", "请输入样品名称"); return; }
    try {
      await createSample({
        name: newName.trim(), type: newType, volume_ul: parseFloat(newVol) || 0,
        concentration: newConc, concentration_unit: newConcUnit,
        location_json: newLoc || "{}", storage_temp: newTemp,
        source_experiment_id: newExpId, notes: newNotes,
      });
      Alert.alert("已创建");
      setNewFormVisible(false); setNewName(""); setNewVol(""); setNewConc(""); setNewNotes("");
      load();
    } catch (e: any) { Alert.alert("失败", e?.message); }
  };

  // ── Parse location ──
  const parseLoc = (json: string) => { try { return JSON.parse(json); } catch { return {}; } };

  // ════════════════════════════════════════════════════════════
  // Detail View
  // ════════════════════════════════════════════════════════════
  if (detailId && detail) {
    const loc = parseLoc(detail.location_json);
    return (
      <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
        <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center">
          <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={closeDetail}>
            <Ionicons name="arrow-back" size={22} color="#374151" />
          </TouchableOpacity>
          <View className="flex-1"><Text className="text-lg font-bold text-gray-900">{detail.name}</Text><TypeBadge type={detail.type} /></View>
        </View>
        <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}>
          {/* Basic Info (editable) */}
          <View className="bg-white rounded-2xl p-4 mb-3 border border-gray-100">
            <Text className="text-sm font-bold text-gray-700 mb-3">基本信息</Text>
            <Text className="text-xs text-gray-500 mb-1">名称</Text>
            <TextInput className="input-field mb-3" value={editName} onChangeText={setEditName} />
            <View className="flex-row space-x-2 mb-3">
              <View className="flex-1"><Text className="text-xs text-gray-500 mb-1">浓度</Text><TextInput className="input-field text-sm" value={editConc} onChangeText={setEditConc} /></View>
              <View className="w-20"><Text className="text-xs text-gray-500 mb-1">单位</Text><TextInput className="input-field text-sm" value={editUnit} onChangeText={setEditUnit} /></View>
            </View>
            <Text className="text-xs text-gray-500 mb-1">存储位置</Text>
            <TextInput className="input-field mb-3" value={editLoc} onChangeText={setEditLoc} placeholder='如 {"device":"-80°C冰箱","box":"A"}' />
            <Text className="text-xs text-gray-500 mb-1">备注</Text>
            <TextInput className="input-field mb-3" value={editNotes} onChangeText={setEditNotes} multiline />
            <TouchableOpacity className="bg-primary-600 py-2.5 rounded-xl items-center" onPress={handleSaveEdits}>
              <Text className="text-white font-semibold text-sm">保存修改</Text>
            </TouchableOpacity>
          </View>

          {/* Volume */}
          <View className="bg-white rounded-2xl p-4 mb-3 border border-gray-100">
            <Text className="text-sm font-bold text-gray-700 mb-3">剩余量：{detail.volume_ul} μL</Text>
            <View className="flex-row space-x-2 mb-2">
              <TouchableOpacity className={`flex-1 py-2 rounded-lg items-center ${volOp === "use" ? "bg-red-100" : "bg-gray-100"}`} onPress={() => setVolOp("use")}>
                <Text className={`text-xs font-semibold ${volOp === "use" ? "text-red-600" : "text-gray-500"}`}>− 使用</Text>
              </TouchableOpacity>
              <TouchableOpacity className={`flex-1 py-2 rounded-lg items-center ${volOp === "add" ? "bg-emerald-100" : "bg-gray-100"}`} onPress={() => setVolOp("add")}>
                <Text className={`text-xs font-semibold ${volOp === "add" ? "text-emerald-600" : "text-gray-500"}`}>+ 补充</Text>
              </TouchableOpacity>
            </View>
            <View className="flex-row space-x-2 mb-2">
              <TextInput className="flex-1 input-field text-sm" value={volDelta} onChangeText={setVolDelta} keyboardType="decimal-pad" placeholder="数量 μL" />
              <TextInput className="flex-1 input-field text-sm" value={volNote} onChangeText={setVolNote} placeholder="备注" />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
              {experiments.slice(0, 10).map((e) => (
                <TouchableOpacity key={e.id} className={`px-3 py-1.5 rounded-lg mr-2 ${volExpId === e.id ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`} onPress={() => setVolExpId(volExpId === e.id ? null : e.id)}>
                  <Text className="text-xs">{e.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity className="bg-primary-600 py-2.5 rounded-xl items-center" onPress={handleVolumeChange}>
              <Text className="text-white font-semibold text-sm">确认{volOp === "use" ? "扣减" : "补充"}</Text>
            </TouchableOpacity>
          </View>

          {/* Lineage */}
          {detailLineage.length > 0 && (
            <View className="bg-white rounded-2xl p-4 mb-3 border border-gray-100">
              <Text className="text-sm font-bold text-gray-700 mb-3">来源溯源</Text>
              {detailLineage.map((n, i) => (
                <View key={i} className="flex-row mb-2 last:mb-0">
                  <View className="items-center mr-3"><View className="w-2 h-2 rounded-full bg-primary-400 mt-1.5" />{i < detailLineage.length - 1 && <View className="w-0.5 flex-1 bg-gray-200" />}</View>
                  <View className="flex-1 pb-2"><Text className="text-xs font-semibold text-gray-700">{n.experimentName}</Text><Text className="text-gray-400 text-xs">{n.date}</Text></View>
                </View>
              ))}
            </View>
          )}

          {/* Usage Logs */}
          <View className="bg-white rounded-2xl p-4 mb-3 border border-gray-100">
            <Text className="text-sm font-bold text-gray-700 mb-3">使用记录</Text>
            {detailLogs.length === 0 ? <Text className="text-gray-400 text-xs">暂无记录</Text> :
              detailLogs.map((l) => (
                <View key={l.id} className="flex-row justify-between py-1.5 border-b border-gray-50 last:border-0">
                  <View className="flex-1">
                    <Text className="text-xs text-gray-700">{l.operation === "use" ? "使用" : l.operation === "add" ? "补充" : l.operation} {l.used_volume_ul} μL</Text>
                    {l.note ? <Text className="text-gray-400 text-xs">{l.note}</Text> : null}
                    {l.experiment_name ? <Text className="text-blue-500 text-xs">实验: {l.experiment_name}</Text> : null}
                  </View>
                  <Text className="text-gray-400 text-xs">{l.created_at}</Text>
                </View>
              ))}
          </View>

          <TouchableOpacity className="bg-red-50 py-3 rounded-xl items-center mb-8 border border-red-100" onPress={handleDiscard}>
            <Text className="text-red-600 font-semibold text-sm">标记废弃</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════
  // List View
  // ════════════════════════════════════════════════════════════

  // Group by storage_temp
  const grouped = useMemo(() => {
    const map: Record<string, SampleWithMeta[]> = { '-80': [], '-20': [], '4': [], 'RT': [] };
    samples.forEach((s) => { if (map[s.storage_temp]) map[s.storage_temp].push(s); });
    return Object.entries(map).filter(([, v]) => v.length > 0);
  }, [samples]);

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <View className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <View className="flex-row items-center justify-between mb-3">
          <View>
            <Text className="text-xl font-bold text-gray-900">样品库</Text>
            <Text className="text-gray-400 text-xs mt-0.5">{samples.length} 个样品</Text>
          </View>
          <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center" onPress={() => router.back()}>
            <Ionicons name="close" size={22} color="#374151" />
          </TouchableOpacity>
        </View>
        <View className="flex-row items-center bg-gray-100 rounded-xl px-3 py-2.5 mb-3">
          <Ionicons name="search-outline" size={18} color="#9ca3af" />
          <TextInput className="flex-1 ml-2 text-sm" placeholder="搜索样品名..." placeholderTextColor="#d1d5db" value={search} onChangeText={setSearch} />
          {search.length > 0 && <TouchableOpacity onPress={() => setSearch("")}><Ionicons name="close-circle" size={18} color="#d1d5db" /></TouchableOpacity>}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <TouchableOpacity className={`px-3 py-1.5 rounded-full mr-2 ${!activeType ? "bg-primary-600" : "bg-gray-100"}`} onPress={() => setActiveType(null)}>
            <Text className={`text-xs font-semibold ${!activeType ? "text-white" : "text-gray-500"}`}>全部</Text>
          </TouchableOpacity>
          {TYPE_OPTIONS.map((t) => (
            <TouchableOpacity key={t} className={`px-3 py-1.5 rounded-full mr-2 ${activeType === t ? "bg-primary-600" : "bg-gray-100"}`} onPress={() => setActiveType(activeType === t ? null : t)}>
              <Text className={`text-xs font-semibold ${activeType === t ? "text-white" : "text-gray-500"}`}>{SAMPLE_TYPE_CONFIG[t].label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#2563eb"]} />}>
        {loading ? <ActivityIndicator size="large" color="#3b82f6" style={{ marginTop: 40 }} /> :
          grouped.length === 0 ? (
            <View className="items-center py-16"><Ionicons name="flask-outline" size={48} color="#d1d5db" /><Text className="text-gray-400 mt-3">暂无样品</Text></View>
          ) : grouped.map(([temp, items]) => (
            <View key={temp} className="mb-4">
              <Text className="text-sm font-bold text-gray-500 mb-2">{STORAGE_TEMP_LABELS[temp] ?? temp} ({items.length})</Text>
              {items.map((s) => {
                const loc = parseLoc(s.location_json);
                return (
                  <TouchableOpacity key={s.id} className="bg-white rounded-2xl p-4 mb-2 border border-gray-100" activeOpacity={0.9} onPress={() => openDetail(s.id)}>
                    <View className="flex-row items-start justify-between mb-1">
                      <View className="flex-1 mr-2"><Text className="font-bold text-gray-800 text-sm">{s.name}</Text>
                        {s.source_experiment_name && <Text className="text-gray-400 text-xs">来源: {s.source_experiment_name}</Text>}
                      </View>
                      <TypeBadge type={s.type} />
                    </View>
                    <View className="flex-row items-center mt-1 space-x-3">
                      <Text className="text-gray-500 text-xs">{s.volume_ul} μL</Text>
                      {s.concentration && <Text className="text-gray-400 text-xs">{s.concentration} {s.concentration_unit}</Text>}
                    </View>
                    {loc.device && <Text className="text-gray-400 text-xs mt-1">📍 {[loc.device, loc.drawer, loc.box, loc.position].filter(Boolean).join(" → ")}</Text>}
                    <View className="h-1 bg-gray-100 rounded-full mt-2 overflow-hidden">
                      <View className="h-full bg-primary-400 rounded-full" style={{ width: `${s.volume_ul > 0 ? Math.min(100, (s.volume_ul / (s.volume_ul + 500)) * 100) : 0}%` }} />
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        <View className="h-20" />
      </ScrollView>

      {/* FAB: New Sample */}
      <TouchableOpacity className="absolute bottom-6 right-5 bg-primary-600 w-14 h-14 rounded-2xl items-center justify-center shadow-lg shadow-primary-300" onPress={() => setNewFormVisible(true)}>
        <Ionicons name="add" size={28} color="white" />
      </TouchableOpacity>

      {/* New Sample Modal */}
      <Modal visible={newFormVisible} animationType="slide" transparent onRequestClose={() => setNewFormVisible(false)}>
        <Pressable className="flex-1 bg-black/40 justify-end" onPress={() => setNewFormVisible(false)}>
          <Pressable className="bg-white rounded-t-3xl px-5 pt-6 pb-10 max-h-[85%]" onPress={(e) => e.stopPropagation()}>
            <View className="w-10 h-1 bg-gray-200 rounded-full self-center mb-5" />
            <Text className="text-xl font-bold text-gray-900 mb-4">新建样品</Text>
            <ScrollView className="max-h-[60vh]" showsVerticalScrollIndicator={false}>
              <Text className="text-sm font-semibold text-gray-600 mb-1.5">名称 *</Text>
              <TextInput className="input-field mb-4" value={newName} onChangeText={setNewName} placeholder="样品名称" />
              <Text className="text-sm font-semibold text-gray-600 mb-2">类型</Text>
              <View className="flex-row flex-wrap mb-4">
                {TYPE_OPTIONS.map((t) => (
                  <TouchableOpacity key={t} className={`px-3 py-1.5 rounded-lg mr-2 mb-2 ${newType === t ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`} onPress={() => setNewType(t)}>
                    <Text className="text-xs">{SAMPLE_TYPE_CONFIG[t].label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View className="flex-row space-x-3 mb-4">
                <View className="flex-1"><Text className="text-sm font-semibold text-gray-600 mb-1.5">剩余量 (μL)</Text><TextInput className="input-field" value={newVol} onChangeText={setNewVol} keyboardType="decimal-pad" /></View>
                <View className="flex-1"><Text className="text-sm font-semibold text-gray-600 mb-1.5">浓度</Text><TextInput className="input-field" value={newConc} onChangeText={setNewConc} /></View>
                <View className="w-20"><Text className="text-sm font-semibold text-gray-600 mb-1.5">单位</Text><TextInput className="input-field" value={newConcUnit} onChangeText={setNewConcUnit} /></View>
              </View>
              <Text className="text-sm font-semibold text-gray-600 mb-2">存储温度</Text>
              <View className="flex-row space-x-2 mb-4">
                {(["-80", "-20", "4", "RT"] as const).map((t) => (
                  <TouchableOpacity key={t} className={`flex-1 py-2 rounded-lg items-center ${newTemp === t ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`} onPress={() => setNewTemp(t)}>
                    <Text className="text-xs font-semibold">{STORAGE_TEMP_LABELS[t]}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text className="text-sm font-semibold text-gray-600 mb-1.5">存储位置</Text>
              <TextInput className="input-field mb-4" value={newLoc} onChangeText={setNewLoc} placeholder='{"device":"-80°C冰箱","box":"A"}' />
              <Text className="text-sm font-semibold text-gray-600 mb-1.5">备注</Text>
              <TextInput className="input-field mb-4" value={newNotes} onChangeText={setNewNotes} multiline />
            </ScrollView>
            <View className="flex-row space-x-3">
              <TouchableOpacity className="flex-1 bg-gray-100 py-3.5 rounded-xl items-center" onPress={() => setNewFormVisible(false)}><Text className="text-gray-600 font-semibold">取消</Text></TouchableOpacity>
              <TouchableOpacity className="flex-1 bg-primary-600 py-3.5 rounded-xl items-center" onPress={handleCreate}><Text className="text-white font-semibold">创建样品</Text></TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
