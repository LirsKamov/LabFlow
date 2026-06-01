import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ActivityIndicator, View, Text } from "react-native";
import * as SQLite from "expo-sqlite";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { Platform } from "react-native";

import "../global.css";
import { ALL_CREATE_STATEMENTS, ALL_MIGRATIONS, SEED_SOP_TEMPLATES } from "../db/schema";

// ─── 通知配置 ────────────────────────────────────────────────

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldVibrate: true,
  }),
});

// ─── 数据库初始化 ────────────────────────────────────────────

async function initDatabase(): Promise<void> {
  try {
    const db = await SQLite.openDatabaseAsync("labflow.db");

    // 开启 WAL 模式提升并发性能
    await db.execAsync("PRAGMA journal_mode = WAL;");

    // 建表期间关闭外键约束，避免顺序依赖问题
    await db.execAsync("PRAGMA foreign_keys = OFF;");

    // 按依赖层级顺序执行所有建表语句（过滤空值以防模块加载顺序问题）
    for (const stmt of ALL_CREATE_STATEMENTS) {
      if (stmt) await db.execAsync(stmt);
    }

    // 运行迁移（允许失败 — 列可能已存在）
    for (const stmt of ALL_MIGRATIONS) {
      if (stmt) { try { await db.execAsync(stmt); } catch { /* 列已存在 */ } }
    }

    // 执行种子数据（如果有）
    if (SEED_SOP_TEMPLATES) {
      try { await db.execAsync(SEED_SOP_TEMPLATES); } catch { /* 种子数据已存在或外键不匹配 */ }
    }

    // 建表完成后重新开启外键约束
    await db.execAsync("PRAGMA foreign_keys = ON;");

    console.log("[LabFlow] 数据库初始化完成");
  } catch (error) {
    console.error("[LabFlow] 数据库初始化失败:", error);
    throw error;
  }
}

// ─── 通知权限注册 ────────────────────────────────────────────

async function registerForPushNotifications(): Promise<boolean> {
  if (!Device.isDevice) {
    console.log("[LabFlow] 模拟器环境，跳过通知注册");
    return false;
  }

  try {
    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      console.log("[LabFlow] 通知权限未授予");
      return false;
    }

    // Android 需要创建通知渠道
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("labflow-timers", {
        name: "实验计时提醒",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#3b82f6",
        sound: "default",
        enableVibrate: true,
      });

      await Notifications.setNotificationChannelAsync("labflow-daily", {
        name: "每日实验计划",
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 100, 100, 100],
        lightColor: "#10b981",
        sound: "default",
      });
    }

    console.log("[LabFlow] 通知权限注册成功");
    return true;
  } catch (error) {
    console.error("[LabFlow] 通知注册失败:", error);
    return false;
  }
}

// ─── 根布局组件 ──────────────────────────────────────────────

export default function RootLayout() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    async function bootstrap() {
      try {
        await initDatabase();
        await registerForPushNotifications();
        setDbReady(true);
      } catch (err: any) {
        setDbError(err.message ?? "数据库初始化失败");
      }
    }
    bootstrap();
  }, []);

  // ── 加载中 ──
  if (!dbReady && !dbError) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-primary-800">
          <ActivityIndicator size="large" color="#ffffff" />
          <Text className="text-white text-lg mt-4 font-semibold">
            LabFlow
          </Text>
          <Text className="text-blue-200 text-sm mt-2">
            正在初始化数据库...
          </Text>
        </View>
      </GestureHandlerRootView>
    );
  }

  // ── 错误状态 ──
  if (dbError) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View className="flex-1 items-center justify-center bg-red-50 px-6">
          <Text className="text-red-600 text-xl font-bold mb-2">
            初始化失败
          </Text>
          <Text className="text-red-500 text-center text-sm">{dbError}</Text>
          <Text className="text-gray-500 text-center text-xs mt-4">
            请重启应用或联系技术支持
          </Text>
        </View>
      </GestureHandlerRootView>
    );
  }

  // ── 正常渲染 ──
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: "slide_from_right",
          contentStyle: { backgroundColor: "#f8fafc" },
        }}
      >
        <Stack.Screen
          name="(tabs)"
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="settings"
          options={{
            presentation: "modal",
            headerShown: false,
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen
          name="kit-parser"
          options={{
            presentation: "modal",
            headerShown: false,
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen
          name="kit-inventory"
          options={{
            presentation: "modal",
            headerShown: false,
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen
          name="templates"
          options={{
            presentation: "modal",
            headerShown: false,
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen
          name="samples"
          options={{
            presentation: "modal",
            headerShown: false,
            animation: "slide_from_bottom",
          }}
        />
        <Stack.Screen
          name="export"
          options={{
            presentation: "modal",
            headerShown: false,
            animation: "slide_from_bottom",
          }}
        />
      </Stack>
    </GestureHandlerRootView>
  );
}
