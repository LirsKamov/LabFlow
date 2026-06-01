import { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  RefreshControl,
  Modal,
  Animated,
  LayoutAnimation,
  Platform,
  UIManager,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, router } from "expo-router";
import * as SQLite from "expo-sqlite";
import { useProjects, type ProjectWithStats } from "../../hooks/useProjects";
import { useTodos } from "../../hooks/useTodos";
import { getKitSummaries } from "../../services/inventoryService";
import type { Todo } from "../../db/schema";

// Android 需要显式启用 LayoutAnimation
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── 常量配置 ────────────────────────────────────────────────

const PRIORITY_CONFIG: Record<
  Todo["priority"],
  { label: string; bg: string; text: string; border: string }
> = {
  urgent:  { label: "紧急", bg: "bg-red-50",      text: "text-red-600",      border: "border-red-300" },
  high:    { label: "高",   bg: "bg-orange-50",   text: "text-orange-600",   border: "border-orange-300" },
  medium:  { label: "中",   bg: "bg-yellow-50",   text: "text-yellow-600",   border: "border-yellow-300" },
  low:     { label: "低",   bg: "bg-green-50",    text: "text-green-600",    border: "border-green-300" },
};

const STATUS_CONFIG: Record<
  ProjectWithStats["status"],
  { label: string; bg: string; text: string }
> = {
  active:    { label: "进行中", bg: "bg-emerald-100",  text: "text-emerald-700" },
  completed: { label: "已完成", bg: "bg-blue-100",     text: "text-blue-700" },
  paused:    { label: "暂停",   bg: "bg-amber-100",    text: "text-amber-700" },
  archived:  { label: "归档",   bg: "bg-gray-100",     text: "text-gray-500" },
};

const STATUS_DOT: Record<string, string> = {
  active:    "bg-emerald-400",
  completed: "bg-blue-400",
  paused:    "bg-amber-400",
  archived:  "bg-gray-300",
};

// ─── 子组件 ──────────────────────────────────────────────────

/** 进度条 */
function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const animWidth = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(animWidth, {
      toValue: percent,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [percent, animWidth]);

  const barColor =
    percent === 100 ? "#10b981" : percent >= 50 ? "#3b82f6" : "#f59e0b";

  return (
    <View className="flex-row items-center">
      <View className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden mr-2">
        <Animated.View
          className="h-full rounded-full"
          style={{
            width: animWidth.interpolate({
              inputRange: [0, 100],
              outputRange: ["0%", "100%"],
            }),
            backgroundColor: barColor,
          }}
        />
      </View>
      <Text className="text-xs font-semibold text-gray-400 w-9 text-right">
        {percent}%
      </Text>
    </View>
  );
}

/** 优先级标签 */
function PriorityBadge({ priority }: { priority: Todo["priority"] }) {
  const cfg = PRIORITY_CONFIG[priority];
  return (
    <View className={`px-2 py-0.5 rounded-md ${cfg.bg} ${cfg.border} border`}>
      <Text className={`text-xs font-semibold ${cfg.text}`}>{cfg.label}</Text>
    </View>
  );
}

/** 状态标签 */
function StatusBadge({ status }: { status: ProjectWithStats["status"] }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <View className={`px-2.5 py-1 rounded-lg ${cfg.bg}`}>
      <Text className={`text-xs font-semibold ${cfg.text}`}>{cfg.label}</Text>
    </View>
  );
}

// ─── 主屏幕 ──────────────────────────────────────────────────

