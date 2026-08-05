import { useState, useMemo, useRef, useCallback, Component, type ReactNode } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  calcMolarity,
  calcDilution,
  calcPCRMix,
  calcNucleicAcidConc,
  purityAssessment,
  DEFAULT_PCR_COMPONENTS,
  type NucleicAcidType,
  type PCRMixResult,
} from "../../utils/calculations";
import { useFocusEffect } from "expo-router";
import { getDb } from "../../db/database";
import { getKitSummaries, getDeductionPreview } from "../../services/inventoryService";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── 安全数字格式化 ────────────────────────────────────────

/** 将任意值安全转为保留 fixed 位的字符串，NaN/Infinity 返回 '--' */
function safeNum(v: unknown, digits = 2): string {
  const n = typeof v === "number" ? v : parseFloat(v as string);
  if (!isFinite(n)) return "--";
  return n.toFixed(digits);
}

function safeInt(v: unknown): number {
  const n = parseInt(v as string, 10);
  return isNaN(n) ? 0 : n;
}

// ─── ErrorBoundary ─────────────────────────────────────────

interface EBState { hasError: boolean; errorMsg: string }

class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMsg: "" };
  }

  static getDerivedStateFromError(err: Error): EBState {
    return { hasError: true, errorMsg: err.message ?? String(err) };
  }

  componentDidCatch(err: Error) {
    console.error("[ToolsScreen] 崩溃:", err);
  }

  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
          <View className="flex-1 items-center justify-center px-8">
            <View className="w-16 h-16 rounded-full bg-red-100 items-center justify-center mb-4">
              <Ionicons name="warning-outline" size={32} color="#ef4444" />
            </View>
            <Text className="text-lg font-bold text-gray-800 mb-2">计算工具出错</Text>
            <Text className="text-gray-500 text-sm text-center mb-4">{this.state.errorMsg}</Text>
            <TouchableOpacity
              className="bg-primary-600 px-6 py-2.5 rounded-xl"
              onPress={() => this.setState({ hasError: false, errorMsg: "" })}
            >
              <Text className="text-white font-semibold">重试</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

// ─── 工具卡片配置 ────────────────────────────────────────────

type ToolId = "molarity" | "dilution" | "pcr" | "nanodrop" | "template";

const TOOLS = [
  {
    id: "molarity" as ToolId,
    icon: "flask" as const,
    title: "摩尔浓度换算",
    desc: "溶质质量 → 摩尔浓度 (mol/L)",
    color: "bg-blue-50 text-blue-600",
  },
  {
    id: "dilution" as ToolId,
    icon: "water" as const,
    title: "稀释计算 C₁V₁=C₂V₂",
    desc: "计算母液和溶剂用量",
    color: "bg-emerald-50 text-emerald-600",
  },
  {
    id: "pcr" as ToolId,
    icon: "git-branch" as const,
    title: "PCR 反应体系配置",
    desc: "每管用量 + 预混液计算",
    color: "bg-purple-50 text-purple-600",
  },
  {
    id: "nanodrop" as ToolId,
    icon: "color-filter" as const,
    title: "DNA/RNA 浓度 (NanoDrop)",
    desc: "A260 → 浓度 (ng/μL)",
    color: "bg-orange-50 text-orange-600",
  },
  {
    id: "template" as ToolId,
    icon: "git-compare" as const,
    title: "体系配置计算器（来自模板）",
    desc: "选择试剂盒和体系模板，计算用量",
    color: "bg-teal-50 text-teal-600",
  },
];

// ─── 子组件：结果卡片 ──────────────────────────────────────────

function ResultBox({ label, value, unit, color = "bg-green-50" }: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  return (
    <View className={`${color} rounded-xl p-4 mt-3`}>
      <Text className="text-xs text-gray-500 mb-0.5">{label}</Text>
      <View className="flex-row items-baseline">
        <Text className="text-xl font-bold text-gray-800">{value}</Text>
        {unit && <Text className="text-sm text-gray-500 ml-1">{unit}</Text>}
      </View>
    </View>
  );
}

// ─── 子组件：输入行 ────────────────────────────────────────────

