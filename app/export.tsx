import { useState, useCallback } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator,
  RefreshControl, LayoutAnimation, Platform, UIManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { getDb } from "../db/database";
import {
  generateExcelExport, generateZipExport,
  shareFile, listExportedFiles, deleteExportedFile,
} from "../services/exportService";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function ExportScreen() {
  const [projects, setProjects] = useState<{ id: number; name: string }[]>([]);
  const [experiments, setExperiments] = useState<{ id: number; name: string; date: string }[]>([]);
  const [selectedProjId, setSelectedProjId] = useState<number | null>(null);
  const [selectedExpIds, setSelectedExpIds] = useState<Set<number>>(new Set());
  const [exportFiles, setExportFiles] = useState<{ name: string; path: string; size: number; date: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [includeImages, setIncludeImages] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const db = await getDb();
      const [projs, exps] = await Promise.all([
        db.getAllAsync<{ id: number; name: string }>("SELECT id, name FROM projects WHERE status = 'active' ORDER BY name"),
        db.getAllAsync<{ id: number; name: string; date: string }>("SELECT id, name, scheduled_date AS date FROM experiments WHERE status != 'cancelled' ORDER BY scheduled_date DESC LIMIT 50"),
      ]);
      setProjects(projs); setExperiments(exps);
      setExportFiles(await listExportedFiles());
    } catch (e: any) { Alert.alert("加载失败", e?.message ?? "请重试"); }
    finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggleExp = (id: number) => {
    setSelectedExpIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  // ── Export handlers ──
  // 注：单个实验 PDF 导出（handleExportPdfSingle）已删除——无 UI 入口的死代码，
  // 需要时在实验详情页直接调 generateExperimentReport（见 records.tsx）。

  const handleExportExcel = async () => {
    if (exporting) return;
    setExporting("excel");
    try {
      const path = await generateExcelExport(selectedProjId ? { projectId: selectedProjId } : "all");
      await shareFile(path);
      setExportFiles(await listExportedFiles());
    } catch (e: any) { Alert.alert("导出失败", e?.message); }
    finally { setExporting(""); }
  };

  const handleExportZip = async () => {
    if (selectedExpIds.size === 0) { Alert.alert("提示", "请选择至少一个实验"); return; }
    if (exporting) return; // 防重复点击
    setExporting("zip");
    Alert.alert("正在生成", "正在打包归档，实验较多时可能需要一段时间，请稍候…");
    try {
      const path = await generateZipExport(Array.from(selectedExpIds), includeImages);
      Alert.alert("导出完成", "归档已生成，正在调起分享…");
      await shareFile(path);
      setExportFiles(await listExportedFiles());
    } catch (e: any) { Alert.alert("导出失败", e?.message); }
    finally { setExporting(""); }
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center">
        <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color="#374151" />
        </TouchableOpacity>
        <Text className="text-xl font-bold text-gray-900">数据导出中心</Text>
      </View>

      <ScrollView className="flex-1 px-4 pt-5" showsVerticalScrollIndicator={false}>
        {loading ? <ActivityIndicator size="large" color="#3b82f6" style={{ marginTop: 60 }} /> : <>
        {/* ── Section 1: Single project ── */}
        <Text className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">单项目导出</Text>
        <View className="bg-white rounded-2xl p-5 mb-5 border border-gray-100">
          <Text className="text-sm font-semibold text-gray-600 mb-2">选择项目</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
            <TouchableOpacity className={`px-4 py-2 rounded-lg mr-2 ${!selectedProjId ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`} onPress={() => setSelectedProjId(null)}>
              <Text className="text-xs">全部实验</Text>
            </TouchableOpacity>
            {projects.map((p) => (
              <TouchableOpacity key={p.id} className={`px-4 py-2 rounded-lg mr-2 ${selectedProjId === p.id ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`} onPress={() => setSelectedProjId(p.id)}>
                <Text className="text-xs">{p.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          {projects.length === 0 && <Text className="text-gray-400 text-xs mb-3">暂无项目，导出将包含全部实验</Text>}
          <View className="flex-row space-x-3">
            <TouchableOpacity className="flex-1 bg-blue-50 py-3 rounded-xl items-center" onPress={handleExportExcel} disabled={!!exporting}>
              {exporting === "excel" ? <ActivityIndicator size="small" color="#3b82f6" /> : <><Ionicons name="grid-outline" size={18} color="#3b82f6" /><Text className="text-blue-700 text-xs font-semibold mt-1">导出 Excel</Text></>}
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Section 2: ZIP ── */}
        <Text className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">打包归档</Text>
        <View className="bg-white rounded-2xl p-5 mb-5 border border-gray-100">
          <Text className="text-sm text-gray-600 mb-3">选择要打包的实验 ({selectedExpIds.size} 已选)：</Text>
          <ScrollView className="max-h-40 mb-4">
            {experiments.map((e) => (
              <TouchableOpacity key={e.id} className="flex-row items-center py-1.5" onPress={() => toggleExp(e.id)}>
                <Ionicons name={selectedExpIds.has(e.id) ? "checkbox" : "square-outline"} size={18} color={selectedExpIds.has(e.id) ? "#3b82f6" : "#d1d5db"} />
                <Text className="text-sm text-gray-700 ml-2 flex-1">{e.name}</Text>
                <Text className="text-gray-400 text-xs">{e.date}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <Text className="text-gray-300 text-xs mb-3">最多显示最近 50 个实验</Text>
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-sm text-gray-600">包含图片</Text>
            <TouchableOpacity className={`w-12 h-6 rounded-full ${includeImages ? "bg-primary-500" : "bg-gray-300"}`} onPress={() => setIncludeImages(!includeImages)}>
              <View className={`w-5 h-5 rounded-full bg-white mt-0.5 ${includeImages ? "ml-6" : "ml-0.5"}`} />
            </TouchableOpacity>
          </View>
          <TouchableOpacity className="bg-purple-50 py-3 rounded-xl items-center" onPress={handleExportZip} disabled={!!exporting}>
            {exporting === "zip" ? <ActivityIndicator size="small" color="#8b5cf6" /> : <><Ionicons name="archive-outline" size={18} color="#8b5cf6" /><Text className="text-purple-700 text-xs font-semibold mt-1">导出 ZIP 归档</Text></>}
          </TouchableOpacity>
        </View>

        {/* ── Section 3: File history ── */}
        <Text className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">导出历史</Text>
        <View className="bg-white rounded-2xl border border-gray-100 mb-5 overflow-hidden">
          {exportFiles.length === 0 ? (
            <View className="py-8 items-center"><Ionicons name="document-outline" size={32} color="#d1d5db" /><Text className="text-gray-400 text-sm mt-2">暂无导出文件</Text></View>
          ) : exportFiles.map((f) => (
            <View key={f.path} className="flex-row items-center px-4 py-3 border-b border-gray-50 last:border-0">
              <Ionicons name={f.name.endsWith(".pdf") ? "document-text" : f.name.endsWith(".xlsx") ? "grid" : "archive"} size={20} color="#6b7280" />
              <View className="flex-1 ml-3">
                <Text className="text-sm text-gray-700" numberOfLines={1}>{f.name}</Text>
                <Text className="text-gray-400 text-xs">{formatSize(f.size)} · {f.date}</Text>
              </View>
              <TouchableOpacity className="p-2" onPress={() => shareFile(f.path)}><Ionicons name="share-outline" size={18} color="#3b82f6" /></TouchableOpacity>
              <TouchableOpacity className="p-2" onPress={() => {
                Alert.alert("删除", `删除 ${f.name}？`, [{ text: "取消", style: "cancel" }, { text: "删除", style: "destructive", onPress: async () => { await deleteExportedFile(f.path); setExportFiles(await listExportedFiles()); } }]);
              }}><Ionicons name="trash-outline" size={18} color="#ef4444" /></TouchableOpacity>
            </View>
          ))}
        </View>
        </>}

        <View className="h-6" />
      </ScrollView>
    </SafeAreaView>
  );
}