export default function ProjectsScreen() {
  const {
    projects,
    loading,
    loadProjects,
    createProject,
    updateProject,
    deleteProject,
    updateStatus,
  } = useProjects();

  // ── 展开的项目 ID ──
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // ── 当前 Todo 操作的目标项目 ──
  const { todos, loadTodos, addTodo, toggleTodo, deleteTodo, completionRate } =
    useTodos(expandedId);

  // ── 项目 Modal ──
  const [modalVisible, setModalVisible] = useState(false);
  const [editingProject, setEditingProject] = useState<ProjectWithStats | null>(null);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");

  // ── 待办输入 ──
  const [todoTitle, setTodoTitle] = useState("");
  const [todoPriority, setTodoPriority] = useState<Todo["priority"]>("medium");
  const [todoDueDate, setTodoDueDate] = useState("");

  // ── 新建实验 Modal ──
  const [expModalVisible, setExpModalVisible] = useState(false);
  const [expTargetProjId, setExpTargetProjId] = useState<number | null>(null);
  const [expName, setExpName] = useState("");
  const [expDesc, setExpDesc] = useState("");
  const [expDate, setExpDate] = useState(new Date().toISOString().split("T")[0]);
  const [expKitId, setExpKitId] = useState<number | null>(null);
  const [kits, setKits] = useState<{ id: number; name: string }[]>([]);

  // ── 试剂盒库存汇总 ──
  const [kitSummary, setKitSummary] = useState({ count: 0, lowStock: 0, loading: true });

  // ── 下拉刷新 ──
  const [refreshing, setRefreshing] = useState(false);

  // ── 页面聚焦 ──
  useFocusEffect(
    useCallback(() => {
      loadProjects();
      loadKitSummary();
    }, [loadProjects])
  );

  // ── 展开/折叠时加载 Todo ──
  useEffect(() => {
    if (expandedId !== null) {
      loadTodos();
    }
  }, [expandedId, loadTodos]);

  // ── 下拉刷新 ──
  const onRefresh = async () => {
    setRefreshing(true);
    await loadProjects();
    await loadKitSummary();
    if (expandedId !== null) await loadTodos();
    setRefreshing(false);
  };

  // ── 展开/折叠卡片 ──
  const toggleExpand = (id: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (expandedId === id) {
      setExpandedId(null);
      setTodoTitle("");
      setTodoPriority("medium");
      setTodoDueDate("");
    } else {
      setExpandedId(id);
    }
  };

  // ── 打开新建 Modal ──
  const openCreateModal = () => {
    setEditingProject(null);
    setFormName("");
    setFormDesc("");
    setModalVisible(true);
  };

  // ── 打开编辑 Modal ──
  const openEditModal = (proj: ProjectWithStats) => {
    setEditingProject(proj);
    setFormName(proj.name);
    setFormDesc(proj.description);
    setModalVisible(true);
  };

  // ── 提交项目表单 ──
  const submitForm = async () => {
    const name = formName.trim();
    if (!name) { Alert.alert("提示", "请输入项目名称"); return; }
    try {
      if (editingProject) {
        await updateProject(editingProject.id, { name, description: formDesc.trim() });
      } else {
        await createProject(name, formDesc.trim());
      }
      setModalVisible(false);
    } catch (err: any) {
      Alert.alert("错误", err.message ?? "操作失败");
    }
  };

  // ── 加载试剂盒列表（供新建实验用） ──
  const loadKits = async () => {
    try {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      const rows = await db.getAllAsync<{ id: number; name: string }>(
        "SELECT id, name FROM kits ORDER BY name"
      );
      setKits(rows);
    } catch { /* 表可能尚不存在 */ }
  };

  // ── 加载试剂盒库存汇总 ──
  const loadKitSummary = async () => {
    try {
      const allKits = await getKitSummaries();
      setKitSummary({
        count: allKits.length,
        lowStock: allKits.filter((k) => k.overallHealth < 0.3).length,
        loading: false,
      });
    } catch {
      setKitSummary({ count: 0, lowStock: 0, loading: false });
    }
  };

  // ── 打开新建实验 Modal ──
  const openExpModal = (projId: number) => {
    setExpTargetProjId(projId);
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
        `INSERT INTO experiments (project_id, kit_id, name, description, scheduled_date, status)
         VALUES (?, ?, ?, ?, ?, 'planned')`,
        [expTargetProjId, expKitId, name, expDesc.trim(), expDate]
      );
      setExpModalVisible(false);
      await loadProjects();
    } catch (err: any) {
      Alert.alert("错误", err.message ?? "创建失败");
    }
  };

  // ── 删除项目 ──
  const handleDeleteProject = (proj: ProjectWithStats) => {
    Alert.alert(
      "确认删除",
      `确定要删除项目「${proj.name}」吗？\n关联的 ${proj.todo_count} 个待办和 ${proj.experiment_count} 个实验将解除关联。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除", style: "destructive",
          onPress: async () => {
            try {
              await deleteProject(proj.id);
              if (expandedId === proj.id) setExpandedId(null);
            } catch (err: any) { Alert.alert("错误", err.message ?? "删除失败"); }
          },
        },
      ]
    );
  };

  // ── 添加待办 ──
  const handleAddTodo = async () => {
    if (!todoTitle.trim()) { Alert.alert("提示", "请输入待办内容"); return; }
    try {
      await addTodo(todoTitle.trim(), todoPriority, todoDueDate || null);
      setTodoTitle("");
      setTodoPriority("medium");
      setTodoDueDate("");
      await loadProjects(); // 刷新进度条
    } catch (err: any) { Alert.alert("错误", err.message ?? "添加失败"); }
  };

  // ── 切换待办 ──
  const handleToggleTodo = async (todo: Todo) => {
    try {
      await toggleTodo(todo.id, todo.done);
      await loadProjects();
    } catch (err: any) { Alert.alert("错误", err.message ?? "操作失败"); }
  };

  // ── 删除待办 ──
  const handleDeleteTodo = (todo: Todo) => {
    Alert.alert("确认删除", `删除待办「${todo.title}」？`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除", style: "destructive",
        onPress: async () => {
          try { await deleteTodo(todo.id); await loadProjects(); }
          catch (err: any) { Alert.alert("错误", err.message ?? "删除失败"); }
        },
      },
    ]);
  };

  // ── 格式化日期 ──
  const fmtDate = (dt: string) => {
    try { const d = new Date(dt); return `${d.getMonth() + 1}/${d.getDate()}`; }
    catch { return dt; }
  };

  // ════════════════════════════════════════════════════════════
  // 渲染
  // ════════════════════════════════════════════════════════════

  return (
    <SafeAreaView className="flex-1 bg-gray-50" edges={["top"]}>
      {/* ── 头部 ── */}
      <View className="bg-white px-5 pt-4 pb-3 border-b border-gray-100">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-2xl font-bold text-gray-900">项目管理</Text>
            <Text className="text-gray-400 text-sm mt-0.5">
              {projects.length} 个项目 ·{" "}
              {projects.filter((p) => p.status === "active").length} 进行中
            </Text>
          </View>
          <TouchableOpacity
            className="bg-primary-600 w-11 h-11 rounded-2xl items-center justify-center shadow-sm shadow-primary-300"
            activeOpacity={0.8}
            onPress={openCreateModal}
          >
            <Ionicons name="add" size={26} color="white" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── 列表 ── */}
      <ScrollView
        className="flex-1 px-4 pt-4"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={["#2563eb"]} tintColor="#2563eb" />
        }
      >
        {/* 试剂盒库存入口卡片 */}
        {!kitSummary.loading && (
          <TouchableOpacity
            className="bg-white rounded-2xl p-5 mb-3 shadow-sm border border-gray-100 flex-row items-center"
            activeOpacity={0.9}
            onPress={() => router.push("/kit-inventory")}
          >
            <View className="w-11 h-11 rounded-2xl bg-amber-100 items-center justify-center mr-3">
              <Ionicons name="cube-outline" size={22} color="#d97706" />
            </View>
            <View className="flex-1">
              <Text className="text-base font-bold text-gray-900">试剂盒库存</Text>
              <Text className="text-gray-400 text-xs mt-0.5">
                {kitSummary.count} 个试剂盒
                {kitSummary.lowStock > 0 && (
                  <Text className="text-red-500 font-semibold"> · {kitSummary.lowStock} 个低库存</Text>
                )}
              </Text>
            </View>
            {kitSummary.lowStock > 0 ? (
              <View className="bg-red-500 rounded-full w-6 h-6 items-center justify-center mr-2">
                <Text className="text-white text-xs font-bold">{kitSummary.lowStock}</Text>
              </View>
            ) : kitSummary.count > 0 ? (
              <View className="bg-emerald-100 rounded-full px-2.5 py-0.5 mr-2">
                <Text className="text-emerald-700 text-xs font-semibold">充足</Text>
              </View>
            ) : null}
            <Ionicons name="chevron-forward" size={18} color="#d1d5db" />
          </TouchableOpacity>
        )}

        {/* 骨架屏 */}
        {loading && projects.length === 0 && (
          <View>
            {[1, 2, 3].map((i) => (
              <View key={i} className="bg-white rounded-2xl p-5 h-28 mb-3 opacity-50">
                <View className="w-2/3 h-5 bg-gray-100 rounded mb-3" />
                <View className="w-1/2 h-4 bg-gray-50 rounded" />
              </View>
            ))}
          </View>
        )}

        {/* 空状态 */}
        {!loading && projects.length === 0 && (
          <View className="items-center py-16">
            <View className="w-20 h-20 rounded-full bg-primary-50 items-center justify-center mb-4">
              <Ionicons name="folder-open-outline" size={40} color="#93c5fd" />
            </View>
            <Text className="text-gray-400 text-lg font-medium">还没有项目</Text>
            <Text className="text-gray-300 text-sm mt-1 text-center px-8">
              点击右上角 + 创建你的第一个科研项目
            </Text>
          </View>
        )}

        {/* 项目卡片 */}
        {projects.map((proj) => {
          const isOpen = expandedId === proj.id;
          return (
            <View key={proj.id} className="mb-3">
              {/* ─── 卡片主体 ─── */}
              <TouchableOpacity
                className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100"
                activeOpacity={0.95}
                onPress={() => toggleExpand(proj.id)}
              >
                {/* 标题行 */}
                <View className="flex-row items-start">
                  <View className={`w-2.5 h-2.5 rounded-full mt-1.5 mr-2.5 ${STATUS_DOT[proj.status]}`} />
                  <View className="flex-1 mr-2">
                    <Text className="text-base font-bold text-gray-900" numberOfLines={1}>
                      {proj.name}
                    </Text>
                    {proj.description ? (
                      <Text className="text-gray-400 text-sm mt-0.5" numberOfLines={1}>
                        {proj.description}
                      </Text>
                    ) : null}
                  </View>
                  <StatusBadge status={proj.status} />
                </View>

                {/* 统计行 */}
                <View className="flex-row items-center mt-3">
                  <View className="flex-row items-center mr-4">
                    <Ionicons name="flask-outline" size={14} color="#9ca3af" />
                    <Text className="text-gray-400 text-xs ml-1">
                      {proj.experiment_count} 实验
                    </Text>
                  </View>
                  <View className="flex-row items-center mr-4">
                    <Ionicons name="checkbox-outline" size={14} color="#9ca3af" />
                    <Text className="text-gray-400 text-xs ml-1">
                      {proj.todo_done_count}/{proj.todo_count} 待办
                    </Text>
                  </View>
                  <View className="flex-1" />
                  <Ionicons
                    name={isOpen ? "chevron-up" : "chevron-down"}
                    size={18} color="#d1d5db"
                  />
                </View>

                {/* 进度条 */}
                {proj.todo_count > 0 && (
                  <View className="mt-3">
                    <ProgressBar done={proj.todo_done_count} total={proj.todo_count} />
                  </View>
                )}
              </TouchableOpacity>

              {/* ─── 展开区 ─── */}
              {isOpen && (
                <View className="bg-white mx-1 rounded-b-2xl px-5 pb-5 border border-t-0 border-gray-100 -mt-1">
                  {/* 操作按钮 */}
                  <View className="flex-row justify-end space-x-2 mt-2 mb-3">
                    <TouchableOpacity
                      className="flex-row items-center bg-primary-50 px-3 py-1.5 rounded-lg border border-primary-200"
                      onPress={() => openExpModal(proj.id)}
                    >
                      <Ionicons name="add-circle-outline" size={16} color="#2563eb" />
                      <Text className="text-primary-600 text-xs font-semibold ml-1">新建实验</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      className="flex-row items-center bg-gray-50 px-3 py-1.5 rounded-lg"
                      onPress={() => {
                        const next: Record<string, ProjectWithStats["status"]> = {
                          active: "paused", paused: "active",
                          completed: "active", archived: "active",
                        };
                        updateStatus(proj.id, next[proj.status]);
                      }}
                    >
                      <Ionicons
                        name={proj.status === "active" ? "pause-circle-outline" : "play-circle-outline"}
                        size={16} color="#6b7280"
                      />
                      <Text className="text-gray-500 text-xs ml-1">
                        {proj.status === "active" ? "暂停" : "恢复"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      className="flex-row items-center bg-gray-50 px-3 py-1.5 rounded-lg"
                      onPress={() => openEditModal(proj)}
                    >
                      <Ionicons name="create-outline" size={16} color="#6b7280" />
                      <Text className="text-gray-500 text-xs ml-1">编辑</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      className="flex-row items-center bg-red-50 px-3 py-1.5 rounded-lg"
                      onPress={() => handleDeleteProject(proj)}
                    >
                      <Ionicons name="trash-outline" size={16} color="#ef4444" />
                      <Text className="text-red-500 text-xs ml-1">删除</Text>
                    </TouchableOpacity>
                  </View>

                  <View className="h-px bg-gray-100 mb-3" />

                  {/* 待办标题 */}
                  <Text className="text-sm font-semibold text-gray-600 mb-2">
                    待办事项 · {completionRate()}% 完成
                  </Text>

                  {/* 待办列表 */}
                  {todos.length === 0 ? (
                    <Text className="text-gray-300 text-xs py-3 text-center">
                      暂无待办，在下方添加
                    </Text>
                  ) : (
                    todos.map((todo) => (
                      <View key={todo.id} className="flex-row items-center py-2.5 border-b border-gray-50">
                        <TouchableOpacity
                          className={`w-5 h-5 rounded-md border-2 mr-3 items-center justify-center ${
                            todo.done === 1
                              ? "bg-primary-500 border-primary-500"
                              : "border-gray-300"
                          }`}
                          onPress={() => handleToggleTodo(todo)}
                        >
                          {todo.done === 1 && (
                            <Ionicons name="checkmark" size={13} color="white" />
                          )}
                        </TouchableOpacity>
                        <View className="flex-1">
                          <Text
                            className={`text-sm ${
                              todo.done === 1
                                ? "text-gray-300 line-through"
                                : "text-gray-800"
                            }`}
                            numberOfLines={1}
                          >
                            {todo.title}
                          </Text>
                          {todo.due_date && (
                            <Text className="text-gray-400 text-xs mt-0.5">
                              📅 {fmtDate(todo.due_date)}
                            </Text>
                          )}
                        </View>
                        <PriorityBadge priority={todo.priority} />
                        <TouchableOpacity
                          className="ml-2 p-1"
                          onPress={() => handleDeleteTodo(todo)}
                        >
                          <Ionicons name="close-circle-outline" size={18} color="#d1d5db" />
                        </TouchableOpacity>
                      </View>
                    ))
                  )}

                  {/* 添加待办 */}
                  <View className="mt-3">
                    <View className="flex-row items-center space-x-2 mb-2">
                      <TextInput
                        className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800"
                        placeholder="新待办事项..."
                        placeholderTextColor="#d1d5db"
                        value={todoTitle}
                        onChangeText={setTodoTitle}
                        onSubmitEditing={handleAddTodo}
                        returnKeyType="done"
                      />
                      <TouchableOpacity
                        className="bg-primary-500 w-9 h-9 rounded-xl items-center justify-center"
                        onPress={handleAddTodo}
                        disabled={!todoTitle.trim()}
                      >
                        <Ionicons name="add" size={20} color="white" />
                      </TouchableOpacity>
                    </View>
                    {/* 优先级选择 */}
                    <View className="flex-row items-center space-x-2">
                      <View className="flex-row bg-gray-50 rounded-lg p-0.5">
                        {(["urgent", "high", "medium", "low"] as Todo["priority"][]).map((p) => (
                          <TouchableOpacity
                            key={p}
                            className={`px-2.5 py-1 rounded-md ${
                              todoPriority === p
                                ? `${PRIORITY_CONFIG[p].bg} ${PRIORITY_CONFIG[p].border} border`
                                : ""
                            }`}
                            onPress={() => setTodoPriority(p)}
                          >
                            <Text
                              className={`text-xs font-medium ${
                                todoPriority === p ? PRIORITY_CONFIG[p].text : "text-gray-400"
                              }`}
                            >
                              {PRIORITY_CONFIG[p].label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                      <TextInput
                        className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-600"
                        placeholder="截止日期 (YYYY-MM-DD)"
                        placeholderTextColor="#d1d5db"
                        value={todoDueDate}
                        onChangeText={setTodoDueDate}
                        keyboardType="numbers-and-punctuation"
                      />
                    </View>
                  </View>
                </View>
              )}
            </View>
          );
        })}
        <View className="h-6" />
      </ScrollView>

      {/* ════════════════════════════════════════════════════════ */}
      {/* 新建/编辑项目 Modal */}
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
            className="bg-white rounded-t-3xl px-5 pt-6 pb-10"
            onPress={(e) => e.stopPropagation()}
          >
            <View className="w-10 h-1 bg-gray-200 rounded-full self-center mb-5" />
            <Text className="text-xl font-bold text-gray-900 mb-5">
              {editingProject ? "编辑项目" : "创建新项目"}
            </Text>

            <Text className="text-sm font-semibold text-gray-600 mb-1.5">项目名称 *</Text>
            <TextInput
              className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 mb-4"
              placeholder="输入项目名称"
              placeholderTextColor="#d1d5db"
              value={formName}
              onChangeText={setFormName}
              autoFocus
              maxLength={100}
            />

            <Text className="text-sm font-semibold text-gray-600 mb-1.5">描述</Text>
            <TextInput
              className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base text-gray-800 mb-6"
              placeholder="简要描述项目目标或背景..."
              placeholderTextColor="#d1d5db"
              value={formDesc}
              onChangeText={setFormDesc}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              maxLength={500}
            />

            <View className="flex-row space-x-3">
              <TouchableOpacity
                className="flex-1 bg-gray-100 py-3.5 rounded-xl items-center"
                onPress={() => setModalVisible(false)}
              >
                <Text className="text-gray-600 font-semibold">取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                className="flex-1 bg-primary-600 py-3.5 rounded-xl items-center shadow-sm shadow-primary-300"
                onPress={submitForm}
              >
                <Text className="text-white font-semibold">
                  {editingProject ? "保存修改" : "创建项目"}
                </Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

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