function InputRow({
  label,
  value,
  onChange,
  placeholder,
  unit,
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder: string;
  unit?: string;
}) {
  return (
    <View className="mb-3">
      <Text className="text-sm font-medium text-gray-600 mb-1.5">{label}</Text>
      <View className="flex-row items-center">
        <TextInput
          className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800"
          placeholder={placeholder}
          placeholderTextColor="#d1d5db"
          value={value}
          onChangeText={onChange}
          keyboardType="decimal-pad"
        />
        {unit && (
          <Text className="text-gray-400 text-sm ml-2 w-12">{unit}</Text>
        )}
      </View>
    </View>
  );
}

// ─── 子组件：PCR 结果表格 ─────────────────────────────────────

function PCRResultTable({ result }: { result: PCRMixResult }) {
  return (
    <View className="mt-3">
      {/* 概览 */}
      <View className="flex-row space-x-3 mb-4">
        <View className="flex-1 bg-blue-50 rounded-xl p-3 items-center">
          <Text className="text-blue-600 text-lg font-bold">
            {result.numSamples}
          </Text>
          <Text className="text-blue-500 text-xs">样品数</Text>
        </View>
        <View className="flex-1 bg-green-50 rounded-xl p-3 items-center">
          <Text className="text-green-600 text-lg font-bold">
            {result.reactionVolume}
          </Text>
          <Text className="text-green-500 text-xs">μL/管</Text>
        </View>
        <View className="flex-1 bg-purple-50 rounded-xl p-3 items-center">
          <Text className="text-purple-600 text-lg font-bold">
            {result.totalTubes}
          </Text>
          <Text className="text-purple-500 text-xs">总管数 (+1)</Text>
        </View>
      </View>

      {/* 每管 & 预混液 对照表 */}
      <View className="border border-gray-200 rounded-xl overflow-hidden">
        {/* 表头 */}
        <View className="flex-row bg-gray-100 px-3 py-2">
          <Text className="flex-1 text-xs font-bold text-gray-600">组分</Text>
          <Text className="w-20 text-center text-xs font-bold text-gray-600">
            /管 (μL)
          </Text>
          <Text className="w-24 text-center text-xs font-bold text-gray-600">
            预混液 (μL)
          </Text>
        </View>

        {result.perTube.map((item, i) => {
          const mm = result.masterMix[i];
          const isH2O = item.name === "ddH₂O";
          return (
            <View
              key={item.name}
              className={`flex-row px-3 py-2.5 border-t border-gray-100 ${
                isH2O ? "bg-blue-50/30" : ""
              }`}
            >
              <Text
                className={`flex-1 text-xs ${
                  isH2O ? "text-blue-600 font-semibold" : "text-gray-700"
                }`}
              >
                {item.name}
              </Text>
              <Text className="w-20 text-center text-xs font-mono text-gray-700">
                {item.volumePerTube}
              </Text>
              <Text className="w-24 text-center text-xs font-mono text-gray-700">
                {mm?.volumePerTube ?? "-"}
              </Text>
            </View>
          );
        })}
      </View>

      <Text className="text-gray-400 text-xs mt-3 text-center">
        预混液总量 = {result.reactionVolume} μL × {result.totalTubes} 管 ={" "}
        {result.reactionVolume * result.totalTubes} μL
      </Text>
    </View>
  );
}

// ════════════════════════════════════════════════════════════
// 主屏幕（内部实现）
// ════════════════════════════════════════════════════════════

