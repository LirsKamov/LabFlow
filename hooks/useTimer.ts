import { useState, useRef, useCallback, useEffect } from "react";
import * as Notifications from "expo-notifications";
import { Alert, AppState } from "react-native";

/**
 * 实验步骤倒计时器 Hook
 *
 * 功能：
 *  - 启动/暂停/恢复/重置 倒计时
 *  - 计时结束时通过 expo-notifications 发出本地通知
 *  - 返回格式化时间、进度百分比
 *  - 记录目标结束绝对时间，App 回到前台时按 endTime 重算剩余时间，
 *    避免 setInterval 在后台被节流导致的计时漂移
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
  /** 最新已安排的本地通知 ID（供卸载清理与各回调共享，避免陈旧闭包） */
  const notificationIdRef = useRef<string | null>(null);
  /** 目标结束绝对时间（ms）；非空即表示计时进行中 */
  const endTimeRef = useRef<number | null>(null);

  // ── 组件卸载时清理：清空定时器并取消已调度的通知 ──
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (notificationIdRef.current) {
        Notifications.cancelScheduledNotificationAsync(
          notificationIdRef.current
        ).catch(() => {
          /* 通知可能已触发 */
        });
        notificationIdRef.current = null;
      }
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
    if (notificationIdRef.current === nid) {
      notificationIdRef.current = null;
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
        },
        trigger: {
          seconds: secondsFromNow,
          channelId: "labflow-timers",
        },
      });
    },
    []
  );

  // ── 计时结束（共用逻辑：清定时器、取消通知、置结束状态） ──
  const finishTimer = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const nid = notificationIdRef.current;
    notificationIdRef.current = null;
    endTimeRef.current = null;
    if (nid) {
      try {
        await Notifications.cancelScheduledNotificationAsync(nid);
      } catch {
        /* 通知可能已触发 */
      }
    }
    setState((prev) => ({
      ...prev,
      isRunning: false,
      isPaused: false,
      remainingSeconds: 0,
      progress: 1,
      notificationId: null,
    }));
  }, []);

  // ── App 回到前台时按 endTime 重算剩余时间，消除后台漂移 ──
  useEffect(() => {
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active" || endTimeRef.current === null) return;
      const remaining = Math.max(
        0,
        Math.round((endTimeRef.current - Date.now()) / 1000)
      );
      if (remaining <= 0) {
        finishTimer();
        return;
      }
      setState((prev) => ({
        ...prev,
        remainingSeconds: remaining,
        progress: 1 - remaining / prev.totalSeconds,
      }));
    });
    return () => sub.remove();
  }, [finishTimer]);

  // ── 启动计时 ──
  const startTimer = useCallback(
    async (stepId: number, stepTitle: string, durationMin: number) => {
      if (durationMin <= 0) return;
      // 防双击重复启动（幂等守卫，避免重复通知）
      if (endTimeRef.current !== null) return;

      // 清理之前的计时器
      if (intervalRef.current) clearInterval(intervalRef.current);
      await cancelNotification(notificationIdRef.current);

      const totalSeconds = Math.round(durationMin * 60);
      endTimeRef.current = Date.now() + totalSeconds * 1000;

      try {
        const nid = await scheduleNotification(stepId, stepTitle, totalSeconds);
        notificationIdRef.current = nid;

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
              notificationIdRef.current = null;
              endTimeRef.current = null;
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
        endTimeRef.current = null;
        Alert.alert("计时器启动失败", "请检查通知权限设置");
        console.error("[useTimer] 启动失败:", error);
      }
    },
    [cancelNotification, scheduleNotification]
  );

  // ── 暂停计时 ──
  const pauseTimer = useCallback(async () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    let remaining = 0;
    if (endTimeRef.current !== null) {
      remaining = Math.max(
        0,
        Math.round((endTimeRef.current - Date.now()) / 1000)
      );
    }
    endTimeRef.current = null;
    // 取消对应的通知
    await cancelNotification(notificationIdRef.current);
    setState((prev) => ({
      ...prev,
      remainingSeconds: remaining,
      isRunning: false,
      isPaused: true,
      notificationId: null,
    }));
  }, [cancelNotification]);

  // ── 恢复计时 ──
  const resumeTimer = useCallback(async () => {
    if (state.remainingSeconds <= 0) return;
    // 防御：stepId 缺失时重置状态（避免非空断言）
    if (state.stepId === null) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      await cancelNotification(notificationIdRef.current);
      setState(INITIAL_STATE);
      return;
    }

    try {
      const nid = await scheduleNotification(
        state.stepId,
        state.stepTitle,
        state.remainingSeconds
      );
      notificationIdRef.current = nid;
      endTimeRef.current = Date.now() + state.remainingSeconds * 1000;

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
            notificationIdRef.current = null;
            endTimeRef.current = null;
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
      endTimeRef.current = null;
      Alert.alert("恢复计时失败", "请检查通知权限");
      console.error("[useTimer] 恢复失败:", error);
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
    endTimeRef.current = null;
    await cancelNotification(notificationIdRef.current);
    setState(INITIAL_STATE);
  }, [cancelNotification]);

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
