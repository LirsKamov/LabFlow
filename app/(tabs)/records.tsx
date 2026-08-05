import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  Alert,
  RefreshControl,
  Modal,
  Pressable,
  LayoutAnimation,
  Platform,
  UIManager,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { useFocusEffect } from "expo-router";
import {
  useRecords,
  type RecordWithMeta,
  type DateGroup,
  type ProjectGroup,
} from "../../hooks/useRecords";
import { router } from "expo-router";
import ImageAnnotator from "../../components/ImageAnnotator";
import { saveImage as saveRecordImage, getImagesForRecord, type RecordImage as RIImage } from "../../services/annotationService";
import { generateExperimentReport, shareFile } from "../../services/exportService";
import { deleteFileIfExists } from "../../utils/file";
import { formatDateLabel } from "../../utils/date";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── 常量 ────────────────────────────────────────────────────

const MAX_IMAGES = 6;
const IMAGE_SIZE = 72;

// ─── 分组工具（hooks 的 getDateGroups/getProjectGroups 仅作用于 hook 内部
//      单页 records；分页追加后需对完整列表分组，行为与 hooks 等价） ──

function groupByDate(list: RecordWithMeta[]): DateGroup[] {
  const groups: Record<string, RecordWithMeta[]> = {};
  for (const rec of list) {
    const key = rec.created_at?.split(" ")[0] ?? "未知日期";
    if (!groups[key]) groups[key] = [];
    groups[key].push(rec);
  }
  return Object.entries(groups).map(([date, recs]) => ({
    date,
    dateLabel: formatDateLabel(date),
    records: recs,
  }));
}

function groupByProject(list: RecordWithMeta[]): ProjectGroup[] {
  const groups: Record<string, RecordWithMeta[]> = {};
  for (const rec of list) {
    const key = rec.project_name ?? "__unassigned__";
    if (!groups[key]) groups[key] = [];
    groups[key].push(rec);
  }
  return Object.entries(groups)
    .filter(([, recs]) => recs.length > 0)
    .map(([name, recs]) => ({
      project_id: recs[0]?.project_id ?? null,
      project_name: name === "__unassigned__" ? "独立记录" : name,
      records: recs,
    }));
}

// ─── 子组件 ──────────────────────────────────────────────────

/** 时间轴节点 */
function TimelineDot({ isFirst }: { isFirst: boolean }) {
  return (
    <View className="items-center mr-3 w-8">
      <View
        className={`w-3 h-3 rounded-full border-2 ${
          isFirst ? "bg-primary-500 border-primary-500" : "bg-white border-gray-300"
        }`}
      />
      <View className="w-0.5 flex-1 bg-gray-200 my-0.5" />
    </View>
  );
}