function ToolsScreenInner() {
  const [expandedId, setExpandedId] = useState<ToolId | null>(null);

  // ── ① 摩尔浓度换算 ──
  const [massGram, setMassGram] = useState("");
  const [molarMass, setMolarMass] = useState("");
  const [volumeML, setVolumeML] = useState("");

  const molarityResult = useMemo(() => {
    const m = parseFloat(massGram);
    const mm = parseFloat(molarMass);
    const v = parseFloat(volumeML);
    // 质量 <= 0 也是非法输入（负质量无物理意义），与 >0 校验一并处理
    if (isNaN(m) || isNaN(mm) || isNaN(v) || mm <= 0 || v <= 0 || m <= 0) return null;
    return calcMolarity(m, mm, v);
  }, [massGram, molarMass, volumeML]);

  const molarityHint = useMemo(() => {
    if (!massGram.trim() && !molarMass.trim() && !volumeML.trim()) return "";
    return "请输入完整且有效的参数（质量、摩尔质量、体积均需大于 0）";
  }, [massGram, molarMass, volumeML]);

  // 质量浓度（仅当输入有效时）
  const massConcText = useMemo(() => {
    const m = parseFloat(massGram);
    const v = parseFloat(volumeML);
    if (isNaN(m) || isNaN(v) || v <= 0 || m <= 0) return "";
    return `质量浓度: ${safeNum((m / v) * 1000, 2)} mg/mL`;
  }, [massGram, volumeML]);

  // ── ② 稀释计算 ──
  const [stockConc, setStockConc] = useState("");
  const [targetConc, setTargetConc] = useState("");
  const [targetVol, setTargetVol] = useState("");

  const dilutionResult = useMemo(() => {
    const s = parseFloat(stockConc);
    const t = parseFloat(targetConc);
    const v = parseFloat(targetVol);
    if (isNaN(s) || isNaN(t) || isNaN(v) || s <= 0 || t <= 0 || v <= 0) return null;
    return calcDilution(s, t, v);
  }, [stockConc, targetConc, targetVol]);

  // 稀释非法输入提示：calcDilution 对不可配制场景返回 NaN 字段
  const dilutionHint = useMemo(() => {
    if (!stockConc.trim() && !targetConc.trim() && !targetVol.trim()) return "";
    if (!dilutionResult) return "请输入完整且有效的参数（浓度与体积均需大于 0）";
    if (!isFinite(dilutionResult.stockVolume)) return "输入无效：目标浓度不能高于母液浓度";
    return "";
  }, [stockConc, targetConc, targetVol, dilutionResult]);

  // ── ③ PCR 体系 ──
  const [pcrVol, setPcrVol] = useState("50");
  const [pcrSamples, setPcrSamples] = useState("8");
  // 可调组分比例（以 100 μL 为基准）
  const [pcrRatios, setPcrRatios] = useState<Record<string, string>>(
    Object.fromEntries(
      DEFAULT_PCR_COMPONENTS.filter((c) => c.name !== "ddH₂O").map((c) => [
        c.name,
        String(c.ratio),
      ])
    )
  );

  // 输入 "0" 时不再静默回退默认值，而是显示错误提示
  const pcrErrorText = useMemo(() => {
    if (pcrVol.trim() !== "" && safeInt(pcrVol) <= 0) return "反应体积需大于 0";
    if (pcrSamples.trim() !== "" && safeInt(pcrSamples) <= 0) return "样品数量需大于 0";
    return "";
  }, [pcrVol, pcrSamples]);

  const pcrResult = useMemo(() => {
    const vol = safeInt(pcrVol);
    const samples = safeInt(pcrSamples);
    if (pcrVol.trim() !== "" && vol <= 0) return null;
    if (pcrSamples.trim() !== "" && samples <= 0) return null;
    // 空输入时回退默认值；显式 "0" 已在上方拦截
    const effectiveVol = vol > 0 ? vol : 50;
    const effectiveSamples = samples > 0 ? samples : 1;

    const customComponents = DEFAULT_PCR_COMPONENTS.map((c) => {
      if (c.name === "ddH₂O") return c;
      const ratio = parseFloat(pcrRatios[c.name] ?? "");
      return { ...c, ratio: isNaN(ratio) || ratio < 0 ? c.ratio : ratio };
    });

    return calcPCRMix(effectiveVol, effectiveSamples, customComponents);
  }, [pcrVol, pcrSamples, pcrRatios]);

  // ── ④ NanoDrop ──
  const [a260, setA260] = useState("");
  const [dilFactor, setDilFactor] = useState("100");
  const [naType, setNaType] = useState<NucleicAcidType>("dsDNA");
  const [a260a280, setA260a280] = useState("");

  const nanodropResult = useMemo(() => {
    const a = parseFloat(a260);
    const d = parseFloat(dilFactor);
    if (isNaN(a) || a < 0 || isNaN(d) || d <= 0) return null;
    return calcNucleicAcidConc(a, isNaN(d) ? 1 : d, naType);
  }, [a260, dilFactor, naType]);

  const nanodropHint = useMemo(() => {
    if (!a260.trim() && !dilFactor.trim()) return "";
    return "请输入完整且有效的参数（A260 ≥ 0，稀释倍数 > 0）";
  }, [a260, dilFactor]);

  const purity = useMemo(() => {
    const r = parseFloat(a260a280);
    if (isNaN(r)) return null;
    return purityAssessment(r);
  }, [a260a280]);

  // ── ⑤ 体系配置计算器 ──
  const [kits, setKits] = useState<{ id: number; name: string; brand: string }[]>([]);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [templates, setTemplates] = useState<{ id: number; template_name: string; total_vol_ul: number; components_json: string }[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | null>(null);
  const [templateReactionCount, setTemplateReactionCount] = useState("8");
  const [templatePreview, setTemplatePreview] = useState<any[]>([]);
  const [previewPending, setPreviewPending] = useState(false);
  // 模板加载序号：快速切换试剂盒时丢弃过期响应
  const kitTemplateSeqRef = useRef(0);

  useFocusEffect(useCallback(() => {
    (async () => {
      try { setKits(await getKitSummaries()); } catch (e) { console.error("[tools] 加载试剂盒失败", e); }
    })();
  }, []));

  const loadTemplates = async (kitId: number) => {
    const seq = ++kitTemplateSeqRef.current;
    setTemplates([]); // 加载前清空，避免残留上一个试剂盒的模板
    try {
      const db = await getDb();
      const rows = await db.getAllAsync<{ id: number; template_name: string; total_vol_ul: number; components_json: string }>(
        "SELECT id, template_name, total_vol_ul, components_json FROM reaction_templates WHERE kit_id = ?", [kitId]
      );
      if (seq !== kitTemplateSeqRef.current) return; // 过期响应丢弃
      setTemplates(rows);
    } catch (e: any) {
      if (seq === kitTemplateSeqRef.current) Alert.alert("加载失败", e?.message ?? "模板加载失败");
    }
  };

  const templateCountError = useMemo(() => {
    if (templateReactionCount.trim() !== "" && safeInt(templateReactionCount) <= 0) return "反应管数需大于 0";
    return "";
  }, [templateReactionCount]);

  const templateResult = useMemo(() => {
    if (!selectedTemplateId) return null;
    const tmpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tmpl) return null;
    try {
      const comps = JSON.parse(tmpl.components_json) as { name: string; vol_ul: number; ratio: string }[];
      if (!Array.isArray(comps) || comps.length === 0) return null;
      // 显式 "0" 已由 templateCountError 拦截，这里仅处理空输入回退
      const rawN = safeInt(templateReactionCount);
      if (templateReactionCount.trim() !== "" && rawN <= 0) return null;
      const n = rawN > 0 ? rawN : 1;
      const scale = 1.1;
      const totalTubes = Math.max(1, Math.ceil(n * scale));
      const perTube = comps.map((c) => ({ ...c, perTube: Math.max(0, c.vol_ul ?? 0) }));
      const masterMix = comps.map((c) => ({ name: c.name, total: Number(((c.vol_ul ?? 0) * totalTubes).toFixed(1)) }));
      const totalVol = comps.reduce((s, c) => s + Math.max(0, c.vol_ul ?? 0), 0);
      const mmTotal = Number((totalVol * totalTubes).toFixed(1));
      return { perTube, masterMix, totalVol, mmTotal, n, totalTubes, templateName: tmpl.template_name };
    } catch { return null; }
  }, [selectedTemplateId, templateReactionCount, templates]);

  const loadTemplatePreview = async () => {
    if (!selectedKitId || !selectedTemplateId || previewPending) return;
    const n = parseInt(templateReactionCount) || 1;
    setPreviewPending(true);
    try {
      const preview = await getDeductionPreview(selectedKitId, selectedTemplateId, n);
      setTemplatePreview(preview);
    } catch (e: any) { Alert.alert("计算失败", e?.message ?? "请重试"); }
    finally { setPreviewPending(false); }
  };

  // ── 展开/折叠 ──
  const toggleExpand = (id: ToolId) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedId((prev) => (prev === id ? null : id));
  };

  // ════════════════════════════════════════════════════════════
  // 渲染
  // ════════════════════════════════════════════════════════════

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      {/* 头部 */}
      <View className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <Text className="text-2xl font-bold text-gray-900">计算工具</Text>
        <Text className="text-gray-400 text-sm mt-1">
          常用实验计算器 · 实时计算
        </Text>
      </View>

      <ScrollView
        className="flex-1 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {TOOLS.map((tool) => {
          const isOpen = expandedId === tool.id;
          return (
            <View key={tool.id} className="mb-3">
              {/* ── 卡片头部 ── */}
              <TouchableOpacity
                className="bg-white rounded-2xl p-5 border border-gray-100 flex-row items-center"
                activeOpacity={0.95}
                onPress={() => toggleExpand(tool.id)}
              >
                <View
                  className={`w-10 h-10 rounded-xl items-center justify-center mr-3 ${tool.color}`}
                >
                  <Ionicons name={tool.icon} size={22} color="currentColor" />
                </View>
                <View className="flex-1">
                  <Text className="font-bold text-gray-800 text-sm">
                    {tool.title}
                  </Text>
                  <Text className="text-gray-400 text-xs mt-0.5">
                    {tool.desc}
                  </Text>
                </View>
                <Ionicons
                  name={isOpen ? "chevron-up" : "chevron-down"}
                  size={20}
                  color="#d1d5db"
                />
              </TouchableOpacity>

              {/* ── 展开区 ── */}
              {isOpen && (
                <View className="bg-white mx-1 rounded-b-2xl px-5 pb-5 border border-t-0 border-gray-100 -mt-1">
                  <View className="h-px bg-gray-100 mb-4" />

                  {/* ═══════════════════════════════════════ */}
                  {/* ① 摩尔浓度换算 */}
                  {/* ═══════════════════════════════════════ */}
                  {tool.id === "molarity" && (
                    <View>
                      <Text className="text-xs text-gray-400 mb-3">
                        C(mol/L) = 质量(g) / (MW(g/mol) × V(L))
                      </Text>
                      <InputRow
                        label="溶质质量"
                        value={massGram}
                        onChange={setMassGram}
                        placeholder="如 5.844"
                        unit="g"
                      />
                      <InputRow
                        label="摩尔质量 (MW)"
                        value={molarMass}
                        onChange={setMolarMass}
                        placeholder="如 58.44 (NaCl)"
                        unit="g/mol"
                      />
                      <InputRow
                        label="溶液体积"
                        value={volumeML}
                        onChange={setVolumeML}
                        placeholder="如 100"
                        unit="mL"
                      />

                      {molarityResult !== null && (
                        <ResultBox
                          label="摩尔浓度"
                          value={safeNum(molarityResult, 4)}
                          unit="mol/L"
                        />
                      )}
                      {molarityResult !== null && (
                        <Text className="text-gray-400 text-xs mt-2 text-center">
                          = {safeNum(molarityResult * 1000, 2)} mM{ massConcText ? ` · ${massConcText}` : "" }
                        </Text>
                      )}
                      {molarityResult === null && molarityHint !== "" && (
                        <Text className="text-amber-600 text-xs mt-2 text-center">{molarityHint}</Text>
                      )}
                    </View>
                  )}

                  {/* ═══════════════════════════════════════ */}
                  {/* ② 稀释计算 */}
                  {/* ═══════════════════════════════════════ */}
                  {tool.id === "dilution" && (
                    <View>
                      <View className="bg-blue-50 rounded-xl p-3 mb-4">
                        <Text className="text-blue-700 text-sm font-mono text-center">
                          C₁ × V₁ = C₂ × V₂
                        </Text>
                      </View>
                      <InputRow
                        label="母液浓度 C₁"
                        value={stockConc}
                        onChange={setStockConc}
                        placeholder="如 10"
                      />
                      <InputRow
                        label="目标浓度 C₂"
                        value={targetConc}
                        onChange={setTargetConc}
                        placeholder="如 2"
                      />
                      <InputRow
                        label="目标体积 V₂"
                        value={targetVol}
                        onChange={setTargetVol}
                        placeholder="如 100"
                      />

                      {dilutionResult && isFinite(dilutionResult.stockVolume) && (
                        <View>
                          <ResultBox
                            label="需取母液 V₁"
                            value={String(dilutionResult.stockVolume)}
                            color="bg-blue-50"
                          />
                          <ResultBox
                            label="需加溶剂"
                            value={String(dilutionResult.solventVolume)}
                            color="bg-gray-50"
                          />
                          <View className="bg-emerald-50 rounded-xl p-3 mt-3">
                            <Text className="text-emerald-700 text-xs text-center">
                              取 {dilutionResult.stockVolume} 体积母液，加{" "}
                              {dilutionResult.solventVolume} 体积溶剂，定容至{" "}
                              {targetVol || "?"} 体积
                            </Text>
                          </View>
                        </View>
                      )}
                      {dilutionHint !== "" && (
                        <Text className="text-amber-600 text-xs mt-2 text-center">{dilutionHint}</Text>
                      )}
                    </View>
                  )}

                  {/* ═══════════════════════════════════════ */}
                  {/* ③ PCR 反应体系 */}
                  {/* ═══════════════════════════════════════ */}
                  {tool.id === "pcr" && (
                    <View>
                      <View className="flex-row space-x-3 mb-4">
                        <View className="flex-1">
                          <Text className="text-sm font-medium text-gray-600 mb-1.5">
                            反应体积 (μL/管)
                          </Text>
                          <TextInput
                            className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 text-center"
                            value={pcrVol}
                            onChangeText={setPcrVol}
                            keyboardType="number-pad"
                            placeholder="50"
                          />
                        </View>
                        <View className="flex-1">
                          <Text className="text-sm font-medium text-gray-600 mb-1.5">
                            样品数量
                          </Text>
                          <TextInput
                            className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 text-center"
                            value={pcrSamples}
                            onChangeText={setPcrSamples}
                            keyboardType="number-pad"
                            placeholder="8"
                          />
                        </View>
                      </View>

                      {pcrErrorText !== "" && (
                        <Text className="text-red-500 text-xs mb-3">{pcrErrorText}</Text>
                      )}

                      {/* 组分比例调整 */}
                      <Text className="text-sm font-medium text-gray-600 mb-2">
                        组分比例（基准：100 μL 反应）
                      </Text>
                      {DEFAULT_PCR_COMPONENTS.filter(
                        (c) => c.name !== "ddH₂O"
                      ).map((comp) => (
                        <View
                          key={comp.name}
                          className="flex-row items-center mb-2"
                        >
                          <Text className="flex-1 text-xs text-gray-600">
                            {comp.name}
                            {comp.stockConc !== "—" && (
                              <Text className="text-gray-400">
                                {" "}
                                ({comp.stockConc})
                              </Text>
                            )}
                          </Text>
                          <TextInput
                            className="w-16 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-center text-gray-800"
                            value={pcrRatios[comp.name] ?? String(comp.ratio)}
                            onChangeText={(t) =>
                              setPcrRatios((prev) => ({
                                ...prev,
                                [comp.name]: t,
                              }))
                            }
                            keyboardType="decimal-pad"
                          />
                          <Text className="text-gray-400 text-xs ml-1 w-8">
                            μL
                          </Text>
                        </View>
                      ))}

                      {pcrResult && <PCRResultTable result={pcrResult} />}
                    </View>
                  )}

                  {/* ═══════════════════════════════════════ */}
                  {/* ④ NanoDrop */}
                  {/* ═══════════════════════════════════════ */}
                  {tool.id === "nanodrop" && (
                    <View>
                      {/* 类型选择 */}
                      <Text className="text-sm font-medium text-gray-600 mb-2">
                        核酸类型
                      </Text>
                      <View className="flex-row bg-gray-100 rounded-xl p-0.5 mb-4">
                        {(
                          [
                            ["dsDNA", "dsDNA (×50)"],
                            ["ssDNA", "ssDNA (×33)"],
                            ["RNA", "RNA (×40)"],
                          ] as [NucleicAcidType, string][]
                        ).map(([type, label]) => (
                          <TouchableOpacity
                            key={type}
                            className={`flex-1 py-2 rounded-lg items-center ${
                              naType === type ? "bg-white shadow-sm" : ""
                            }`}
                            onPress={() => setNaType(type)}
                          >
                            <Text
                              className={`text-xs font-semibold ${
                                naType === type
                                  ? "text-primary-600"
                                  : "text-gray-400"
                              }`}
                            >
                              {label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>

                      <InputRow
                        label="A260 吸光度"
                        value={a260}
                        onChange={setA260}
                        placeholder="如 0.5"
                      />
                      <InputRow
                        label="稀释倍数"
                        value={dilFactor}
                        onChange={setDilFactor}
                        placeholder="如 100"
                      />

                      {nanodropResult !== null && (
                        <ResultBox
                          label="核酸浓度"
                          value={nanodropResult.toLocaleString()}
                          unit="ng/μL"
                        />
                      )}
                      {nanodropResult !== null && (
                        <Text className="text-gray-400 text-xs mt-2 text-center">
                          = {(nanodropResult / 1000).toFixed(2)} μg/μL
                        </Text>
                      )}
                      {nanodropResult === null && nanodropHint !== "" && (
                        <Text className="text-amber-600 text-xs mt-2 text-center">{nanodropHint}</Text>
                      )}

                      {/* 纯度评估 */}
                      <View className="border-t border-gray-100 mt-4 pt-4">
                        <Text className="text-sm font-medium text-gray-600 mb-2">
                          纯度评估（可选）
                        </Text>
                        <InputRow
                          label="A260/A280 比值"
                          value={a260a280}
                          onChange={setA260a280}
                          placeholder="如 1.85"
                        />
                        {purity && (
                          <View
                            className={`rounded-xl p-3 mt-1 ${
                              purity.color === "green"
                                ? "bg-emerald-50"
                                : purity.color === "yellow"
                                  ? "bg-amber-50"
                                  : "bg-red-50"
                            }`}
                          >
                            <Text
                              className={`text-center font-semibold text-sm ${
                                purity.color === "green"
                                  ? "text-emerald-700"
                                  : purity.color === "yellow"
                                    ? "text-amber-700"
                                    : "text-red-700"
                              }`}
                            >
                              {purity.label}
                            </Text>
                            <Text className="text-center text-xs text-gray-500 mt-0.5">
                              纯 dsDNA: 1.8–2.0 · RNA: 2.0–2.2
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  )}
                </View>
              )}

              {/* ═══════════════════════════════════════ */}
              {/* ⑤ 体系配置计算器 */}
              {/* ═══════════════════════════════════════ */}
              {tool.id === "template" && (
                <View>
                  <Text className="text-xs text-gray-400 mb-3">选择试剂盒和体系模板，计算 N 管用量</Text>

                  <Text className="text-sm font-medium text-gray-600 mb-1.5">试剂盒</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-3">
                    {kits.length === 0 ? (
                      <Text className="text-gray-400 text-xs py-2">暂无试剂盒，请先解析说明书</Text>
                    ) : kits.map((k) => (
                      <TouchableOpacity key={k.id}
                        className={`px-4 py-2 rounded-lg mr-2 ${selectedKitId === k.id ? "bg-teal-100 border border-teal-300" : "bg-gray-100"}`}
                        onPress={() => { setSelectedKitId(k.id); setSelectedTemplateId(null); loadTemplates(k.id); }}>
                        <Text className={`text-xs font-medium ${selectedKitId === k.id ? "text-teal-700" : "text-gray-600"}`}>{k.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  {selectedKitId && templates.length > 0 && (
                    <>
                      <Text className="text-sm font-medium text-gray-600 mb-1.5">体系模板</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
                        {templates.map((t) => (
                          <TouchableOpacity key={t.id}
                            className={`px-4 py-2 rounded-lg mr-2 ${selectedTemplateId === t.id ? "bg-teal-100 border border-teal-300" : "bg-gray-100"}`}
                            onPress={() => setSelectedTemplateId(t.id)}>
                            <Text className={`text-xs font-medium ${selectedTemplateId === t.id ? "text-teal-700" : "text-gray-600"}`}>{t.template_name} ({t.total_vol_ul}μL)</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </>
                  )}
                  {selectedKitId && templates.length === 0 && (
                    <Text className="text-gray-400 text-xs mb-3">该试剂盒暂无反应模板</Text>
                  )}

                  {selectedTemplateId && (
                    <>
                      <View className="flex-row items-center space-x-3 mb-4">
                        <View className="flex-1">
                          <Text className="text-sm font-medium text-gray-600 mb-1.5">反应管数</Text>
                          <TextInput className="input-field text-center" value={templateReactionCount} onChangeText={setTemplateReactionCount} keyboardType="number-pad" />
                          {templateCountError !== "" && <Text className="text-red-500 text-xs mt-1">{templateCountError}</Text>}
                        </View>
                        <TouchableOpacity className="mt-5 bg-teal-500 px-4 py-3 rounded-xl" onPress={loadTemplatePreview} disabled={previewPending}>
                          {previewPending ? <ActivityIndicator size="small" color="white" /> : <Text className="text-white text-xs font-semibold">计算消耗</Text>}
                        </TouchableOpacity>
                      </View>

                      {templateResult && (
                        <View>
                          <Text className="text-xs font-bold text-gray-500 mb-2">每管 ({templateResult.totalVol} μL)</Text>
                          <View className="border border-gray-200 rounded-xl overflow-hidden mb-3">
                            <View className="flex-row bg-gray-100 px-3 py-1.5">
                              <Text className="flex-1 text-xs font-bold text-gray-600">组分</Text>
                              <Text className="w-16 text-center text-xs font-bold text-gray-600">μL</Text>
                              <Text className="w-16 text-center text-xs font-bold text-gray-600">比例</Text>
                            </View>
                            {templateResult.perTube.map((c: any, i: number) => (
                              <View key={i} className="flex-row px-3 py-1.5 border-t border-gray-100">
                                <Text className="flex-1 text-xs text-gray-700">{c.name}</Text>
                                <Text className="w-16 text-center text-xs text-gray-700">{c.perTube}</Text>
                                <Text className="w-16 text-center text-xs text-gray-500">{c.ratio || "-"}</Text>
                              </View>
                            ))}
                          </View>

                          <Text className="text-xs font-bold text-gray-500 mb-2">预混液 ×{templateResult.totalTubes} 管 (+10%)</Text>
                          <View className="border border-blue-200 rounded-xl overflow-hidden mb-3">
                            {templateResult.masterMix.map((m: any, i: number) => (
                              <View key={i} className={`flex-row px-3 py-1.5 ${i > 0 ? "border-t border-blue-50" : ""} ${i % 2 === 0 ? "bg-blue-50/50" : ""}`}>
                                <Text className="flex-1 text-xs text-gray-700">{m.name}</Text>
                                <Text className="text-xs font-mono text-blue-700 font-semibold">{m.total} μL</Text>
                              </View>
                            ))}
                            <View className="flex-row px-3 py-2 bg-blue-100 border-t border-blue-200">
                              <Text className="flex-1 text-xs font-bold text-blue-800">预混液总量</Text>
                              <Text className="text-xs font-bold text-blue-800">{templateResult.mmTotal} μL</Text>
                            </View>
                          </View>

                          {templatePreview.length > 0 && (
                            <View className="bg-amber-50 rounded-xl p-3 mb-3">
                              <Text className="text-xs font-bold text-amber-700 mb-2">本次将消耗（扣减预览）</Text>
                              {templatePreview.map((p: any, i: number) => (
                                <View key={i} className="flex-row justify-between py-0.5">
                                  <Text className="text-xs text-amber-700">{p.componentName}</Text>
                                  <Text className="text-xs text-amber-600">-{p.totalDeduct} {p.unit} → {p.afterDeduction} {p.unit}</Text>
                                </View>
                              ))}
                            </View>
                          )}
                        </View>
                      )}
                    </>
                  )}
                </View>
              )}
            </View>
          );
        })}

        <View className="h-6" />
      </ScrollView>
    </SafeAreaView>
  );
}

/** 使用 ErrorBoundary 包裹的默认导出 */
export default function ToolsScreen() {
  return (
    <ErrorBoundary>
      <ToolsScreenInner />
    </ErrorBoundary>
  );
}
