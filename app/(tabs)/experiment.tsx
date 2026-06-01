import { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  Animated,
  LayoutAnimation,
  Platform,
  UIManager,
  Alert,
  Modal,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, router } from "expo-router";
import * as SQLite from "expo-sqlite";
import { useExperiment } from "../../hooks/useExperiment";
import { useTimer } from "../../hooks/useTimer";
import { deductKitUsage, getDeductionPreview, type DeductionPreview } from "../../services/inventoryService";
import type { Experiment, SopStep } from "../../db/schema";

if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── 常量 ────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  Experiment["status"],
  { label: string; bg: string; text: string; icon: React.ComponentProps<typeof Ionicons>["name"] }
> = {
  planned:     { label: "已安排",   bg: "bg-blue-100",    text: "text-blue-700",    icon: "calendar-outline" },
  in_progress: { label: "进行中",   bg: "bg-emerald-100", text: "text-emerald-700", icon: "play-circle" },
  completed:   { label: "已完成",   bg: "bg-gray-100",    text: "text-gray-500",    icon: "checkmark-circle" },
  cancelled:   { label: "已取消",   bg: "bg-red-50",      text: "text-red-400",     icon: "close-circle" },
  paused:      { label: "已暂停",   bg: "bg-amber-100",   text: "text-amber-700",   icon: "pause-circle" },
};

// ─── 子组件 ──────────────────────────────────────────────────

/** 进度条（带动画） */
function StepProgressBar({
  done,
  total,
  size = "md",
}: {
  done: number;
  total: number;
  size?: "sm" | "md";
}) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const animRef = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animRef, {
      toValue: percent,
      duration: 400,
      useNativeDriver: false,
    }).start();
  }, [percent, animRef]);

  const h = size === "sm" ? "h-1.5" : "h-2.5";
  const barColor =
    percent === 100 ? "#10b981" : percent >= 50 ? "#3b82f6" : "#f59e0b";

  return (
    <View className="flex-row items-center">
      <View className={`flex-1 ${h} bg-gray-100 rounded-full overflow-hidden mr-2`}>
        <Animated.View
          className={`${h} rounded-full`}
          style={{
            width: animRef.interpolate({
              inputRange: [0, 100],
              outputRange: ["0%", "100%"],
            }),
            backgroundColor: barColor,
          }}
        />
      </View>
      {size === "md" && (
        <Text className="text-xs font-bold text-gray-400 w-10 text-right">
          {done}/{total}
        </Text>
      )}
    </View>
  );
}

