import { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Image,
  Alert,
  ActivityIndicator,
  Modal,
  Pressable,
  LayoutAnimation,
  Platform,
  UIManager,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import { parseKitManual, parseKitText, readImageAsBase64, type ParsedKit, type ParsedComponent, type ParsedSopStep, type ParsedReactionTemplate } from "../services/kitParser";
import { getDb, withTransaction } from "../db/database";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const MAX_IMAGES = 10;

// ─── Step types ──────────────────────────────────────────────

type Step = "upload" | "parsing" | "review" | "saving";

// ─── Main Screen ─────────────────────────────────────────────

export default function KitParserScreen() {
  const [step, setStep] = useState<Step>("upload");

  // Upload
  const [images, setImages] = useState<string[]>([]);   // base64
  const [imageUris, setImageUris] = useState<string[]>([]); // display URIs
  const [pdfUri, setPdfUri] = useState<string | null>(null);
  const [textInput, setTextInput] = useState("");

  // Parsing
  const [parseProgress, setParseProgress] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);

  // Review — editable copy of ParsedKit
  const [kit, setKit] = useState<ParsedKit | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["info", "components", "steps", "reactions"]));
  const [catalogNo, setCatalogNo] = useState("");

  // Saving
  const [inventoryModal, setInventoryModal] = useState(false);
  const [inventoryQtys, setInventoryQtys] = useState<Record<number, string>>({});
  const [inventoryThresholds, setInventoryThresholds] = useState<Record<number, string>>({});

  // 组件卸载标记：解析请求返回后不 setState，防止把用户拽回审核页
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // kitName 输入框 ref（必填校验失败时 focus）
  const kitNameRef = useRef<TextInput>(null);

  // 解析阶段 → 百分比映射（OCR 分批 message 不改变百分比）
  const STAGE_PCT: Record<string, number> = {
    init: 5,
    preprocess: 10,
    ocr: 60,
    parse: 90,
    done: 100,
  };
  const stageToPct = (stage: string): number => STAGE_PCT[stage] ?? 0;

  // ── Upload: Pick Images ──
  const pickImages = async () => {
    if (images.length >= MAX_IMAGES) { Alert.alert("提示", `最多 ${MAX_IMAGES} 张`); return; }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("权限不足", "请授予相册权限"); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      selectionLimit: MAX_IMAGES - images.length,
    });
    if (!result.canceled) {
      const uris = result.assets.map((a) => a.uri);
      setImageUris((p) => [...p, ...uris].slice(0, MAX_IMAGES));
      const b64s = await Promise.all(uris.map((u) => readImageAsBase64(u)));
      setImages((p) => [...p, ...b64s].slice(0, MAX_IMAGES));
    }
  };

  // ── Upload: Take Photo ──
  const takePhoto = async () => {
    if (images.length >= MAX_IMAGES) { Alert.alert("提示", `最多 ${MAX_IMAGES} 张`); return; }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert("权限不足", "请授予相机权限"); return; }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!result.canceled && result.assets.length > 0) {
      const uri = result.assets[0].uri;
      setImageUris((p) => [...p, uri].slice(0, MAX_IMAGES));
      const b64 = await readImageAsBase64(uri);
      setImages((p) => [...p, b64].slice(0, MAX_IMAGES));
    }
  };

  // ── Upload: Pick PDF ──
  const pickPDF = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets?.length) {
        const uri = result.assets[0].uri;
        setPdfUri(uri);
        setImageUris([]);
        setImages([]);
      }
    } catch (err: any) {
      Alert.alert("错误", err?.message ?? "无法选择文件");
    }
  };

  // ── Remove image ──
  const removeImage = (idx: number) => {
    setImageUris((p) => p.filter((_, i) => i !== idx));
    setImages((p) => p.filter((_, i) => i !== idx));
  };

  // ── Start Parsing ──
  const startParsing = async () => {
    setParseError(null);
    setStep("parsing");
    setParseProgress(0);

    try {
      // PDF：GLM-4V 无法解析 PDF，引导用户改用截图/文本
      if (pdfUri) {
        setStep("upload");
        Alert.alert(
          "暂不支持直接解析 PDF 说明书",
          "请将说明书的页面截图/拍照上传，或使用文本粘贴模式"
        );
        return;
      }

      // 图片模式：GLM-4V OCR → DeepSeek
      if (images.length > 0) {
        const result = await parseKitManual(images, {
          onProgress: (stage, _msg) => {
            if (isMountedRef.current) setParseProgress(stageToPct(stage));
          },
        });
        if (!isMountedRef.current) return;
        setKit(result);
        setCatalogNo("");
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setStep("review");
        return;
      }

      // 纯文本模式：跳过 GLM，直接用 DeepSeek 解析
      const text = textInput.trim();
      if (text) {
        const result = await parseKitText(text, (msg) => {
          if (!isMountedRef.current) return;
          setParseProgress(msg.includes("DeepSeek") ? 90 : 10);
        });
        if (!isMountedRef.current) return;
        setKit(result);
        setCatalogNo("");
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setStep("review");
        return;
      }

      setParseError("请上传说明书或输入文本");
      setStep("upload");
    } catch (err: any) {
      if (!isMountedRef.current) return;
      setParseError(err?.message ?? "解析失败");
      setStep("upload");
    }
  };

  // ── Toggle section ──
  const toggleSection = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Save to Database ──
  const handleSave = async () => {
    if (!kit) return;

    // 表单校验：kitName 必填
    const name = kit.kitName.trim();
    if (!name) {
      Alert.alert("提示", "试剂盒名称为必填项");
      setStep("review");
      setTimeout(() => kitNameRef.current?.focus(), 100);
      return;
    }

    // 表单校验：库存量值必须为有限且 ≥ 0 的数字
    const qtyValues = kit.components.map((_, i) => parseFloat(inventoryQtys[i] ?? "0"));
    const threshValues = kit.components.map((_, i) => parseFloat(inventoryThresholds[i] ?? "0"));
    if ([...qtyValues, ...threshValues].some((v) => !Number.isFinite(v) || v < 0)) {
      Alert.alert("提示", "库存数量必须是不小于 0 的数字");
      setStep("review");
      return;
    }

    setStep("saving");

    try {
      // manual_pdf_path：复制到 documentDirectory 永久目录，避免 OS 清缓存失效
      let manualPath: string | null = null;
      if (pdfUri) {
        try {
          const dir = `${FileSystem.documentDirectory}manuals/`;
          const dirInfo = await FileSystem.getInfoAsync(dir);
          if (!dirInfo.exists) {
            await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
          }
          const target = `${dir}manual_${Date.now()}.pdf`;
          await FileSystem.copyAsync({ from: pdfUri, to: target });
          manualPath = target;
        } catch {
          manualPath = null;
        }
      }

      // 同名去重检测：存在则确认覆盖/取消
      const db = await getDb();
      const existing = await db.getFirstAsync<{ id: number }>(
        "SELECT id FROM kits WHERE name = ? LIMIT 1",
        [name]
      );
      let overwriteId: number | null = null;
      if (existing) {
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert("同名试剂盒已存在", `「${name}」已存在，是否覆盖并更新其数据？`, [
            { text: "取消", style: "cancel", onPress: () => resolve(false) },
            { text: "覆盖", style: "destructive", onPress: () => resolve(true) },
          ]);
        });
        if (!confirmed) {
          setStep("review");
          return;
        }
        overwriteId = existing.id;
      }

      // 全部写入包在一个事务里：失败即整体回滚，不留孤儿数据
      await withTransaction(async (tx) => {
        let kitId: number;
        if (overwriteId != null) {
          kitId = overwriteId;
          await tx.runAsync("DELETE FROM experiment_templates WHERE kit_id = ?", [kitId]);
          await tx.runAsync("DELETE FROM reaction_templates WHERE kit_id = ?", [kitId]);
          await tx.runAsync("DELETE FROM kit_components WHERE kit_id = ?", [kitId]);
          await tx.runAsync(
            "UPDATE kits SET brand = ?, catalog_no = ?, manual_pdf_path = ?, parsed_at = datetime('now','localtime') WHERE id = ?",
            [kit.brand, catalogNo, manualPath, kitId]
          );
        } else {
          const kitResult = await tx.runAsync(
            "INSERT INTO kits (name, brand, catalog_no, manual_pdf_path, parsed_at) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
            [name, kit.brand, catalogNo, manualPath]
          );
          kitId = kitResult.lastInsertRowId;
        }

        // Insert components
        for (let i = 0; i < kit.components.length; i++) {
          const c = kit.components[i];
          const qty = parseFloat(inventoryQtys[i] ?? "0") || 0;
          const thresh = parseFloat(inventoryThresholds[i] ?? "0") || 0;
          await tx.runAsync(
            "INSERT INTO kit_components (kit_id, name, unit, initial_qty, current_qty, low_threshold, storage_condition) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [kitId, c.name, c.unit, qty, qty, thresh, c.storage]
          );
        }

        // Insert reaction templates
        for (const rt of kit.reactionTemplates) {
          await tx.runAsync(
            "INSERT INTO reaction_templates (kit_id, template_name, total_vol_ul, components_json, source) VALUES (?, ?, ?, ?, 'parsed')",
            [kitId, rt.name, rt.total_vol, JSON.stringify(rt.components)]
          );
        }

        // SOP 步骤只存模板 JSON（不写 sop_steps 表，避免 experiment_id=0 悬空外键垃圾行）
        if (kit.sopSteps.length > 0) {
          const sopJson = JSON.stringify(kit.sopSteps.map((s) => ({
            step_num: s.step_num,
            title: s.title,
            description: s.description,
            duration_min: s.duration_min,
            timer_required: s.timer_required,
          })));
          await tx.runAsync(
            "INSERT INTO experiment_templates (name, description, kit_id, sop_steps_json, tags, source_experiment_id) VALUES (?, ?, ?, ?, ?, ?)",
            [`${name} SOP`, `从 ${kit.brand || "试剂盒"} 说明书解析`, kitId, sopJson, "kit-sop", null]
          );
        }
      });

      Alert.alert("保存成功", `试剂盒「${name}」已保存`, [
        { text: "查看试剂盒", onPress: () => router.back() },
      ]);
    } catch (err: any) {
      Alert.alert("保存失败，未写入任何数据", err?.message ?? "请重试");
      setStep("review");
    }
  };

  // ════════════════════════════════════════════════════════════
  // RENDER: Step 1 — Upload
  // ════════════════════════════════════════════════════════════
  if (step === "upload") {
    return (
      <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
        <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center">
          <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={22} color="#374151" />
          </TouchableOpacity>
          <View>
            <Text className="text-xl font-bold text-gray-900">试剂盒说明书解析</Text>
            <Text className="text-gray-400 text-xs mt-0.5">步骤 1/4 · 上传说明书</Text>
          </View>
        </View>

        <ScrollView className="flex-1 px-5 pt-6" showsVerticalScrollIndicator={false}>
          {parseError && (
            <View className="bg-red-50 rounded-2xl p-4 mb-4 border border-red-100">
              <Text className="text-red-600 text-sm">{parseError}</Text>
            </View>
          )}

          {/* PDF 上传 */}
          <TouchableOpacity className="bg-white rounded-2xl p-5 border-2 border-dashed border-primary-300 items-center mb-4" onPress={pickPDF}>
            <View className="w-16 h-16 rounded-full bg-primary-50 items-center justify-center mb-3">
              <Ionicons name="document-text" size={32} color="#3b82f6" />
            </View>
            <Text className="text-primary-600 font-bold text-base">上传 PDF 说明书</Text>
            <Text className="text-gray-400 text-sm mt-1">暂不支持直接解析，请将说明书页面截图后以图片上传</Text>
          </TouchableOpacity>

          {pdfUri && (
            <View className="bg-blue-50 rounded-xl p-3 mb-4 flex-row items-center">
              <Ionicons name="document" size={20} color="#3b82f6" />
              <Text className="text-blue-700 text-sm ml-2 flex-1" numberOfLines={1}>PDF 已选择</Text>
              <TouchableOpacity onPress={() => setPdfUri(null)}><Ionicons name="close-circle" size={20} color="#93c5fd" /></TouchableOpacity>
            </View>
          )}

          {/* 拍照/相册 */}
          <View className="flex-row space-x-3 mb-4">
            <TouchableOpacity className="flex-1 bg-white rounded-2xl p-4 border border-gray-200 items-center" onPress={pickImages}>
              <Ionicons name="images-outline" size={28} color="#6b7280" />
              <Text className="text-gray-600 text-sm mt-2 font-medium">从相册选择</Text>
            </TouchableOpacity>
            <TouchableOpacity className="flex-1 bg-white rounded-2xl p-4 border border-gray-200 items-center" onPress={takePhoto}>
              <Ionicons name="camera-outline" size={28} color="#6b7280" />
              <Text className="text-gray-600 text-sm mt-2 font-medium">拍照</Text>
            </TouchableOpacity>
          </View>

          {/* Image preview grid */}
          {imageUris.length > 0 && (
            <View className="flex-row flex-wrap mb-4">
              {imageUris.map((uri, idx) => (
                <View key={idx} className="mr-2 mb-2">
                  <Image source={{ uri }} className="w-20 h-20 rounded-xl bg-gray-100" resizeMode="cover" />
                  <TouchableOpacity className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full items-center justify-center" onPress={() => removeImage(idx)}>
                    <Ionicons name="close" size={12} color="white" />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Divider */}
          <View className="flex-row items-center mb-4">
            <View className="flex-1 h-px bg-gray-200" />
            <Text className="text-gray-400 text-xs mx-3">或</Text>
            <View className="flex-1 h-px bg-gray-200" />
          </View>

          {/* Text input */}
          <Text className="text-sm font-semibold text-gray-600 mb-2">直接粘贴说明书文本</Text>
          <TextInput
            className="bg-white border border-gray-200 rounded-2xl px-4 py-4 text-sm text-gray-800 mb-6"
            placeholder="粘贴试剂盒说明书文本内容..."
            placeholderTextColor="#d1d5db"
            value={textInput}
            onChangeText={setTextInput}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
          />

          {/* Start button */}
          <TouchableOpacity
            className="bg-primary-600 py-4 rounded-2xl items-center mb-8 shadow-sm shadow-primary-300"
            onPress={startParsing}
            disabled={!pdfUri && images.length === 0 && !textInput.trim()}
          >
            <View className="flex-row items-center">
              <Ionicons name="sparkles" size={20} color="white" />
              <Text className="text-white font-bold text-base ml-2">开始 AI 解析</Text>
            </View>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════
  // RENDER: Step 2 — Parsing
  // ════════════════════════════════════════════════════════════
  if (step === "parsing") {
    return (
      <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
        <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center">
          <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={() => { setStep("upload"); }}>
            <Ionicons name="arrow-back" size={22} color="#374151" />
          </TouchableOpacity>
          <Text className="text-xl font-bold text-gray-900">解析中...</Text>
        </View>
        <View className="flex-1 items-center justify-center px-8">
          <ActivityIndicator size="large" color="#8b5cf6" />
          <Text className="text-gray-600 text-lg font-semibold mt-6">正在识别说明书...</Text>
          <Text className="text-gray-400 text-sm mt-2 text-center">AI 正在提取试剂盒信息、内容物、SOP 步骤和反应体系</Text>
          {/* Progress bar */}
          <View className="w-full h-2 bg-gray-200 rounded-full mt-8 overflow-hidden">
            <View className="h-full bg-purple-500 rounded-full" style={{ width: `${parseProgress}%` }} />
          </View>
          <Text className="text-gray-400 text-xs mt-2">{parseProgress}%</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════
  // RENDER: Step 3 — Review
  // ════════════════════════════════════════════════════════════
  if (step === "review" && kit) {
    return (
      <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
        <View className="bg-white px-5 pt-4 pb-4 border-b border-gray-100 flex-row items-center justify-between">
          <View className="flex-row items-center">
            <TouchableOpacity className="w-10 h-10 rounded-full bg-gray-100 items-center justify-center mr-3" onPress={() => setStep("upload")}>
              <Ionicons name="arrow-back" size={22} color="#374151" />
            </TouchableOpacity>
            <View>
              <Text className="text-xl font-bold text-gray-900">审核确认</Text>
              <Text className="text-gray-400 text-xs mt-0.5">步骤 3/4 · 核对并编辑解析结果</Text>
            </View>
          </View>
        </View>

        <ScrollView className="flex-1 px-4 pt-4" showsVerticalScrollIndicator={false}>
          {/* Warnings */}
          {kit.warnings.length > 0 && (
            <View className="bg-amber-50 rounded-2xl p-4 mb-4 border border-amber-200">
              <View className="flex-row items-center mb-2">
                <Ionicons name="warning" size={20} color="#d97706" />
                <Text className="text-amber-800 font-bold text-sm ml-2">需人工核实</Text>
              </View>
              {kit.warnings.map((w, i) => (
                <View key={i} className="flex-row items-start mb-1.5 last:mb-0">
                  <Text className="text-amber-600 mr-2 text-xs mt-0.5">⚠</Text>
                  <Text className="text-amber-700 text-xs flex-1">{w}</Text>
                </View>
              ))}
            </View>
          )}

          {/* ── Section ① Kit Info ── */}
          <TouchableOpacity className="bg-white rounded-2xl p-5 mb-3 border border-gray-100" onPress={() => toggleSection("info")}>
            <View className="flex-row items-center justify-between mb-3">
              <View className="flex-row items-center"><Ionicons name="information-circle" size={20} color="#3b82f6" /><Text className="font-bold text-gray-800 ml-2">试剂盒基本信息</Text></View>
              <Ionicons name={expandedSections.has("info") ? "chevron-up" : "chevron-down"} size={18} color="#d1d5db" />
            </View>
            {expandedSections.has("info") && (
              <View>
                <Label>名称 *</Label>
                <TextInput ref={kitNameRef} className="input-field mb-3" value={kit.kitName} onChangeText={(t) => setKit({ ...kit, kitName: t })} />
                <Label>品牌</Label>
                <TextInput className="input-field mb-3" value={kit.brand} onChangeText={(t) => setKit({ ...kit, brand: t })} />
                <Label>货号</Label>
                <TextInput className="input-field" value={catalogNo} onChangeText={setCatalogNo} placeholder="如未识别，请手动输入" />
              </View>
            )}
          </TouchableOpacity>

          {/* ── Section ② Components ── */}
          <TouchableOpacity className="bg-white rounded-2xl p-5 mb-3 border border-gray-100" onPress={() => toggleSection("components")}>
            <View className="flex-row items-center justify-between mb-3">
              <View className="flex-row items-center"><Ionicons name="cube" size={20} color="#8b5cf6" /><Text className="font-bold text-gray-800 ml-2">内容物清单 ({kit.components.length})</Text></View>
              <Ionicons name={expandedSections.has("components") ? "chevron-up" : "chevron-down"} size={18} color="#d1d5db" />
            </View>
            {expandedSections.has("components") && kit.components.map((c, i) => (
              <View key={i} className="mb-3 pb-3 border-b border-gray-50 last:border-0 last:mb-0 last:pb-0">
                <View className="flex-row space-x-2 mb-2">
                  <TextInput className="flex-1 input-field text-sm" value={c.name} onChangeText={(t) => { const nc = [...kit.components]; nc[i] = { ...c, name: t }; setKit({ ...kit, components: nc }); }} placeholder="名称" />
                  <TextInput className="w-16 input-field text-sm text-center" value={c.unit} onChangeText={(t) => { const nc = [...kit.components]; nc[i] = { ...c, unit: t }; setKit({ ...kit, components: nc }); }} placeholder="单位" />
                </View>
                <View className="flex-row space-x-2">
                  <TextInput className="flex-1 input-field text-sm" value={c.qty_per_kit} onChangeText={(t) => { const nc = [...kit.components]; nc[i] = { ...c, qty_per_kit: t }; setKit({ ...kit, components: nc }); }} placeholder="每盒含量" />
                  <TextInput className="flex-1 input-field text-sm" value={c.storage} onChangeText={(t) => { const nc = [...kit.components]; nc[i] = { ...c, storage: t }; setKit({ ...kit, components: nc }); }} placeholder="存储条件" />
                </View>
              </View>
            ))}
          </TouchableOpacity>

          {/* ── Section ③ SOP Steps ── */}
          <TouchableOpacity className="bg-white rounded-2xl p-5 mb-3 border border-gray-100" onPress={() => toggleSection("steps")}>
            <View className="flex-row items-center justify-between mb-3">
              <View className="flex-row items-center"><Ionicons name="list" size={20} color="#10b981" /><Text className="font-bold text-gray-800 ml-2">SOP 步骤 ({kit.sopSteps.length})</Text></View>
              <Ionicons name={expandedSections.has("steps") ? "chevron-up" : "chevron-down"} size={18} color="#d1d5db" />
            </View>
            {expandedSections.has("steps") && kit.sopSteps.map((s, i) => (
              <View key={i} className="mb-3 pb-3 border-b border-gray-50 last:border-0 last:mb-0 last:pb-0">
                <View className="flex-row items-center mb-2">
                  <View className="w-7 h-7 rounded-full bg-emerald-100 items-center justify-center mr-2">
                    <Text className="text-emerald-700 font-bold text-xs">{s.step_num}</Text>
                  </View>
                  <TextInput className="flex-1 input-field text-sm" value={s.title} onChangeText={(t) => { const ns = [...kit.sopSteps]; ns[i] = { ...s, title: t }; setKit({ ...kit, sopSteps: ns }); }} />
                </View>
                <TextInput className="input-field text-sm mb-2" value={s.description} onChangeText={(t) => { const ns = [...kit.sopSteps]; ns[i] = { ...s, description: t }; setKit({ ...kit, sopSteps: ns }); }} multiline placeholder="描述" />
                <View className="flex-row items-center space-x-3">
                  <View className="flex-row items-center flex-1">
                    <Text className="text-gray-500 text-xs mr-2">时长(min)</Text>
                    <TextInput className="w-16 input-field text-sm text-center" value={String(s.duration_min)} onChangeText={(t) => { const ns = [...kit.sopSteps]; ns[i] = { ...s, duration_min: parseInt(t) || 0 }; setKit({ ...kit, sopSteps: ns }); }} keyboardType="number-pad" />
                  </View>
                  <View className="flex-row items-center">
                    <Text className="text-gray-500 text-xs mr-2">计时</Text>
                    <Switch value={s.timer_required} onValueChange={(v) => { const ns = [...kit.sopSteps]; ns[i] = { ...s, timer_required: v }; setKit({ ...kit, sopSteps: ns }); }} />
                  </View>
                </View>
              </View>
            ))}
          </TouchableOpacity>

          {/* ── Section ④ Reaction Templates ── */}
          <TouchableOpacity className="bg-white rounded-2xl p-5 mb-3 border border-gray-100" onPress={() => toggleSection("reactions")}>
            <View className="flex-row items-center justify-between mb-3">
              <View className="flex-row items-center"><Ionicons name="flask" size={20} color="#f59e0b" /><Text className="font-bold text-gray-800 ml-2">反应体系 ({kit.reactionTemplates.length})</Text></View>
              <Ionicons name={expandedSections.has("reactions") ? "chevron-up" : "chevron-down"} size={18} color="#d1d5db" />
            </View>
            {expandedSections.has("reactions") && kit.reactionTemplates.map((rt, i) => {
              const total = rt.components.reduce((s, c) => s + c.vol_ul, 0);
              return (
                <View key={i} className="mb-3 pb-3 border-b border-gray-50 last:border-0 last:mb-0 last:pb-0">
                  <View className="flex-row space-x-2 mb-2">
                    <TextInput className="flex-1 input-field text-sm" value={rt.name} onChangeText={(t) => { const nr = [...kit.reactionTemplates]; nr[i] = { ...rt, name: t }; setKit({ ...kit, reactionTemplates: nr }); }} placeholder="体系名称" />
                    <TextInput className="w-20 input-field text-sm text-center" value={String(rt.total_vol)} onChangeText={(t) => { const nr = [...kit.reactionTemplates]; nr[i] = { ...rt, total_vol: parseInt(t) || 0 }; setKit({ ...kit, reactionTemplates: nr }); }} keyboardType="number-pad" placeholder="总μL" />
                  </View>
                  {/* Table header */}
                  <View className="flex-row bg-gray-100 rounded-lg px-2 py-1.5 mb-1">
                    <Text className="flex-1 text-xs font-bold text-gray-600">组分</Text>
                    <Text className="w-16 text-center text-xs font-bold text-gray-600">μL/管</Text>
                    <Text className="w-16 text-center text-xs font-bold text-gray-600">比例</Text>
                  </View>
                  {rt.components.map((c, j) => (
                    <View key={j} className="flex-row px-2 py-1 border-b border-gray-50 items-center">
                      <TextInput className="flex-1 text-xs text-gray-700" value={c.name} onChangeText={(t) => { const nr = [...kit.reactionTemplates]; const nc = [...nr[i].components]; nc[j] = { ...c, name: t }; nr[i] = { ...rt, components: nc }; setKit({ ...kit, reactionTemplates: nr }); }} />
                      <TextInput className="w-16 text-center text-xs text-gray-700" value={String(c.vol_ul)} onChangeText={(t) => { const nr = [...kit.reactionTemplates]; const nc = [...nr[i].components]; nc[j] = { ...c, vol_ul: parseFloat(t) || 0 }; nr[i] = { ...rt, components: nc }; setKit({ ...kit, reactionTemplates: nr }); }} keyboardType="decimal-pad" />
                      <TextInput className="w-16 text-center text-xs text-gray-700" value={c.ratio} onChangeText={(t) => { const nr = [...kit.reactionTemplates]; const nc = [...nr[i].components]; nc[j] = { ...c, ratio: t }; nr[i] = { ...rt, components: nc }; setKit({ ...kit, reactionTemplates: nr }); }} />
                    </View>
                  ))}
                  <View className="flex-row px-2 py-1.5 bg-blue-50 rounded-lg mt-1">
                    <Text className="flex-1 text-xs font-bold text-blue-700">合计</Text>
                    <Text className="w-16 text-center text-xs font-bold text-blue-700">{total.toFixed(1)}</Text>
                    <View className="w-16" />
                  </View>
                </View>
              );
            })}
          </TouchableOpacity>

          {/* Save button */}
          <TouchableOpacity className="bg-primary-600 py-4 rounded-2xl items-center mb-8 shadow-sm shadow-primary-300" onPress={() => setInventoryModal(true)}>
            <Text className="text-white font-bold text-base">确认保存</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Inventory Modal */}
        <Modal visible={inventoryModal} animationType="slide" transparent onRequestClose={() => setInventoryModal(false)}>
          <Pressable className="flex-1 bg-black/40 justify-end" onPress={() => setInventoryModal(false)}>
            <Pressable className="bg-white rounded-t-3xl px-5 pt-6 pb-10 max-h-[80%]" onPress={(e) => e.stopPropagation()}>
              <View className="w-10 h-1 bg-gray-200 rounded-full self-center mb-5" />
              <Text className="text-xl font-bold text-gray-900 mb-2">初始化库存</Text>
              <Text className="text-gray-500 text-sm mb-4">输入每个内容物的初始数量和低量警戒值</Text>
              <ScrollView className="max-h-[55vh]" showsVerticalScrollIndicator={false}>
                {kit?.components.map((c, i) => (
                  <View key={i} className="mb-4 pb-4 border-b border-gray-50 last:border-0">
                    <Text className="font-semibold text-gray-700 text-sm mb-2">{c.name} ({c.unit})</Text>
                    <View className="flex-row space-x-3">
                      <View className="flex-1">
                        <Text className="text-gray-400 text-xs mb-1">初始数量</Text>
                        <TextInput className="input-field text-sm text-center" value={inventoryQtys[i] ?? ""} onChangeText={(t) => setInventoryQtys((p) => ({ ...p, [i]: t }))} keyboardType="decimal-pad" placeholder="0" />
                      </View>
                      <View className="flex-1">
                        <Text className="text-gray-400 text-xs mb-1">低量警戒</Text>
                        <TextInput className="input-field text-sm text-center" value={inventoryThresholds[i] ?? ""} onChangeText={(t) => setInventoryThresholds((p) => ({ ...p, [i]: t }))} keyboardType="decimal-pad" placeholder="0" />
                      </View>
                    </View>
                  </View>
                ))}
              </ScrollView>
              <View className="flex-row space-x-3 mt-4">
                <TouchableOpacity className="flex-1 bg-gray-100 py-3.5 rounded-xl items-center" onPress={() => setInventoryModal(false)}>
                  <Text className="text-gray-600 font-semibold">返回编辑</Text>
                </TouchableOpacity>
                <TouchableOpacity className="flex-1 bg-primary-600 py-3.5 rounded-xl items-center" onPress={() => { setInventoryModal(false); handleSave(); }}>
                  <Text className="text-white font-semibold">保存试剂盒</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════
  // RENDER: Step 4 — Saving
  // ════════════════════════════════════════════════════════════
  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      <View className="flex-1 items-center justify-center px-8">
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text className="text-gray-600 text-lg font-semibold mt-6">正在保存...</Text>
        <Text className="text-gray-400 text-sm mt-2 text-center">正在写入试剂盒数据到数据库</Text>
      </View>
    </SafeAreaView>
  );
}

// ─── Helper ──────────────────────────────────────────────────

function Label({ children }: { children: string }) {
  return <Text className="text-sm font-semibold text-gray-600 mb-1.5">{children}</Text>;
}
