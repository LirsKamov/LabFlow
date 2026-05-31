import { useState, useRef, useCallback, useEffect } from "react";
import * as Notifications from "expo-notifications";
import { Alert } from "react-native";

/**
 * 实验步骤倒计时器 Hook
 *
 * 功能：
 *  - 启动/暂停/恢复/重置 倒计时
 *  - 计时结束时通过 expo-notifications 发出本地通知
 *  - 返回格式化时间、进度百分比
 */

export interface TimerState {
  /** 当前倒计时的步骤 ID */
  stepId: number | null;
  /** 步骤标题（用于通知内容） */
  stepTitle: string;
  /** 是否正在计时 */
  isRunning: boolean;
  /** 是否已暂停 */
  isPaused: boolean;
  /** 剩余秒数 */
  remainingSeconds: number;
  /** 总秒数 */
  totalSeconds: number;
  /** 进度 (0-1) */
  progress: number;
  /** 已安排的本地通知 ID */
  notificationId: string | null;
}

const INITIAL_STATE: TimerState = {
  stepId: null,
  stepTitle: "",
  isRunning: false,
  isPaused: false,
  remainingSeconds: 0,
  totalSeconds: 0,
  progress: 0,
  notificationId: null,
};

export function useTimer() {
  const [state, setState] = useState<TimerState>(INITIAL_STATE);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 组件卸载时清理 ──
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // ── 取消已安排的通知 ──
  const cancelNotification = useCallback(async (nid: string | null) => {
    if (nid) {
      try {
        await Notifications.cancelScheduledNotificationAsync(nid);
      } catch {
        /* 通知可能已触发 */
      }
    }
  }, []);

  // ── 安排通知 ──
  const scheduleNotification = useCallback(
    async (
      stepId: number,
      stepTitle: string,
      secondsFromNow: number
    ): Promise<string> => {
      return await Notifications.scheduleNotificationAsync({
        content: {
          title: "⏰ 步骤计时完成",
          body: `「${stepTitle}」已完成`,
          sound: "default",
          data: { stepId, type: "timer" },
          ...(Notifications.AndroidImportance
            ? {}
            : {}),
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: secondsFromNow,
          channelId: "labflow-timers",
        },
      });
    },
    []
  );

  // ── 启动计时 ──
  const startTimer = useCallback(
    async (stepId: number, stepTitle: string, durationMin: number) => {
      if (durationMin <= 0) return;

      // 清理之前的计时器
      if (intervalRef.current) clearInterval(intervalRef.current);
      await cancelNotification(state.notificationId);

      const totalSeconds = Math.round(durationMin * 60);

      try {
        const nid = await scheduleNotification(stepId, stepTitle, totalSeconds);

        setState({
          stepId,
          stepTitle,
          isRunning: true,
          isPaused: false,
          remainingSeconds: totalSeconds,
          totalSeconds,
          progress: 0,
          notificationId: nid,
        });

        // 每秒递减
        intervalRef.current = setInterval(() => {
          setState((prev) => {
            if (prev.remainingSeconds <= 1) {
              if (intervalRef.current) clearInterval(intervalRef.current);
              return {
                ...prev,
                isRunning: false,
                isPaused: false,
                remainingSeconds: 0,
                progress: 1,
                notificationId: null,
              };
            }
            const next = prev.remainingSeconds - 1;
            return {
              ...prev,
              remainingSeconds: next,
              progress: 1 - next / prev.totalSeconds,
            };
          });
        }, 1000);
      } catch (error) {
        Alert.alert("计时器启动失败", "请检查通知权限设置");
        console.error("[useTimer] 启动失败:", error);
      }
    },
    [cancelNotification, scheduleNotification, state.notificationId]
  );

  // ── 暂停计时 ──
  const pauseTimer = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    // 取消对应的通知
    await cancelNotification(state.notificationId);
    setState((prev) => ({
      ...prev,
      isRunning: false,
      isPaused: true,
      notificationId: null,
    }));
  }, [cancelNotification, state.notificationId]);

  // ── 恢复计时 ──
  const resumeTimer = useCallback(async () => {
    if (state.remainingSeconds <= 0) return;

    try {
      const nid = await scheduleNotification(
        state.stepId!,
        state.stepTitle,
        state.remainingSeconds
      );

      setState((prev) => ({
        ...prev,
        isRunning: true,
        isPaused: false,
        notificationId: nid,
      }));

      intervalRef.current = setInterval(() => {
        setState((prev) => {
          if (prev.remainingSeconds <= 1) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            return {
              ...prev,
              isRunning: false,
              isPaused: false,
              remainingSeconds: 0,
              progress: 1,
              notificationId: null,
            };
          }
          const next = prev.remainingSeconds - 1;
          return {
            ...prev,
            remainingSeconds: next,
            progress: 1 - next / prev.totalSeconds,
          };
        });
      }, 1000);
    } catch (error) {
      Alert.alert("恢复计时失败", "请检查通知权限");
    }
  }, [
    cancelNotification,
    scheduleNotification,
    state.remainingSeconds,
    state.stepId,
    state.stepTitle,
  ]);

  // ── 重置计时 ──
  const resetTimer = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    await cancelNotification(state.notificationId);
    setState(INITIAL_STATE);
  }, [cancelNotification, state.notificationId]);

  // ── 格式化时间为 MM:SS ──
  const formattedTime = ((): string => {
    const m = Math.floor(state.remainingSeconds / 60);
    const s = state.remainingSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  })();

  return {
    ...state,
    formattedTime,
    startTimer,
    pauseTimer,
    resumeTimer,
    resetTimer,
  };
}