/** 计时器显示 */
function TimerDisplay({
  isRunning,
  isPaused,
  remainingSeconds,
  totalSeconds,
  progress,
  formattedTime,
  onStart,
  onPause,
  onResume,
  onReset,
  stepTitle,
  durationMin,
}: {
  isRunning: boolean;
  isPaused: boolean;
  remainingSeconds: number;
  totalSeconds: number;
  progress: number;
  formattedTime: string;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  stepTitle: string;
  durationMin: number;
}) {
  // 未启动状态
  if (!isRunning && !isPaused && remainingSeconds === 0) {
    return (
      <TouchableOpacity
        className="flex-row items-center bg-primary-50 border border-primary-200 px-3 py-1.5 rounded-lg"
        onPress={onStart}
      >
        <Ionicons name="timer-outline" size={16} color="#3b82f6" />
        <Text className="text-primary-600 text-xs font-semibold ml-1.5">
          开始计时 {durationMin}min
        </Text>
      </TouchableOpacity>
    );
  }

  // 进行中/暂停状态
  const isActive = isRunning || isPaused;
  if (!isActive) return null;

  return (
    <View className="bg-white border border-gray-200 rounded-xl p-3 mt-2">
      {/* 步骤名 + 时间 */}
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-gray-800 font-semibold text-sm flex-1 mr-2" numberOfLines={1}>
          ⏱ {stepTitle}
        </Text>
        <View className="flex-row items-center">
          {isRunning && (
            <View className="w-2 h-2 rounded-full bg-emerald-400 mr-1.5" />
          )}
          <Text
            className={`text-lg font-mono font-bold ${
              isRunning ? "text-emerald-600" : "text-amber-600"
            }`}
          >
            {formattedTime}
          </Text>
        </View>
      </View>

      {/* 计时进度条 */}
      <View className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-2">
        <Animated.View
          className="h-full rounded-full"
          style={{
            width: `${Math.round(progress * 100)}%`,
            backgroundColor: isRunning ? "#10b981" : "#f59e0b",
          }}
        />
      </View>

      {/* 控制按钮 */}
      <View className="flex-row space-x-2">
        {isRunning ? (
          <TouchableOpacity
            className="flex-1 flex-row items-center justify-center bg-amber-50 border border-amber-200 py-1.5 rounded-lg"
            onPress={onPause}
          >
            <Ionicons name="pause" size={14} color="#d97706" />
            <Text className="text-amber-700 text-xs font-semibold ml-1">
              暂停
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            className="flex-1 flex-row items-center justify-center bg-emerald-50 border border-emerald-200 py-1.5 rounded-lg"
            onPress={onResume}
          >
            <Ionicons name="play" size={14} color="#059669" />
            <Text className="text-emerald-700 text-xs font-semibold ml-1">
              继续
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          className="flex-1 flex-row items-center justify-center bg-gray-50 border border-gray-200 py-1.5 rounded-lg"
          onPress={onReset}
        >
          <Ionicons name="stop" size={14} color="#6b7280" />
          <Text className="text-gray-500 text-xs font-semibold ml-1">
            重置
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** 状态标签 */
function StatusBadge({ status }: { status: Experiment["status"] }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.planned;
  return (
    <View className={`px-2 py-0.5 rounded-md ${cfg.bg}`}>
      <Text className={`text-xs font-semibold ${cfg.text}`}>{cfg.label}</Text>
    </View>
  );
}

// ─── 主屏幕 ──────────────────────────────────────────────────

export default function ExperimentScreen() {
  const {
    experiments,
    selectedExperiment,
    steps,
    loading,
    overallProgress,
    loadTodayExperiments,
    loadAllExperiments,
    selectExperiment,
    deselectExperiment,
    toggleStepCompleted,
    updateStepNotes,
    updateExperimentStatus,
  } = useExperiment();

  const timer = useTimer();

  // ── 视图模式：today / all ──
  const [viewMode, setViewMode] = useState<"today" | "all">("today");

  // ── 展开的备注步骤 ──
  const [notesExpanded, setNotesExpanded] = useState<Set<number>>(new Set());
  const [notesDraft, setNotesDraft] = useState<Record<number, string>>({});

  // ── 库存扣减确认 ──
  const [deductionModal, setDeductionModal] = useState(false);
  const [deductionPreview, setDeductionPreview] = useState<DeductionPreview[]>([]);
  const [deductionReactionCount, setDeductionReactionCount] = useState("1");

  // ── 新建实验 Modal ──
  const [expModalVisible, setExpModalVisible] = useState(false);
  const [expName, setExpName] = useState("");
  const [expDesc, setExpDesc] = useState("");
  const [expDate, setExpDate] = useState(new Date().toISOString().split("T")[0]);
  const [expKitId, setExpKitId] = useState<number | null>(null);
  const [kits, setKits] = useState<{ id: number; name: string }[]>([]);

  // ── 下拉刷新 ──
  const [refreshing, setRefreshing] = useState(false);

  // ── 页面聚焦 ──
  useFocusEffect(
    useCallback(() => {
      if (viewMode === "today") loadTodayExperiments();
      else loadAllExperiments();
    }, [viewMode, loadTodayExperiments, loadAllExperiments])
  );

  // ── 下拉刷新 ──
  const onRefresh = async () => {
    setRefreshing(true);
    if (viewMode === "today") await loadTodayExperiments();
    else await loadAllExperiments();
    setRefreshing(false);
  };

  // ── 切换视图 ──
  const switchView = (mode: "today" | "all") => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setViewMode(mode);
    if (mode === "today") loadTodayExperiments();
    else loadAllExperiments();
  };

  // ── 进入实验详情 ──
  const handleSelect = async (exp: Experiment) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    await selectExperiment(exp);
    await timer.resetTimer();
    setNotesExpanded(new Set());
    setNotesDraft({});
  };

  // ── 返回列表 ──
  const handleBack = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    deselectExperiment();
  };

  // ── 切换备注展开 ──
  const toggleNotes = (stepId: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setNotesExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  // ── 保存备注 ──
  const saveNotes = async (stepId: number) => {
    const notes = notesDraft[stepId] ?? "";
    await updateStepNotes(stepId, notes);
  };

  // ── 完成实验（含库存扣减） ──
  const handleComplete = async (exp: Experiment) => {
    if (exp.kit_id && exp.reaction_template_id) {
      const preview = await getDeductionPreview(exp.kit_id, exp.reaction_template_id, 1);
      if (preview.length > 0) {
        setDeductionPreview(preview);
        setDeductionReactionCount("1");
        setDeductionModal(true);
        return;
      }
    }
    await updateExperimentStatus(exp.id, "completed");
  };

  const handleConfirmDeduction = async () => {
    const exp = selectedExperiment;
    if (!exp?.kit_id || !exp?.reaction_template_id) return;
    const count = parseInt(deductionReactionCount) || 1;
    const result = await deductKitUsage(exp.kit_id, exp.id, count, exp.reaction_template_id);
    if (result.success) {
      if (result.lowComponents?.length) {
        Alert.alert("库存预警", `以下组分库存不足：${result.lowComponents.join("、")}`);
      }
      await updateExperimentStatus(exp.id, "completed");
    } else {
      Alert.alert("扣减失败", result.error ?? "请重试");
    }
    setDeductionModal(false);
  };

  // ── 开始/暂停/恢复/重置计时 ──
  const handleTimerStart = (step: SopStep) => {
    timer.startTimer(step.id, step.title, step.duration_min);
  };
  const handleTimerPause = () => timer.pauseTimer();
  const handleTimerResume = () => timer.resumeTimer();
  const handleTimerReset = () => timer.resetTimer();

  // ── 格式化日期 ──
  const fmtDate = (dt: string) => {
    try {
      return new Date(dt).toLocaleDateString("zh-CN", {
        month: "numeric",
        day: "numeric",
        weekday: "short",
      });
    } catch {
      return dt;
    }
  };

  // ── 格式化时间 ──
  const fmtTime = (t: string | null) => {
    if (!t) return "";
    try {
      const [h, m] = t.split(":");
      return `${h}:${m}`;
    } catch {
      return t;
    }
  };
  // ── 加载试剂盒列表 ──
  const loadKits = async () => {
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const rows = await db.getAllAsync<{ id: number; name: string }>(
        "SELECT id, name FROM kits ORDER BY name"
      );
      setKits(rows);
    } catch { /* 表可能尚不存在 */ }
  };

  // ── 打开新建实验 Modal ──
  const openExpModal = () => {
    setExpName("");
    setExpDesc("");
    setExpDate(new Date().toISOString().split("T")[0]);
    setExpKitId(null);
    loadKits();
    setExpModalVisible(true);
  };

  // ── 提交新建实验 ──
  const submitExperiment = async () => {
    const name = expName.trim();
    if (!name) { Alert.alert("提示", "请输入实验名称"); return; }
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      await db.runAsync(
        `INSERT INTO experiments (kit_id, name, description, scheduled_date, status)
         VALUES (?, ?, ?, ?, 'planned')`,
        [expKitId, name, expDesc.trim(), expDate]
      );
      setExpModalVisible(false);
      if (viewMode === "today") await loadTodayExperiments();
      else await loadAllExperiments();
    } catch (err: any) {
      Alert.alert("错误", err.message ?? "创建失败");
    }
  };
  // ════════════════════════════════════════════════════════════
  // 视图 2：实验详情
  // ════════════════════════════════════════════════════════════
  if (selectedExperiment) {
    const exp = selectedExperiment;
    const statusCfg = STATUS_CONFIG[exp.status] ?? STATUS_CONFIG.planned;

    return (
      <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
        {/* ── 详情头部 ── */}
        <View className="bg-white px-4 pt-3 pb-4 border-b border-gray-100">
          {/* 返回按钮 */}
          <TouchableOpacity
            className="flex-row items-center mb-3"
            onPress={handleBack}
          >
            <Ionicons name="arrow-back" size={22} color="#3b82f6" />
            <Text className="text-primary-600 font-medium ml-1">
              返回实验列表
            </Text>
          </TouchableOpacity>

          {/* 实验信息 */}
          <View className="flex-row items-start">
            <View
              className={`w-11 h-11 rounded-2xl items-center justify-center mr-3 ${statusCfg.bg}`}
            >
              <Ionicons
                name={statusCfg.icon}
                size={22}
                color={statusCfg.text.replace("text-", "#") === "text-emerald-700" ? "#059669" : "#3b82f6"}
              />
            </View>
            <View className="flex-1">
              <Text className="text-lg font-bold text-gray-900">
                {exp.name}
              </Text>
              {exp.description ? (
                <Text className="text-gray-400 text-sm mt-0.5" numberOfLines={2}>
                  {exp.description}
                </Text>
              ) : null}
              <View className="flex-row items-center mt-1.5 space-x-3">
                <Text className="text-gray-400 text-xs">
                  📅 {exp.scheduled_date}
                  {exp.scheduled_time ? ` ${fmtTime(exp.scheduled_time)}` : ""}
                </Text>
                <StatusBadge status={exp.status} />
              </View>
            </View>
          </View>

          {/* 总体进度 */}
          <View className="mt-4">
            <View className="flex-row justify-between mb-1.5">
              <Text className="text-xs font-semibold text-gray-500">
                实验进度
              </Text>
              <Text className="text-xs font-bold text-primary-600">
                {overallProgress.percent}%
              </Text>
            </View>
            <StepProgressBar
              done={overallProgress.done}
              total={overallProgress.total}
            />
          </View>

          {/* 实验操作 */}
          <View className="flex-row mt-4 space-x-2">
            {exp.status === "planned" && (
              <TouchableOpacity
                className="flex-1 bg-emerald-600 py-2.5 rounded-xl items-center flex-row justify-center"
                onPress={() => updateExperimentStatus(exp.id, "in_progress")}
              >
                <Ionicons name="play" size={16} color="white" />
                <Text className="text-white font-semibold text-sm ml-1">
                  开始实验
                </Text>
              </TouchableOpacity>
            )}
            {exp.status === "in_progress" && (
              <>
                <TouchableOpacity
                  className="flex-1 bg-primary-600 py-2.5 rounded-xl items-center flex-row justify-center"
                  onPress={() => handleComplete(exp)}
                >
                  <Ionicons name="checkmark-circle" size={16} color="white" />
                  <Text className="text-white font-semibold text-sm ml-1">
                    完成实验
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className="flex-1 bg-amber-500 py-2.5 rounded-xl items-center flex-row justify-center"
                  onPress={() => updateExperimentStatus(exp.id, "paused")}
                >
                  <Ionicons name="pause-circle" size={16} color="white" />
                  <Text className="text-white font-semibold text-sm ml-1">
                    暂停
                  </Text>
                </TouchableOpacity>
              </>
            )}
            {exp.status === "paused" && (
              <TouchableOpacity
                className="flex-1 bg-emerald-600 py-2.5 rounded-xl items-center flex-row justify-center"
                onPress={() => updateExperimentStatus(exp.id, "in_progress")}
              >
                <Ionicons name="play" size={16} color="white" />
                <Text className="text-white font-semibold text-sm ml-1">
                  继续实验
                </Text>
              </TouchableOpacity>
            )}
            {exp.status === "completed" && (
              <TouchableOpacity
                className="flex-1 bg-purple-600 py-2.5 rounded-xl items-center flex-row justify-center"
                onPress={() => router.push({ pathname: "/templates", params: { saveFromExp: String(exp.id), expName: exp.name } })}
              >
                <Ionicons name="copy-outline" size={16} color="white" />
                <Text className="text-white font-semibold text-sm ml-1">
                  保存为模板
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* ── SOP 步骤列表 ── */}
        <ScrollView
          className="flex-1 px-4 pt-4"
          showsVerticalScrollIndicator={false}
        >
          {loading && steps.length === 0 ? (
            <View>
              {[1, 2, 3].map((i) => (
                <View
                  key={i}
                  className="bg-white rounded-2xl p-5 h-24 mb-3 opacity-50"
                />
              ))}
            </View>
          ) : steps.length === 0 ? (
            <View className="items-center py-12">
              <Ionicons name="list-outline" size={48} color="#d1d5db" />
              <Text className="text-gray-400 mt-3">暂无实验步骤</Text>
              <Text className="text-gray-300 text-sm mt-1">
                请先为实验添加 SOP 步骤
              </Text>
            </View>
          ) : (
            steps.map((step, idx) => {
              const isCompleted = step.completed === 1;
              const isTimerActive =
                timer.stepId === step.id &&
                (timer.isRunning || timer.isPaused);
              const isNotesOpen = notesExpanded.has(step.id);

              return (
                <View key={step.id} className="mb-3">
                  {/* ─── 步骤卡片 ─── */}
                  <View
                    className={`bg-white rounded-2xl p-4 border ${
                      isCompleted
                        ? "border-emerald-200 bg-emerald-50/30"
                        : isTimerActive
                          ? "border-primary-300"
                          : "border-gray-100"
                    }`}
                  >
                    <View className="flex-row items-start">
                      {/* 步骤编号圆圈 */}
                      <TouchableOpacity
                        className={`w-8 h-8 rounded-full items-center justify-center mr-3 ${
                          isCompleted
                            ? "bg-emerald-500"
                            : "bg-primary-100"
                        }`}
                        onPress={() => toggleStepCompleted(step.id)}
                      >
                        {isCompleted ? (
                          <Ionicons name="checkmark" size={18} color="white" />
                        ) : (
                          <Text className="text-primary-600 font-bold text-sm">
                            {step.step_num}
                          </Text>
                        )}
                      </TouchableOpacity>

                      {/* 内容 */}
                      <View className="flex-1">
                        <Text
                          className={`font-semibold text-sm ${
                            isCompleted
                              ? "text-gray-400 line-through"
                              : "text-gray-800"
                          }`}
                        >
                          {step.title}
                        </Text>
                        {step.description ? (
                          <Text
                            className={`text-xs mt-0.5 ${
                              isCompleted ? "text-gray-300" : "text-gray-500"
                            }`}
                            numberOfLines={2}
                          >
                            {step.description}
                          </Text>
                        ) : null}

                        {/* 元数据行 */}
                        <View className="flex-row items-center mt-2 space-x-3">
                          {step.duration_min > 0 && (
                            <View className="flex-row items-center">
                              <Ionicons
                                name="time-outline"
                                size={13}
                                color="#f59e0b"
                              />
                              <Text className="text-amber-600 text-xs ml-0.5">
                                {step.duration_min}min
                              </Text>
                            </View>
                          )}
                          {step.timer_required === 1 &&
                            step.duration_min > 0 && (
                              <TimerDisplay
                                isRunning={
                                  timer.stepId === step.id && timer.isRunning
                                }
                                isPaused={
                                  timer.stepId === step.id && timer.isPaused
                                }
                                remainingSeconds={
                                  timer.stepId === step.id
                                    ? timer.remainingSeconds
                                    : 0
                                }
                                totalSeconds={
                                  timer.stepId === step.id
                                    ? timer.totalSeconds
                                    : step.duration_min * 60
                                }
                                progress={
                                  timer.stepId === step.id ? timer.progress : 0
                                }
                                formattedTime={
                                  timer.stepId === step.id
                                    ? timer.formattedTime
                                    : "00:00"
                                }
                                onStart={() => handleTimerStart(step)}
                                onPause={handleTimerPause}
                                onResume={handleTimerResume}
                                onReset={handleTimerReset}
                                stepTitle={step.title}
                                durationMin={step.duration_min}
                              />
                            )}
                        </View>
                      </View>

                      {/* 备注按钮 */}
                      <TouchableOpacity
                        className="ml-2 p-1"
                        onPress={() => {
                          if (!isNotesOpen) {
                            setNotesDraft((prev) => ({
                              ...prev,
                              [step.id]: step.notes ?? "",
                            }));
                          }
                          toggleNotes(step.id);
                        }}
                      >
                        <Ionicons
                          name={
                            step.notes
                              ? "chatbox-ellipses"
                              : "chatbox-outline"
                          }
                          size={18}
                          color={step.notes ? "#3b82f6" : "#d1d5db"}
                        />
                      </TouchableOpacity>
                    </View>

                    {/* ─── 备注输入区 ─── */}
                    {isNotesOpen && (
                      <View className="mt-3 pt-3 border-t border-gray-100">
                        <TextInput
                          className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-700"
                          placeholder="输入步骤备注..."
                          placeholderTextColor="#d1d5db"
                          value={notesDraft[step.id] ?? ""}
                          onChangeText={(t) =>
                            setNotesDraft((prev) => ({
                              ...prev,
                              [step.id]: t,
                            }))
                          }
                          multiline
                          numberOfLines={3}
                          textAlignVertical="top"
                          onBlur={() => saveNotes(step.id)}
                          onSubmitEditing={() => saveNotes(step.id)}
                          returnKeyType="done"
                        />
                        <View className="flex-row justify-end mt-2">
                          <TouchableOpacity
                            className="bg-primary-50 px-3 py-1 rounded-lg"
                            onPress={() => saveNotes(step.id)}
                          >
                            <Text className="text-primary-600 text-xs font-semibold">
                              保存备注
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>

                  {/* 步骤间连接线 */}
                  {idx < steps.length - 1 && (
                    <View className="items-center -my-1">
                      <View className="w-0.5 h-3 bg-gray-200" />
                    </View>
                  )}
                </View>
              );
            })
          )}

          <View className="h-6" />
        </ScrollView>

        {/* ── 库存扣减确认 Modal ── */}
        {deductionModal && (
          <View className="absolute inset-0 bg-black/40 justify-center items-center px-5">
            <View className="bg-white rounded-2xl p-5 w-full max-h-[70%]">
              <Text className="text-lg font-bold text-gray-900 mb-2">确认库存扣减</Text>
              <Text className="text-gray-500 text-sm mb-1">本次实验使用了试剂盒，请确认扣减用量：</Text>
              <View className="flex-row items-center mb-3">
                <Text className="text-gray-600 text-sm mr-2">反应管数：</Text>
                <TextInput className="w-16 input-field text-sm text-center" value={deductionReactionCount} onChangeText={setDeductionReactionCount} keyboardType="number-pad" />
              </View>
              <ScrollView className="max-h-48 mb-4">
                {deductionPreview.map((p, i) => (
                  <View key={i} className="flex-row justify-between py-1.5 border-b border-gray-50">
                    <Text className="text-xs text-gray-700 flex-1">{p.componentName}</Text>
                    <Text className="text-xs text-gray-500 w-16 text-center">{p.perReaction}×{deductionReactionCount || "1"}={p.totalDeduct} {p.unit}</Text>
                    <Text className={`text-xs w-16 text-right ${p.willBeLow ? "text-red-500" : "text-gray-400"}`}>
                      →{p.afterDeduction} {p.unit}
                    </Text>
                  </View>
                ))}
              </ScrollView>
              <View className="flex-row space-x-3">
                <TouchableOpacity className="flex-1 bg-gray-100 py-3 rounded-xl items-center" onPress={() => setDeductionModal(false)}>
                  <Text className="text-gray-600 font-semibold">跳过</Text>
                </TouchableOpacity>
                <TouchableOpacity className="flex-1 bg-primary-600 py-3 rounded-xl items-center" onPress={handleConfirmDeduction}>
                  <Text className="text-white font-semibold">确认扣减并完成</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </SafeAreaView>
    );
  }

  // ════════════════════════════════════════════════════════════
  // 视图 1：实验列表
  // ════════════════════════════════════════════════════════════

  const today = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  const inProgressCount = experiments.filter(
    (e) => e.status === "in_progress"
  ).length;

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      {/* ── 头部 ── */}
      <View className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <Text className="text-2xl font-bold text-gray-900">实验执行</Text>
            {viewMode === "today" ? (
              <Text className="text-gray-400 text-sm mt-0.5">{today}</Text>
            ) : (
              <Text className="text-gray-400 text-sm mt-0.5">
                {experiments.length} 个实验 · {inProgressCount} 进行中
              </Text>
            )}
          </View>
          <TouchableOpacity
            className="bg-primary-600 w-11 h-11 rounded-2xl items-center justify-center shadow-sm shadow-primary-300"
            activeOpacity={0.8}
            onPress={openExpModal}
          >
            <Ionicons name="add" size={26} color="white" />
          </TouchableOpacity>
        </View>

        {/* 视图切换 */}
        <View className="flex-row mt-3 bg-gray-100 rounded-xl p-0.5">
          <TouchableOpacity
            className={`flex-1 py-2 rounded-lg items-center ${
              viewMode === "today" ? "bg-white shadow-sm" : ""
            }`}
            onPress={() => switchView("today")}
          >
            <Text
              className={`text-sm font-semibold ${
                viewMode === "today" ? "text-primary-600" : "text-gray-400"
              }`}
            >
              今日实验
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            className={`flex-1 py-2 rounded-lg items-center ${
              viewMode === "all" ? "bg-white shadow-sm" : ""
            }`}
            onPress={() => switchView("all")}
          >
            <Text
              className={`text-sm font-semibold ${
                viewMode === "all" ? "text-primary-600" : "text-gray-400"
              }`}
            >
              全部实验
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── 列表 ── */}
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
        {/* 骨架屏 */}
        {loading && experiments.length === 0 && (
          <View>
            {[1, 2, 3].map((i) => (
              <View
                key={i}
                className="bg-white rounded-2xl p-5 h-24 mb-3 opacity-50"
              >
                <View className="w-2/3 h-5 bg-gray-100 rounded mb-3" />
                <View className="w-1/2 h-4 bg-gray-50 rounded" />
              </View>
            ))}
          </View>
        )}

        {/* 空状态 */}
        {!loading && experiments.length === 0 && (
          <View className="items-center py-16">
            <View className="w-20 h-20 rounded-full bg-blue-50 items-center justify-center mb-4">
              <Ionicons name="flask-outline" size={40} color="#93c5fd" />
            </View>
            <Text className="text-gray-400 text-lg font-medium">
              {viewMode === "today" ? "今日无实验安排" : "暂无实验"}
            </Text>
            <Text className="text-gray-300 text-sm mt-1 text-center px-8">
              {viewMode === "today"
                ? "在项目管理中为今天安排实验"
                : "去项目管理创建你的第一个实验"}
            </Text>
          </View>
        )}

        {/* 实验卡片 */}
        {experiments.map((exp) => {
          const cfg = STATUS_CONFIG[exp.status] ?? STATUS_CONFIG.planned;
          return (
            <TouchableOpacity
              key={exp.id}
              className="bg-white rounded-2xl p-5 mb-3 shadow-sm border border-gray-100"
              activeOpacity={0.9}
              onPress={() => handleSelect(exp)}
            >
              <View className="flex-row items-start">
                {/* 图标 */}
                <View
                  className={`w-11 h-11 rounded-2xl items-center justify-center mr-3 ${cfg.bg}`}
                >
                  <Ionicons
                    name={cfg.icon}
                    size={22}
                    color={cfg.text.startsWith("text-emerald") ? "#059669" : cfg.text.startsWith("text-amber") ? "#d97706" : cfg.text.startsWith("text-blue") ? "#2563eb" : "#6b7280"}
                  />
                </View>

                {/* 内容 */}
                <View className="flex-1 mr-2">
                  <Text
                    className="text-base font-bold text-gray-900"
                    numberOfLines={1}
                  >
                    {exp.name}
                  </Text>
                  {exp.description ? (
                    <Text
                      className="text-gray-400 text-sm mt-0.5"
                      numberOfLines={1}
                    >
                      {exp.description}
                    </Text>
                  ) : null}
                  <View className="flex-row items-center mt-1.5 space-x-3">
                    <Text className="text-gray-400 text-xs">
                      {fmtDate(exp.scheduled_date)}
                    </Text>
                    {exp.scheduled_time && (
                      <Text className="text-gray-400 text-xs">
                        {fmtTime(exp.scheduled_time)}
                      </Text>
                    )}
                  </View>
                </View>

                {/* 状态 + 箭头 */}
                <View className="items-end">
                  <StatusBadge status={exp.status} />
                  <Ionicons
                    name="chevron-forward"
                    size={16}
                    color="#d1d5db"
                    style={{ marginTop: 8 }}
                  />
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        <View className="h-6" />
      </ScrollView>

      {/* ── 新建实验 Modal ── */}
      <Modal
        visible={expModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setExpModalVisible(false)}
      >
        <Pressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setExpModalVisible(false)}
        >
          <Pressable
            className="bg-white rounded-t-3xl px-5 pt-6 pb-10"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="w-10 h-1 bg-gray-200 rounded-full self-center mb-5" />
            <Text className="text-xl font-bold text-gray-900 mb-5">新建实验</Text>

            <Text className="text-sm font-semibold text-gray-600 mb-1.5">实验名称 *</Text>
            <TextInput
              className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 mb-4"
              placeholder="输入实验名称"
              placeholderTextColor="#d1d5db"
              value={expName}
              onChangeText={setExpName}
              autoFocus
              maxLength={100}
            />

            <Text className="text-sm font-semibold text-gray-600 mb-1.5">描述</Text>
            <TextInput
              className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 mb-4"
              placeholder="简要描述实验目的..."
              placeholderTextColor="#d1d5db"
              value={expDesc}
              onChangeText={setExpDesc}
              multiline
              numberOfLines={2}
              textAlignVertical="top"
              maxLength={300}
            />

            <Text className="text-sm font-semibold text-gray-600 mb-1.5">计划日期</Text>
            <TextInput
              className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 mb-4"
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#d1d5db"
              value={expDate}
              onChangeText={setExpDate}
              maxLength={10}
            />

            <Text className="text-sm font-semibold text-gray-600 mb-1.5">关联试剂盒（可选）</Text>
            {kits.length === 0 ? (
              <Text className="text-gray-400 text-xs mb-4">暂无试剂盒</Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4" style={{ maxHeight: 48 }}>
                <TouchableOpacity
                  className={`px-3 py-2 rounded-lg mr-2 ${expKitId === null ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`}
                  onPress={() => setExpKitId(null)}
                >
                  <Text className={`text-xs font-medium ${expKitId === null ? "text-primary-700" : "text-gray-500"}`}>不关联</Text>
                </TouchableOpacity>
                {kits.map((k) => (
                  <TouchableOpacity
                    key={k.id}
                    className={`px-3 py-2 rounded-lg mr-2 ${expKitId === k.id ? "bg-primary-100 border border-primary-300" : "bg-gray-100"}`}
                    onPress={() => setExpKitId(k.id)}
                  >
                    <Text className={`text-xs font-medium ${expKitId === k.id ? "text-primary-700" : "text-gray-500"}`} numberOfLines={1}>{k.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            <View className="flex-row space-x-3 mt-2">
              <TouchableOpacity
                className="flex-1 bg-gray-100 py-3.5 rounded-xl items-center"
                onPress={() => setExpModalVisible(false)}
              >
                <Text className="text-gray-600 font-semibold">取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                className="flex-1 bg-primary-600 py-3.5 rounded-xl items-center shadow-sm shadow-primary-300"
                onPress={submitExperiment}
              >
                <Text className="text-white font-semibold">创建实验</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

