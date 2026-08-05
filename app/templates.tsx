import { useState, useCallback, useRef, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert,
  ActivityIndicator, RefreshControl, Modal, Pressable,
  LayoutAnimation, Platform, UIManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { getDb } from "../db/database";
import { toLocalDateString } from "../utils/date";
import DatePickerField from "../components/DatePickerField";
import {
  getTemplates, getAllTags, instantiateTemplate,
  saveAsTemplate, detectVariableFields,
  type TemplateSummary,
} from "../services/templateService";
import type { VariableField } from "../db/schema";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Sub-components ──────────────────────────────────────────

function TagPill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      className={`px-3 py-1.5 rounded-full mr-2 ${active ? "bg-primary-600" : "bg-gray-100"}`}
      onPress={onPress}
    >
      <Text className={`text-xs font-semibold ${active ? "text-white" : "text-gray-500"}`}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Main Screen ─────────────────────────────────────────────

export default function TemplatesScreen() {
  const params = useLocalSearchParams<{ saveFromExp?: string; expName?: string }>();
  const saveFromExpId = params.saveFromExp ? Number(params.saveFromExp) : null;

  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Instantiate bottom sheet
  const [instantiating, setInstantiating] = useState<TemplateSummary | null>(null);
  const [instProjectId, setInstProjectId] = useState<number | null>(null);
  const [instDate, setInstDate] = useState(new Date());
  const [instVars, setInstVars] = useState<Record<string, string>>({});
  const [instProjects, setInstProjects] = useState<{ id: number; name: string }[]>([]);
  const [instStepExpanded, setInstStepExpanded] = useState(false);

  // Save-as-template form (when coming from experiment)
  const [saveFormVisible, setSaveFormVisible] = useState(!!saveFromExpId);
  const [saveName, setSaveName] = useState(params.expName ?? "");
  const [saveDesc, setSaveDesc] = useState("");
  const [saveTags, setSaveTags] = useState("");
  const [saveFields, setSaveFields] = useState<VariableField[]>([]);
  const [saveFieldText, setSaveFieldText] = useState("");
  const [saveSaving, setSaveSaving] = useState(false);

  // ── Load data ──
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tmpls, allTags] = await Promise.all([
        getTemplates({ keyword: search || undefined, tag: activeTag ?? undefined }),
        getAllTags(),
      ]);
      setTemplates(tmpls);
      setTags(allTags);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [search, activeTag]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Auto-detect fields for save-as-template
  useEffect(() => {
    if (saveFromExpId) {
      detectVariableFields(saveFromExpId)
        .then(setSaveFields)
        .catch((e: any) => Alert.alert("字段检测失败", e?.message ?? "请手动输入字段"));
    }
  }, [saveFromExpId]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ── Open instantiate sheet ──
  const openInstantiate = async (tmpl: TemplateSummary) => {
    setInstantiating(tmpl);
    try {
      const fields: VariableField[] = JSON.parse(tmpl.variable_fields_json || "[]");
      const defaults: Record<string, string> = {};
      fields.forEach((f) => { defaults[f.key] = f.default ?? ""; });
      setInstVars(defaults);
    } catch { setInstVars({}); }
    // Load projects
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<{ id: number; name: string }>(
        "SELECT id, name FROM projects WHERE status = 'active' ORDER BY name"
      );
      setInstProjects(rows);
    } catch { setInstProjects([]); }
    setInstStepExpanded(false);
  };

  // ── Execute instantiate ──
  const handleInstantiate = async () => {
    if (!instantiating) return;
    try {
      // toLocalDateString 取本地时区日期（toISOString 会差一天）
      const { experimentId, name } = await instantiateTemplate(
        instantiating.id, instProjectId, toLocalDateString(instDate), instVars
      );
      Alert.alert("创建成功", `已创建实验「${name}」（ID: ${experimentId}）`, [
        { text: "查看", onPress: () => { setInstantiating(null); router.back(); } },
      ]);
    } catch (e: any) {
      Alert.alert("创建失败", e?.message ?? "请重试");
    }
  };

  // ── Save as template ──
  const handleSave = async () => {
    if (!saveFromExpId || !saveName.trim()) {
      Alert.alert("提示", "请输入模板名称");
      return;
    }
    setSaveSaving(true);
    try {
      // Parse fields from text input
      let fields: VariableField[] = saveFields;
      if (saveFieldText.trim()) {
        fields = saveFieldText.split(",").map((s) => {
          const trimmed = s.trim();
          return { key: trimmed.toLowerCase().replace(/\s+/g, "_"), label: trimmed, type: "text" as const, default: "" };
        });
      }
      await saveAsTemplate(saveFromExpId, saveName.trim(), saveDesc.trim(), fields, saveTags.trim());
      Alert.alert("保存成功", "模板已保存到模板库", [
        { text: "确定", onPress: () => { setSaveFormVisible(false); load(); } },
      ]);
    } catch (e: any) { Alert.alert("保存失败", e?.message); }
    finally { setSaveSaving(false); }
  };

  // ════════════════════════════════════════════════════════════
  // Render: Save-as-template form (overlay)
  // ════════════════════════════════════════════════════════════
  if (saveFormVisible && saveFromExpId) {
    return (
      <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
        <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center">
          <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={22} color="#374151" />
          </TouchableOpacity>
          <Text className="text-xl font-bold text-gray-900">保存为模板</Text>
        </View>
        <ScrollView className="flex-1 px-5 pt-5" showsVerticalScrollIndicator={false}>
          <Text className="text-sm font-semibold text-gray-600 mb-1.5">模板名称 *</Text>
          <TextInput className="input-field mb-4" value={saveName} onChangeText={setSaveName} placeholder="如：qPCR 标准流程" />
          <Text className="text-sm font-semibold text-gray-600 mb-1.5">描述</Text>
          <TextInput className="input-field mb-4" value={saveDesc} onChangeText={setSaveDesc} placeholder="模板用途说明" multiline />
          <Text className="text-sm font-semibold text-gray-600 mb-1.5">标签（逗号分隔）</Text>
          <TextInput className="input-field mb-4" value={saveTags} onChangeText={setSaveTags} placeholder="如：PCR, qPCR, 基因表达" />
          <Text className="text-sm font-semibold text-gray-600 mb-1.5">变量字段（逗号分隔，如：样品名, DNA浓度）</Text>
          <Text className="text-gray-400 text-xs mb-2">AI 已自动检测以下字段，可手动增删：</Text>
          {saveFields.length > 0 && (
            <View className="flex-row flex-wrap mb-3">
              {saveFields.map((f) => (
                <View key={f.key} className="bg-blue-50 rounded-full px-3 py-1 mr-2 mb-2">
                  <Text className="text-blue-700 text-xs">{f.label}{f.unit ? ` (${f.unit})` : ""}</Text>
                </View>
              ))}
            </View>
          )}
          <TextInput className="input-field mb-6" value={saveFieldText} onChangeText={setSaveFieldText} placeholder="或手动输入：样品名, DNA浓度, 操作人" />
          <TouchableOpacity className="bg-primary-600 py-4 rounded-2xl items-center mb-8" onPress={handleSave} disabled={saveSaving}>
            <Text className="text-white font-bold">{saveSaving ? "保存中..." : "保存模板"}</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════
  // Render: Template library (default)
  // ════════════════════════════════════════════════════════════
  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <View className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <View className="flex-row items-center justify-between mb-3">
          <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={22} color="#374151" />
          </TouchableOpacity>
          <Text className="text-xl font-bold text-gray-900 flex-1">实验模板库</Text>
        </View>
        {/* Search */}
        <View className="flex-row items-center bg-gray-100 rounded-xl px-3 py-2.5 mb-3">
          <Ionicons name="search-outline" size={18} color="#9ca3af" />
          <TextInput className="flex-1 ml-2 text-sm text-gray-800" placeholder="搜索模板..." placeholderTextColor="#d1d5db" value={search} onChangeText={setSearch} />
          {search.length > 0 && <TouchableOpacity onPress={() => setSearch("")}><Ionicons name="close-circle" size={18} color="#d1d5db" /></TouchableOpacity>}
        </View>
        {/* Tags */}
        {tags.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <TagPill label="全部" active={!activeTag} onPress={() => setActiveTag(null)} />
            {tags.map((t) => (
              <TagPill key={t} label={t} active={activeTag === t} onPress={() => setActiveTag(activeTag === t ? null : t)} />
            ))}
          </ScrollView>
        )}
      </View>

      <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#2563eb"]} />}>
        {loading ? <ActivityIndicator size="large" color="#3b82f6" style={{ marginTop: 40 }} /> :
          templates.length === 0 ? (
            <View className="items-center py-16">
              <Ionicons name="copy-outline" size={48} color="#d1d5db" />
              <Text className="text-gray-400 mt-3 text-lg">暂无模板</Text>
              <Text className="text-gray-300 text-sm mt-1">完成实验后可保存为模板复用</Text>
            </View>
          ) : templates.map((tmpl) => (
            <View key={tmpl.id} className="bg-white rounded-2xl p-5 mb-3 border border-gray-100">
              <Text className="font-bold text-gray-900 text-base">{tmpl.name}</Text>
              {tmpl.description ? <Text className="text-gray-400 text-xs mt-0.5">{tmpl.description}</Text> : null}
              <View className="flex-row flex-wrap mt-2 space-x-2">
                {tmpl.kit_name && <View className="bg-purple-50 rounded-md px-2 py-0.5"><Text className="text-purple-600 text-xs">{tmpl.kit_name}</Text></View>}
                {tmpl.tags.split(",").filter(Boolean).map((t) => (
                  <View key={t} className="bg-gray-100 rounded-md px-2 py-0.5"><Text className="text-gray-500 text-xs">{t.trim()}</Text></View>
                ))}
              </View>
              <View className="flex-row items-center mt-3 space-x-4">
                <Text className="text-gray-400 text-xs">{tmpl.step_count} 步</Text>
                <Text className="text-gray-400 text-xs">使用 {tmpl.use_count} 次</Text>
                <Text className="text-gray-400 text-xs">{tmpl.created_at ? tmpl.created_at.split(" ")[0] : ""}</Text>
              </View>
              <View className="flex-row mt-3 space-x-2">
                <TouchableOpacity className="flex-1 bg-gray-100 py-2.5 rounded-xl items-center" onPress={() => {
                  let stepList = "无步骤";
                  try {
                    const steps = JSON.parse(tmpl.sop_steps_json || "[]") as any[];
                    if (steps.length > 0) {
                      stepList = steps.map((s: any, i: number) => `${s.step_num ?? i + 1}. ${s.title ?? "未命名步骤"}${s.duration_min ? `（${s.duration_min}min）` : ""}`).join("\n");
                    }
                  } catch {}
                  Alert.alert("步骤预览", stepList);
                }}>
                  <Text className="text-gray-600 text-sm font-semibold">查看步骤</Text>
                </TouchableOpacity>
                <TouchableOpacity className="flex-1 bg-primary-600 py-2.5 rounded-xl items-center flex-row justify-center" onPress={() => openInstantiate(tmpl)}>
                  <Ionicons name="play" size={16} color="white" />
                  <Text className="text-white text-sm font-semibold ml-1">使用此模板</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        <View className="h-6" />
      </ScrollView>

      {/* ════════════════════════════════════════════════════════ */}
      {/* Instantiate Bottom Sheet */}
      {/* ════════════════════════════════════════════════════════ */}
      {instantiating && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setInstantiating(null)}>
          <Pressable className="flex-1 bg-black/40 justify-end" onPress={() => setInstantiating(null)}>
            <Pressable className="bg-white rounded-t-3xl px-5 pt-6 pb-10 max-h-[85%]" onPress={(e) => e.stopPropagation()}>
              <View className="w-10 h-1 bg-gray-200 rounded-full self-center mb-5" />
              <Text className="text-xl font-bold text-gray-900 mb-4">使用模板：{instantiating.name}</Text>
              <ScrollView className="max-h-[60vh]" showsVerticalScrollIndicator={false}>
                {/* 项目选择 */}
                <Text className="text-sm font-semibold text-gray-600 mb-2">关联项目</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
                  <TouchableOpacity className={`px-4 py-2 rounded-lg mr-2 ${!instProjectId ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`} onPress={() => setInstProjectId(null)}>
                    <Text className="text-xs">不关联</Text>
                  </TouchableOpacity>
                  {instProjects.map((p) => (
                    <TouchableOpacity key={p.id} className={`px-4 py-2 rounded-lg mr-2 ${instProjectId === p.id ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`} onPress={() => setInstProjectId(p.id)}>
                      <Text className="text-xs">{p.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                {instProjects.length === 0 && (
                  <Text className="text-gray-400 text-xs mb-4">暂无项目，请先创建</Text>
                )}
                {/* 日期 */}
                <DatePickerField date={instDate} onDateChange={(s) => setInstDate(new Date(s))} label="实验日期" />
                {/* 变量表单 */}
                {(() => {
                  try {
                    const fields: VariableField[] = JSON.parse(instantiating.variable_fields_json || "[]");
                    if (fields.length === 0) return null;
                    return (
                      <View className="mb-4">
                        <Text className="text-sm font-semibold text-gray-600 mb-2">填写变量</Text>
                        {fields.map((f) => (
                          <View key={f.key} className="mb-3">
                            <Text className="text-xs text-gray-500 mb-1">{f.label}{f.unit ? ` (${f.unit})` : ""}</Text>
                            <TextInput
                              className="input-field"
                              value={instVars[f.key] ?? ""}
                              onChangeText={(t) => setInstVars((p) => ({ ...p, [f.key]: t }))}
                              placeholder={f.default || f.label}
                              keyboardType={f.type === "number" ? "decimal-pad" : "default"}
                            />
                          </View>
                        ))}
                      </View>
                    );
                  } catch { return null; }
                })()}
                {/* 步骤预览 */}
                <TouchableOpacity className="flex-row items-center mb-2" onPress={() => setInstStepExpanded(!instStepExpanded)}>
                  <Ionicons name={instStepExpanded ? "chevron-up" : "chevron-down"} size={16} color="#3b82f6" />
                  <Text className="text-primary-600 text-sm ml-1">步骤预览</Text>
                </TouchableOpacity>
                {instStepExpanded && (
                  <View className="bg-gray-50 rounded-xl p-3 mb-4">
                    {(() => {
                      try {
                        const steps = JSON.parse(instantiating.sop_steps_json || "[]") as any[];
                        return steps.map((s: any, i: number) => (
                          <View key={i} className="mb-2 last:mb-0"><Text className="text-xs text-gray-600">{s.step_num}. {s.title} ({s.duration_min}min)</Text></View>
                        ));
                      } catch { return <Text className="text-xs text-gray-400">无法加载步骤</Text>; }
                    })()}
                  </View>
                )}
              </ScrollView>
              <View className="flex-row space-x-3 mt-2">
                <TouchableOpacity className="flex-1 bg-gray-100 py-3.5 rounded-xl items-center" onPress={() => setInstantiating(null)}>
                  <Text className="text-gray-600 font-semibold">取消</Text>
                </TouchableOpacity>
                <TouchableOpacity className="flex-1 bg-primary-600 py-3.5 rounded-xl items-center" onPress={handleInstantiate}>
                  <Text className="text-white font-semibold">创建实验</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </SafeAreaView>
  );
}