/** 图片缩略图网格 */
function ImageGrid({ images, onPress }: { images: string[]; onPress?: (idx: number) => void }) {
  if (images.length === 0) return null;
  const displayImages = images.slice(0, 4);
  const remaining = images.length - 4;

  return (
    <View className="flex-row flex-wrap mt-2">
      {displayImages.map((uri, idx) => (
        <TouchableOpacity
          key={idx}
          className="mr-1.5 mb-1.5"
          onPress={() => onPress?.(idx)}
        >
          <Image
            source={{ uri }}
            className="w-16 h-16 rounded-lg bg-gray-100"
            resizeMode="cover"
          />
          {idx === 3 && remaining > 0 && (
            <View className="absolute inset-0 bg-black/40 rounded-lg items-center justify-center">
              <Text className="text-white font-bold text-sm">+{remaining}</Text>
            </View>
          )}
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── 主屏幕 ──────────────────────────────────────────────────

export default function RecordsScreen() {
  const {
    records,
    experimentOptions,
    loading,
    loadRecords,
    loadExperimentOptions,
    searchRecords,
    createRecord,
    deleteRecord,
    getRecordCount,
  } = useRecords();

  // ── 视图模式 ──
  type ViewMode = "timeline" | "project";
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");

  // ── 搜索 ──
  const [searchText, setSearchText] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  // ── 新建 Modal ──
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedExpId, setSelectedExpId] = useState<number | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newImages, setNewImages] = useState<string[]>([]);

  // ── 图片预览 ──
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewVisible, setPreviewVisible] = useState(false);

  // ── 标注编辑器 ──
  const [annotatorVisible, setAnnotatorVisible] = useState(false);
  const [annotatorImgId, setAnnotatorImgId] = useState(0);
  const [annotatorImgUri, setAnnotatorImgUri] = useState("");
  const [annotatorImgW, setAnnotatorImgW] = useState(400);
  const [annotatorImgH, setAnnotatorImgH] = useState(300);
  const [recordImages, setRecordImages] = useState<RIImage[]>([]);
  const [annotatedIds, setAnnotatedIds] = useState<Set<number>>(new Set());

  // ── 项目展开 ──
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set()
  );

  // ── 记录展开 ──
  const [expandedRecords, setExpandedRecords] = useState<Set<number>>(
    new Set()
  );

  // ── 下拉刷新 ──
  const [refreshing, setRefreshing] = useState(false);

  // ── 分页 ──
  const [offset, setOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // hooks 的 loadRecords 是"替换单页"语义，组件层按 id 去重合并出完整列表
  const [allRecords, setAllRecords] = useState<RecordWithMeta[]>([]);
  const lastPageRef = useRef(0);

  // ── 删除中记录 id ──
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // ── 搜索防抖 + 过期响应保护 ──
  const searchSeqRef = useRef(0);

  // 同步 hooks 单页 records 到完整列表：首页/搜索直接替换，分页按 id 合并
  useEffect(() => {
    if (lastPageRef.current === 0) {
      setAllRecords(records);
      return;
    }
    setAllRecords((prev) => {
      const map = new Map(prev.map((r) => [r.id, r]));
      for (const r of records) map.set(r.id, r);
      return Array.from(map.values());
    });
  }, [records]);

  const refreshFirstPage = useCallback(async () => {
    lastPageRef.current = 0;
    await loadRecords({ offset: 0, limit: 100 });
    setOffset(100);
    try {
      const c = await getRecordCount();
      setTotalCount(c);
    } catch { /* 计数失败不影响列表 */ }
  }, [loadRecords, getRecordCount]);

  // ── 页面聚焦 ──
  useFocusEffect(
    useCallback(() => {
      refreshFirstPage();
      loadExperimentOptions();
    }, [refreshFirstPage, loadExperimentOptions])
  );

  // ── 搜索防抖 ──
  useEffect(() => {
    const seq = ++searchSeqRef.current;
    const timer = setTimeout(() => {
      (async () => {
        try {
          lastPageRef.current = 0;
          if (searchText.trim()) {
            await searchRecords(searchText);
            if (seq !== searchSeqRef.current) return;
            setIsSearching(true);
          } else {
            await loadRecords({ offset: 0, limit: 100 });
            if (seq !== searchSeqRef.current) return;
            setOffset(100);
            setIsSearching(false);
            try {
              const c = await getRecordCount();
              if (seq !== searchSeqRef.current) return;
              setTotalCount(c);
            } catch { /* 计数失败不影响列表 */ }
          }
        } catch { /* 搜索失败保持现状 */ }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, searchRecords, loadRecords, getRecordCount]);

  // ── 加载更多 ──
  const loadMore = async () => {
    if (loadingMore || isSearching) return;
    setLoadingMore(true);
    const pageOffset = offset;
    lastPageRef.current = pageOffset;
    try {
      await loadRecords({ offset: pageOffset, limit: 100 });
      setOffset(pageOffset + 100);
    } catch (err: any) {
      Alert.alert("加载失败", err?.message ?? "请稍后重试");
    } finally {
      setLoadingMore(false);
    }
  };

  // ── 下拉刷新 ──
  const onRefresh = async () => {
    setRefreshing(true);
    await refreshFirstPage();
    await loadExperimentOptions();
    setRefreshing(false);
  };

  // ── 切换项目折叠 ──
  const projectTouchedRef = useRef(false);
  const toggleProject = (name: string) => {
    projectTouchedRef.current = true;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // ── 切换记录展开 ──
  const toggleRecord = (id: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedRecords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── 选择图片 ──
  const pickImages = async () => {
    if (newImages.length >= MAX_IMAGES) {
      Alert.alert("提示", `最多选择 ${MAX_IMAGES} 张图片`);
      return;
    }

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("权限不足", "请授予相册访问权限");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      // 安装版本 15.1.0 的 mediaTypes 类型与原生模块均为 MediaTypeOptions 枚举，
      // 字符串数组 API（'images'）属 16.x，故此处保留枚举写法
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      selectionLimit: MAX_IMAGES - newImages.length,
    });

    if (!result.canceled && result.assets.length > 0) {
      const uris: string[] = [];
      for (const asset of result.assets) {
        // 复制到应用目录确保持久化
        const filename = `record_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
        const destUri = `${FileSystem.documentDirectory}images/${filename}`;
        try {
          await FileSystem.makeDirectoryAsync(
            `${FileSystem.documentDirectory}images/`,
            { intermediates: true }
          );
          await FileSystem.copyAsync({ from: asset.uri, to: destUri });
          uris.push(destUri);
        } catch {
          // 复制失败则直接用原 URI
          uris.push(asset.uri);
        }
      }
      setNewImages((prev) => [...prev, ...uris].slice(0, MAX_IMAGES));
    }
  };

  // ── 移除图片（同时清理已复制到应用目录的文件） ──
  const removeImage = (idx: number) => {
    setNewImages((prev) => {
      const removed = prev[idx];
      if (removed && FileSystem.documentDirectory && removed.startsWith(FileSystem.documentDirectory)) {
        deleteFileIfExists(removed).catch(() => {});
      }
      return prev.filter((_, i) => i !== idx);
    });
  };

  // ── 拍照 ──
  const takePhoto = async () => {
    if (newImages.length >= MAX_IMAGES) {
      Alert.alert("提示", `最多选择 ${MAX_IMAGES} 张图片`);
      return;
    }

    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("权限不足", "请授予相机权限");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
    });

    if (!result.canceled && result.assets.length > 0) {
      const asset = result.assets[0];
      const filename = `record_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const destUri = `${FileSystem.documentDirectory}images/${filename}`;
      try {
        await FileSystem.makeDirectoryAsync(
          `${FileSystem.documentDirectory}images/`,
          { intermediates: true }
        );
        await FileSystem.copyAsync({ from: asset.uri, to: destUri });
        setNewImages((prev) => [...prev, destUri].slice(0, MAX_IMAGES));
      } catch {
        setNewImages((prev) => [...prev, asset.uri].slice(0, MAX_IMAGES));
      }
    }
  };

  // ── 提交新建记录 ──
  const submitRecord = async () => {
    if (!newContent.trim()) {
      Alert.alert("提示", "请输入实验记录内容");
      return;
    }
    try {
      const recordId = await createRecord(
        selectedExpId,
        newTitle.trim(),
        newContent.trim(),
        JSON.stringify(newImages)
      );
      // 同时保存到 record_images 表（供标注用）
      let imgFail = false;
      for (const uri of newImages) {
        try { await saveRecordImage(uri, recordId); } catch { imgFail = true; }
      }
      resetForm();
      setModalVisible(false);
      if (imgFail) {
        Alert.alert("提示", "记录已保存，但部分图片保存失败，标注功能可能不可用");
      } else {
        Alert.alert("记录已保存", "是否需要关联样品？", [
          { text: "稍后", style: "cancel" },
          { text: "管理样品", onPress: () => router.push("/samples") },
        ]);
      }
      refreshFirstPage();
    } catch (err: any) {
      Alert.alert("错误", err.message ?? "保存失败");
    }
  };

  const resetForm = () => {
    setNewTitle("");
    setNewContent("");
    setNewImages([]);
    setSelectedExpId(null);
  };

  // ── Open annotator ──
  const openAnnotator = async (img: RIImage) => {
    setAnnotatorImgId(img.id);
    setAnnotatorImgUri(img.original_path);
    setAnnotatorImgW(img.width || 400);
    setAnnotatorImgH(img.height || 300);
    setAnnotatorVisible(true);
  };

  // ── 删除记录（同步清理磁盘图片文件与 record_images 行） ──
  const handleDelete = (rec: RecordWithMeta) => {
    Alert.alert("确认删除", `确定要删除记录「${rec.title || "无标题"}」吗？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          if (deletingId !== null) return;
          setDeletingId(rec.id);
          try {
            const rimgs = await getImagesForRecord(rec.id);
            for (const img of rimgs) {
              try { await deleteFileIfExists(img.original_path); } catch {}
              if (img.annotated_path) {
                try { await deleteFileIfExists(img.annotated_path); } catch {}
              }
            }
            const jsonUris = parseImages(rec.images_json);
            for (const uri of jsonUris) {
              if (FileSystem.documentDirectory && uri.startsWith(FileSystem.documentDirectory)) {
                try { await deleteFileIfExists(uri); } catch {}
              }
            }
            await deleteRecord(rec.id);
            refreshFirstPage();
          } catch (err: any) {
            Alert.alert("错误", err.message ?? "删除失败");
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  };

  // ── 图片预览 ──
  const openPreview = (images: string[], idx: number) => {
    setPreviewImages(images);
    setPreviewIndex(idx);
    setPreviewVisible(true);
  };

  // ── 解析图片 JSON ──
  const parseImages = (json: string): string[] => {
    try { return JSON.parse(json); } catch { return []; }
  };

  // ── 渲染记录卡片 ──
  const renderRecordCard = (rec: RecordWithMeta, showDate = true) => {
    const images = parseImages(rec.images_json);
    const isExpanded = expandedRecords.has(rec.id);
    return (
      <View key={rec.id} className="mb-3">
        <TouchableOpacity
          className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm"
          activeOpacity={0.95}
          onPress={() => toggleRecord(rec.id)}
        >
          {/* 标题 + 实验标签 */}
          <View className="flex-row items-start justify-between">
            <View className="flex-1 mr-2">
              <Text className="text-sm font-bold text-gray-800" numberOfLines={1}>
                {rec.title || "无标题"}
              </Text>
              <View className="flex-row items-center mt-1 space-x-2">
                {rec.experiment_name && (
                  <View className="flex-row items-center bg-blue-50 px-2 py-0.5 rounded-md">
                    <Ionicons name="flask" size={11} color="#3b82f6" />
                    <Text className="text-blue-600 text-xs ml-1" numberOfLines={1}>
                      {rec.experiment_name}
                    </Text>
                  </View>
                )}
                {rec.project_name && (
                  <View className="flex-row items-center bg-purple-50 px-2 py-0.5 rounded-md">
                    <Text className="text-purple-500 text-xs" numberOfLines={1}>
                      {rec.project_name}
                    </Text>
                  </View>
                )}
              </View>
            </View>
            <View className="flex-row items-center">
              <TouchableOpacity className="p-1" onPress={() => {
                Alert.alert("导出", "选择导出格式", [
                  { text: "取消", style: "cancel" },
                  { text: "导出实验 PDF", onPress: async () => {
                    try { if (rec.experiment_id) { const p = await generateExperimentReport(rec.experiment_id); await shareFile(p); } else { Alert.alert("提示", "该记录未关联实验"); } } catch (e: any) { Alert.alert("失败", e?.message); }
                  }},
                ]);
              }}>
                <Ionicons name="share-outline" size={16} color="#3b82f6" />
              </TouchableOpacity>
              <TouchableOpacity className="p-1" onPress={() => handleDelete(rec)}>
                {deletingId === rec.id ? (
                  <ActivityIndicator size="small" color="#ef4444" />
                ) : (
                  <Ionicons name="trash-outline" size={16} color="#ef4444" />
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* 内容预览（折叠时） */}
          {!isExpanded && (
            <Text className="text-gray-500 text-xs mt-2" numberOfLines={2}>
              {rec.content}
            </Text>
          )}

          {/* 图片缩略图 */}
          {!isExpanded && images.length > 0 && (
            <ImageGrid
              images={images}
              onPress={(idx) => openPreview(images, idx)}
            />
          )}

          {/* 时间 */}
          <Text className="text-gray-300 text-xs mt-2">
            {rec.created_at ?? ""}
          </Text>
        </TouchableOpacity>

        {/* ── 展开详情 ── */}
        {isExpanded && (
          <View className="bg-white mx-1 rounded-b-2xl px-4 pb-4 border border-t-0 border-gray-100 -mt-1">
            <Text className="text-gray-700 text-sm leading-relaxed pt-3">
              {rec.content}
            </Text>
            {/* 完整图片展示 */}
            {images.length > 0 && (
              <View className="flex-row flex-wrap mt-3">
                {images.map((uri, idx) => (
                  <TouchableOpacity
                    key={idx}
                    className="mr-2 mb-2"
                    onPress={() => openPreview(images, idx)}
                  >
                    <Image
                      source={{ uri }}
                      className="w-20 h-20 rounded-xl bg-gray-100"
                      resizeMode="cover"
                    />
                    {/* Pencil icon to annotate */}
                    <TouchableOpacity
                      className="absolute top-0.5 right-0.5 w-5 h-5 bg-primary-500 rounded-full items-center justify-center"
                      onPress={(e) => { e.stopPropagation?.();
                        // Load record images and open annotator
                        getImagesForRecord(rec.id).then((rimgs) => {
                          if (rimgs.length > 0) {
                            openAnnotator(rimgs[Math.min(idx, rimgs.length - 1)]);
                          }
                        });
                      }}>
                      <Ionicons name="pencil" size={10} color="white" />
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Text className="text-gray-300 text-xs mt-3">
              {rec.created_at ?? ""}
              {rec.updated_at !== rec.created_at ? ` · 更新于 ${rec.updated_at}` : ""}
            </Text>
          </View>
        )}
      </View>
    );
  };

  // ════════════════════════════════════════════════════════════
  // 渲染
  // ════════════════════════════════════════════════════════════

  const dateGroups = useMemo(() => groupByDate(allRecords), [allRecords]);
  const projectGroups = useMemo(() => groupByProject(allRecords), [allRecords]);

  // ── 首次加载数据时默认展开第一个项目（用户手动折叠后不再干预） ──
  useEffect(() => {
    if (projectTouchedRef.current) return;
    setExpandedProjects((prev) => {
      if (prev.size > 0) return prev;
      const first = projectGroups[0]?.project_name;
      return first ? new Set([first]) : prev;
    });
  }, [projectGroups]);

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      {/* ── 头部 ── */}
      <View className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <View className="flex-row items-center justify-between mb-3">
          <View>
            <Text className="text-2xl font-bold text-gray-900">实验记录</Text>
            <Text className="text-gray-400 text-sm mt-0.5">
              {isSearching ? allRecords.length : totalCount || allRecords.length} 条记录
              {isSearching ? ` · 搜索中` : ""}
            </Text>
          </View>
          <TouchableOpacity
            className="bg-primary-600 w-11 h-11 rounded-2xl items-center justify-center shadow-sm shadow-primary-300"
            activeOpacity={0.8}
            onPress={() => {
              resetForm();
              setModalVisible(true);
            }}
          >
            <Ionicons name="add" size={26} color="white" />
          </TouchableOpacity>
        </View>

        {/* 搜索栏 */}
        <View className="flex-row items-center bg-gray-100 rounded-xl px-3 py-2.5 mb-3">
          <Ionicons name="search-outline" size={18} color="#9ca3af" />
          <TextInput
            className="flex-1 ml-2 text-sm text-gray-800"
            placeholder="搜索记录标题、内容、实验名..."
            placeholderTextColor="#d1d5db"
            value={searchText}
            onChangeText={setSearchText}
            returnKeyType="search"
          />
          {searchText.length > 0 && (
            <TouchableOpacity onPress={() => setSearchText("")}>
              <Ionicons name="close-circle" size={18} color="#d1d5db" />
            </TouchableOpacity>
          )}
        </View>

        {/* 视图切换 */}
        <View className="flex-row bg-gray-100 rounded-xl p-0.5">
          <TouchableOpacity
            className={`flex-1 py-2 rounded-lg items-center ${
              viewMode === "timeline" ? "bg-white shadow-sm" : ""
            }`}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setViewMode("timeline");
            }}
          >
            <View className="flex-row items-center">
              <Ionicons
                name="time-outline"
                size={15}
                color={viewMode === "timeline" ? "#3b82f6" : "#9ca3af"}
              />
              <Text
                className={`text-sm font-semibold ml-1 ${
                  viewMode === "timeline" ? "text-primary-600" : "text-gray-400"
                }`}
              >
                时间线
              </Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            className={`flex-1 py-2 rounded-lg items-center ${
              viewMode === "project" ? "bg-white shadow-sm" : ""
            }`}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setViewMode("project");
            }}
          >
            <View className="flex-row items-center">
              <Ionicons
                name="folder-outline"
                size={15}
                color={viewMode === "project" ? "#3b82f6" : "#9ca3af"}
              />
              <Text
                className={`text-sm font-semibold ml-1 ${
                  viewMode === "project" ? "text-primary-600" : "text-gray-400"
                }`}
              >
                项目
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── 内容区 ── */}
      <ScrollView
        className="flex-1 px-4 pt-4"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={["#2563eb"]}
            tintColor="#2563eb"
          />
        }
      >
        {/* 空状态 */}
        {!loading && allRecords.length === 0 && (
          <View className="items-center py-16">
            <View className="w-20 h-20 rounded-full bg-blue-50 items-center justify-center mb-4">
              <Ionicons name="document-text-outline" size={40} color="#93c5fd" />
            </View>
            <Text className="text-gray-400 text-lg font-medium">
              {isSearching ? "未找到匹配记录" : "暂无实验记录"}
            </Text>
            <Text className="text-gray-300 text-sm mt-1 text-center px-8">
              {isSearching
                ? "尝试其他关键词"
                : "点击右上角 + 添加第一条记录"}
            </Text>
          </View>
        )}

        {/* 加载中 */}
        {loading && (
          <View className="py-8 items-center">
            <ActivityIndicator size="large" color="#3b82f6" />
          </View>
        )}

        {/* ══════════════════════════════════════════════════════ */}
        {/* 时间线视图 */}
        {/* ══════════════════════════════════════════════════════ */}
        {viewMode === "timeline" &&
          dateGroups.map((group: DateGroup) => (
            <View key={group.date} className="mb-4">
              {/* 日期标题 */}
              <View className="flex-row items-center mb-2 ml-0">
                <View className="w-2 h-2 rounded-full bg-primary-500 mr-2" />
                <Text className="text-sm font-bold text-gray-700">
                  {group.dateLabel}
                </Text>
                <Text className="text-gray-400 text-xs ml-2">
                  {group.records.length} 条
                </Text>
              </View>

              {/* 记录列表（左侧时间轴） */}
              {group.records.map((rec, idx) => (
                <View key={rec.id} className="flex-row">
                  <TimelineDot isFirst={idx === 0} />
                  <View className="flex-1 -mt-1">
                    {renderRecordCard(rec, false)}
                  </View>
                </View>
              ))}

              {/* 最后一项不需要连接线，用空白填充 */}
              <View className="h-2" />
            </View>
          ))}

        {/* ══════════════════════════════════════════════════════ */}
        {/* 项目视图 */}
        {/* ══════════════════════════════════════════════════════ */}
        {viewMode === "project" &&
          projectGroups.map((group: ProjectGroup) => {
            const isOpen =
              expandedProjects.has(group.project_name);
            return (
              <View key={group.project_name} className="mb-3">
                {/* 项目标题 */}
                <TouchableOpacity
                  className="bg-white rounded-2xl p-4 border border-gray-100 flex-row items-center justify-between"
                  activeOpacity={0.9}
                  onPress={() => toggleProject(group.project_name)}
                >
                  <View className="flex-row items-center">
                    <View
                      className={`w-8 h-8 rounded-lg items-center justify-center mr-3 ${
                        group.project_id ? "bg-purple-100" : "bg-gray-100"
                      }`}
                    >
                      <Ionicons
                        name={group.project_id ? "folder" : "document-outline"}
                        size={16}
                        color={group.project_id ? "#8b5cf6" : "#9ca3af"}
                      />
                    </View>
                    <View>
                      <Text className="font-bold text-gray-800 text-sm">
                        {group.project_name}
                      </Text>
                      <Text className="text-gray-400 text-xs mt-0.5">
                        {group.records.length} 条记录
                      </Text>
                    </View>
                  </View>
                  <Ionicons
                    name={isOpen ? "chevron-up" : "chevron-down"}
                    size={18}
                    color="#d1d5db"
                  />
                </TouchableOpacity>

                {/* 展开的记录 */}
                {isOpen &&
                  group.records.map((rec) => (
                    <View key={rec.id} className="ml-4 mt-2">
                      {renderRecordCard(rec)}
                    </View>
                  ))}
              </View>
            );
          })}

        {/* 加载更多 */}
        {!isSearching && totalCount > 0 && allRecords.length < totalCount && (
          <TouchableOpacity
            className="bg-white rounded-2xl py-3.5 mb-3 items-center border border-gray-100"
            activeOpacity={0.8}
            disabled={loadingMore}
            onPress={loadMore}
          >
            {loadingMore ? (
              <ActivityIndicator size="small" color="#3b82f6" />
            ) : (
              <Text className="text-primary-600 text-sm font-semibold">
                加载更多（{allRecords.length}/{totalCount}）
              </Text>
            )}
          </TouchableOpacity>
        )}

        <View className="h-6" />
      </ScrollView>

      {/* ════════════════════════════════════════════════════════ */}
      {/* 新建记录 Modal */}
      {/* ════════════════════════════════════════════════════════ */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setModalVisible(false)}
        >
          <Pressable
            className="bg-white rounded-t-3xl px-5 pt-6 pb-10 max-h-[90%]"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="w-10 h-1 bg-gray-200 rounded-full self-center mb-5" />
            <Text className="text-xl font-bold text-gray-900 mb-5">
              新建实验记录
            </Text>

            <ScrollView
              showsVerticalScrollIndicator={false}
              className="max-h-[70vh]"
            >
              {/* 关联实验选择 */}
              <Text className="text-sm font-semibold text-gray-600 mb-2">
                关联实验（可选）
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                className="mb-4"
              >
                <TouchableOpacity
                  className={`px-4 py-2 rounded-lg mr-2 ${
                    selectedExpId === null
                      ? "bg-primary-100 border border-primary-300"
                      : "bg-gray-100"
                  }`}
                  onPress={() => setSelectedExpId(null)}
                >
                  <Text
                    className={`text-sm ${
                      selectedExpId === null
                        ? "text-primary-700 font-medium"
                        : "text-gray-500"
                    }`}
                  >
                    独立记录
                  </Text>
                </TouchableOpacity>
                {experimentOptions.map((exp) => (
                  <TouchableOpacity
                    key={exp.id}
                    className={`px-4 py-2 rounded-lg mr-2 ${
                      selectedExpId === exp.id
                        ? "bg-primary-100 border border-primary-300"
                        : "bg-gray-100"
                    }`}
                    onPress={() => setSelectedExpId(exp.id)}
                  >
                    <Text
                      className={`text-sm ${
                        selectedExpId === exp.id
                          ? "text-primary-700 font-medium"
                          : "text-gray-500"
                      }`}
                      numberOfLines={1}
                    >
                      {exp.name}
                    </Text>
                    {exp.project_name && (
                      <Text className="text-gray-400 text-xs mt-0.5">
                        {exp.project_name}
                      </Text>
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* 标题 */}
              <Text className="text-sm font-semibold text-gray-600 mb-1.5">
                记录标题
              </Text>
              <TextInput
                className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 mb-4"
                placeholder="如：WB 显影结果、PCR 产物电泳..."
                placeholderTextColor="#d1d5db"
                value={newTitle}
                onChangeText={setNewTitle}
                maxLength={200}
              />

              {/* 内容 */}
              <Text className="text-sm font-semibold text-gray-600 mb-1.5">
                内容 *
              </Text>
              <TextInput
                className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 mb-4"
                placeholder="详细描述实验过程、观察结果、数据等..."
                placeholderTextColor="#d1d5db"
                value={newContent}
                onChangeText={setNewContent}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />

              {/* 图片 */}
              <Text className="text-sm font-semibold text-gray-600 mb-2">
                附图 ({newImages.length}/{MAX_IMAGES})
              </Text>

              {/* 已选图片预览 */}
              {newImages.length > 0 && (
                <View className="flex-row flex-wrap mb-3">
                  {newImages.map((uri, idx) => (
                    <View key={idx} className="mr-2 mb-2">
                      <Image
                        source={{ uri }}
                        style={{ width: IMAGE_SIZE, height: IMAGE_SIZE }}
                        className="rounded-xl bg-gray-100"
                        resizeMode="cover"
                      />
                      <TouchableOpacity
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full items-center justify-center"
                        onPress={() => removeImage(idx)}
                      >
                        <Ionicons name="close" size={12} color="white" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              {/* 图片选择按钮 */}
              <View className="flex-row space-x-2 mb-4">
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center bg-gray-50 border border-gray-200 py-3 rounded-xl"
                  onPress={pickImages}
                >
                  <Ionicons name="images-outline" size={18} color="#6b7280" />
                  <Text className="text-gray-600 text-sm font-medium ml-1.5">
                    从相册选择
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center bg-gray-50 border border-gray-200 py-3 rounded-xl"
                  onPress={takePhoto}
                >
                  <Ionicons name="camera-outline" size={18} color="#6b7280" />
                  <Text className="text-gray-600 text-sm font-medium ml-1.5">
                    拍照
                  </Text>
                </TouchableOpacity>
              </View>
            </ScrollView>

            {/* 按钮 */}
            <View className="flex-row space-x-3 mt-2">
              <TouchableOpacity
                className="flex-1 bg-gray-100 py-3.5 rounded-xl items-center"
                onPress={() => {
                  resetForm();
                  setModalVisible(false);
                }}
              >
                <Text className="text-gray-600 font-semibold">取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                className="flex-1 bg-primary-600 py-3.5 rounded-xl items-center shadow-sm shadow-primary-300"
                onPress={submitRecord}
              >
                <Text className="text-white font-semibold">保存记录</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ════════════════════════════════════════════════════════ */}
      {/* 图片标注编辑器（全屏） */}
      {/* ════════════════════════════════════════════════════════ */}
      {annotatorVisible && (
        <ImageAnnotator
          imageId={annotatorImgId}
          imageUri={annotatorImgUri}
          imgWidth={annotatorImgW}
          imgHeight={annotatorImgH}
          onSave={() => { setAnnotatorVisible(false); }}
          onClose={() => setAnnotatorVisible(false)}
        />
      )}

      {/* ════════════════════════════════════════════════════════ */}
      {/* 图片预览 Modal */}
      {/* ════════════════════════════════════════════════════════ */}
      <Modal
        visible={previewVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setPreviewVisible(false)}
      >
        <View className="flex-1 bg-black/90 justify-center items-center">
          <TouchableOpacity
            className="absolute top-12 right-5 z-10 w-10 h-10 rounded-full bg-white/20 items-center justify-center"
            onPress={() => setPreviewVisible(false)}
          >
            <Ionicons name="close" size={24} color="white" />
          </TouchableOpacity>

          {previewImages[previewIndex] && (
            <Image
              source={{ uri: previewImages[previewIndex] }}
              className="w-[90%] h-[60%] rounded-2xl"
              resizeMode="contain"
            />
          )}

          <Text className="text-white/60 text-sm mt-4">
            {previewIndex + 1} / {previewImages.length}
          </Text>

          {/* 左右导航 */}
          {previewImages.length > 1 && (
            <View className="flex-row mt-4 space-x-8">
              <TouchableOpacity
                className="w-12 h-12 rounded-full bg-white/20 items-center justify-center"
                onPress={() =>
                  setPreviewIndex((prev) =>
                    prev === 0 ? previewImages.length - 1 : prev - 1
                  )
                }
              >
                <Ionicons name="chevron-back" size={24} color="white" />
              </TouchableOpacity>
              <TouchableOpacity
                className="w-12 h-12 rounded-full bg-white/20 items-center justify-center"
                onPress={() =>
                  setPreviewIndex((prev) =>
                    prev === previewImages.length - 1 ? 0 : prev + 1
                  )
                }
              >
                <Ionicons name="chevron-forward" size={24} color="white" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}
