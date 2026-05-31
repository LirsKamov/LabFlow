import { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, TouchableOpacity, Image, TextInput, Alert,
  Dimensions, PanResponder, GestureResponderEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Svg, {
  Line, Circle, Rect, Text as SvgText, Polygon, G,
} from "react-native-svg";
import { saveAnnotations, loadAnnotations } from "../services/annotationService";
import type { Annotation } from "../db/schema";

// ─── Types ──────────────────────────────────────────────────

type ToolType = "arrow" | "circle" | "rect" | "text" | "line" | "eraser";

interface DraftAnnotation {
  type: ToolType;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
}

const COLORS = ["#E8503A", "#3B8BD4", "#10B981", "#F59E0B"];
const STROKE_WIDTHS = [1, 2, 4];

const { width: SCREEN_W } = Dimensions.get("window");

// ─── Component ──────────────────────────────────────────────

interface Props {
  imageId: number;
  imageUri: string;
  imgWidth: number;
  imgHeight: number;
  onSave: () => void;
  onClose: () => void;
}

export default function ImageAnnotator({
  imageId, imageUri, imgWidth, imgHeight, onSave, onClose,
}: Props) {
  const [tool, setTool] = useState<ToolType>("arrow");
  const [color, setColor] = useState(COLORS[0]);
  const [strokeW, setStrokeW] = useState(2);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [history, setHistory] = useState<Annotation[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textInputVisible, setTextInputVisible] = useState(false);
  const [textInputPos, setTextInputPos] = useState({ x: 0, y: 0 });
  const [textValue, setTextValue] = useState("");
  const [imageViewSize, setImageViewSize] = useState({ w: SCREEN_W, h: 300 });

  // ── Load annotations ──
  useEffect(() => {
    loadAnnotations(imageId).then(setAnnotations);
  }, [imageId]);

  // ── Calculate image display size (contain mode) ──
  const calcImageLayout = useCallback(() => {
    const maxW = SCREEN_W;
    const maxH = Dimensions.get("window").height * 0.55;
    const ratio = Math.min(maxW / (imgWidth || 1), maxH / (imgHeight || 1));
    setImageViewSize({ w: (imgWidth || 400) * ratio, h: (imgHeight || 300) * ratio });
  }, [imgWidth, imgHeight]);

  useEffect(() => { calcImageLayout(); }, [calcImageLayout]);

  // ── Push history ──
  const pushHistory = useCallback((anns: Annotation[]) => {
    setHistory((prev) => [...prev.slice(-19), anns]);
  }, []);

  // ── Undo ──
  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setAnnotations(prev);
  };

  // ── Add annotation ──
  const addAnnotation = (ann: Annotation) => {
    pushHistory(annotations);
    const next = [...annotations.filter((a) => a.id !== ann.id), ann];
    setAnnotations(next);
  };

  // ── Remove annotation ──
  const removeAnnotation = (id: string) => {
    pushHistory(annotations);
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedId(null);
  };

  // ── Move annotation ──
  const moveAnnotation = (id: string, dx: number, dy: number) => {
    setAnnotations((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        const moved = { ...a };
        if (a.type === "arrow" || a.type === "line") {
          moved.x1 = (a.x1 ?? 0) + dx; moved.y1 = (a.y1 ?? 0) + dy;
          moved.x2 = (a.x2 ?? 0) + dx; moved.y2 = (a.y2 ?? 0) + dy;
        } else if (a.type === "circle") {
          moved.cx = (a.cx ?? 0) + dx; moved.cy = (a.cy ?? 0) + dy;
        } else if (a.type === "rect" || a.type === "text") {
          moved.x = (a.x ?? 0) + dx; moved.y = (a.y ?? 0) + dy;
        }
        return moved;
      })
    );
  };

  // ── PanResponder for drawing ──
  const panRef = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        const { locationX, locationY } = e.nativeEvent;
        if (tool === "text") {
          setTextInputPos({ x: locationX, y: locationY });
          setTextValue("");
          setTextInputVisible(true);
          return;
        }
        if (tool === "eraser") {
          // Find nearest annotation to click point
          let minDist = 30;
          let nearest: string | null = null;
          for (const a of annotations) {
            const ax = a.type === "arrow" || a.type === "line" ? (a.x1 ?? 0) :
                       a.type === "circle" ? (a.cx ?? 0) : (a.x ?? 0);
            const ay = a.type === "arrow" || a.type === "line" ? (a.y1 ?? 0) :
                       a.type === "circle" ? (a.cy ?? 0) : (a.y ?? 0);
            const dist = Math.hypot(locationX - ax, locationY - ay);
            if (dist < minDist) { minDist = dist; nearest = a.id; }
          }
          if (nearest) removeAnnotation(nearest);
          return;
        }
        // Check if tapping on existing annotation to select
        for (const a of annotations) {
          const ax = a.type === "arrow" || a.type === "line" ? (a.x1 ?? 0) : a.type === "circle" ? (a.cx ?? 0) : (a.x ?? 0);
          const ay = a.type === "arrow" || a.type === "line" ? (a.y1 ?? 0) : a.type === "circle" ? (a.cy ?? 0) : (a.y ?? 0);
          if (Math.hypot(locationX - ax, locationY - ay) < 20) {
            setSelectedId(a.id);
            return;
          }
        }
        setSelectedId(null);
        setDraft({ type: tool, x1: locationX, y1: locationY, x2: locationX, y2: locationY, color, strokeWidth: strokeW });
      },
      onPanResponderMove: (e: GestureResponderEvent) => {
        if (!draft) {
          // Drag selected annotation
          if (selectedId) {
            const { dx, dy } = e.nativeEvent as any;
            if (Math.abs(dx || 0) + Math.abs(dy || 0) > 2) {
              moveAnnotation(selectedId, (dx || 0) * 0.3, (dy || 0) * 0.3);
            }
          }
          return;
        }
        setDraft((prev) => prev ? { ...prev, x2: e.nativeEvent.locationX, y2: e.nativeEvent.locationY } : null);
      },
      onPanResponderRelease: () => {
        if (!draft) return;
        const { x1, y1, x2, y2, color: c, strokeWidth: sw, type: t } = draft;
        const id = `a${Date.now()}`;
        let ann: Annotation;
        switch (t) {
          case "arrow":
            ann = { type: "arrow", id, x1, y1, x2, y2, color: c, strokeWidth: sw };
            break;
          case "circle":
            ann = { type: "circle", id, cx: x1, cy: y1, r: Math.hypot(x2 - x1, y2 - y1), color: c, strokeWidth: sw, filled: false };
            break;
          case "rect":
            ann = { type: "rect", id, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), color: c, strokeWidth: sw, filled: false };
            break;
          case "line":
            ann = { type: "line", id, x1, y1, x2, y2, color: c, strokeWidth: sw, dashed: false };
            break;
          default: ann = { type: "arrow", id, x1, y1, x2, y2, color: c, strokeWidth: sw };
        }
        if (Math.abs(x2 - x1) > 3 || Math.abs(y2 - y1) > 3) {
          addAnnotation(ann);
        }
        setDraft(null);
      },
    })
  ).current;

  // ── Confirm text annotation ──
  const confirmText = () => {
    if (!textValue.trim()) { setTextInputVisible(false); return; }
    const id = `t${Date.now()}`;
    addAnnotation({
      type: "text", id, x: textInputPos.x, y: textInputPos.y,
      text: textValue, color, fontSize: 14, fontWeight: "bold", strokeWidth: 0,
    });
    setTextInputVisible(false);
  };

  // ── Save ──
  const handleSave = async () => {
    try {
      await saveAnnotations(imageId, annotations);
      onSave();
    } catch (e: any) {
      Alert.alert("保存失败", e?.message);
    }
  };

  // ── Render annotation SVG ──
  const renderAnnotation = (a: Annotation, isSelected: boolean) => {
    const extra = isSelected ? { stroke: "#3b82f6", strokeWidth: (a.strokeWidth || 1) + 2, strokeDasharray: "4,2" as string | undefined } : {};
    const mainStroke = isSelected ? "#3b82f6" : a.color;
    const mainSW = isSelected ? (a.strokeWidth || 1) + 1 : a.strokeWidth;

    switch (a.type) {
      case "arrow":
        return (
          <G key={a.id}>
            <Line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={mainStroke} strokeWidth={mainSW} />
            {/* Arrowhead */}
            <Polygon
              points={`${a.x2},${a.y2} ${a.x2 - 8},${a.y2 - 4} ${a.x2 - 8},${a.y2 + 4}`}
              fill={mainStroke}
              rotation={Math.atan2((a.y2 ?? 0) - (a.y1 ?? 0), (a.x2 ?? 0) - (a.x1 ?? 0)) * (180 / Math.PI)}
              origin={`${a.x2}, ${a.y2}`}
            />
          </G>
        );
      case "circle":
        return <Circle key={a.id} cx={a.cx} cy={a.cy} r={a.r} stroke={mainStroke} strokeWidth={mainSW} fill={a.filled ? mainStroke : "transparent"} {...extra} />;
      case "rect":
        return <Rect key={a.id} x={a.x} y={a.y} width={a.w} height={a.h} stroke={mainStroke} strokeWidth={mainSW} fill={a.filled ? mainStroke : "transparent"} {...extra} />;
      case "text":
        return <SvgText key={a.id} x={a.x} y={a.y} fill={a.color} fontSize={a.fontSize ?? 14} fontWeight={a.fontWeight ?? "bold"}>{a.text}</SvgText>;
      case "line":
        return <Line key={a.id} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={mainStroke} strokeWidth={mainSW} strokeDasharray={a.dashed ? "6,3" : undefined} {...extra} />;
      default: return null;
    }
  };

  // ── Render draft ──
  const renderDraft = () => {
    if (!draft) return null;
    const { x1, y1, x2, y2, color: c, strokeWidth: sw, type: t } = draft;
    switch (t) {
      case "arrow":
        return <G><Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={sw} strokeDasharray="4,3" opacity={0.7} /></G>;
      case "circle":
        return <Circle cx={x1} cy={y1} r={Math.hypot(x2 - x1, y2 - y1)} stroke={c} strokeWidth={sw} fill="transparent" strokeDasharray="4,3" opacity={0.7} />;
      case "rect":
        return <Rect x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} stroke={c} strokeWidth={sw} fill="transparent" strokeDasharray="4,3" opacity={0.7} />;
      case "line":
        return <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={sw} strokeDasharray="4,3" opacity={0.7} />;
      default: return null;
    }
  };

  // ════════════════════════════════════════════════════════════
  return (
    <View className="flex-1 bg-black">
      {/* ── Top Toolbar ── */}
      <View className="flex-row items-center justify-between px-3 py-2 bg-gray-900" style={{ height: 48 }}>
        <TouchableOpacity onPress={onClose} className="px-2">
          <Text className="text-white text-sm">取消</Text>
        </TouchableOpacity>

        {/* Tools */}
        <View className="flex-row space-x-1">
          {(["arrow", "circle", "rect", "text", "line", "eraser"] as ToolType[]).map((t) => {
            const icons: Record<ToolType, React.ComponentProps<typeof Ionicons>["name"]> = {
              arrow: "arrow-up-right", circle: "ellipse-outline", rect: "square-outline",
              text: "text", line: "remove-outline", eraser: "backspace-outline",
            };
            return (
              <TouchableOpacity key={t}
                className={`w-9 h-9 rounded-lg items-center justify-center ${tool === t ? "bg-blue-600" : "bg-gray-800"}`}
                onPress={() => { setTool(t); setSelectedId(null); }}>
                <Ionicons name={icons[t]} size={16} color="white" />
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Colors + Save */}
        <View className="flex-row items-center space-x-2">
          {COLORS.map((c) => (
            <TouchableOpacity key={c} className={`w-6 h-6 rounded-full ${color === c ? "border-2 border-white" : ""}`} style={{ backgroundColor: c }}
              onPress={() => setColor(c)} />
          ))}
          <TouchableOpacity className="bg-blue-600 px-3 py-1.5 rounded-lg" onPress={handleSave}>
            <Text className="text-white text-xs font-semibold">保存</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Canvas ── */}
      <View className="flex-1 items-center justify-center bg-gray-800" {...panRef.panHandlers}>
        <View style={{ width: imageViewSize.w, height: imageViewSize.h }}>
          <Image
            source={{ uri: imageUri }}
            style={{ width: imageViewSize.w, height: imageViewSize.h }}
            resizeMode="contain"
          />
          <Svg
            style={{ position: "absolute", top: 0, left: 0 }}
            width={imageViewSize.w}
            height={imageViewSize.h}
          >
            {annotations.map((a) => renderAnnotation(a, a.id === selectedId))}
            {renderDraft()}
          </Svg>
        </View>
      </View>

      {/* ── Bottom Bar ── */}
      <View className="flex-row items-center justify-between px-4 py-2 bg-gray-900" style={{ height: 56 }}>
        {/* Stroke width */}
        <View className="flex-row items-center space-x-1">
          <Text className="text-gray-400 text-xs mr-1">线宽</Text>
          {STROKE_WIDTHS.map((w) => (
            <TouchableOpacity key={w}
              className={`w-8 h-8 rounded-lg items-center justify-center ${strokeW === w ? "bg-blue-600" : "bg-gray-800"}`}
              onPress={() => setStrokeW(w)}>
              <View style={{ width: w * 4, height: w, backgroundColor: "white", borderRadius: w / 2 }} />
            </TouchableOpacity>
          ))}
        </View>
        {/* Actions */}
        <View className="flex-row space-x-2">
          <TouchableOpacity className="bg-gray-800 px-3 py-1.5 rounded-lg" onPress={undo}>
            <Text className="text-white text-xs">撤销</Text>
          </TouchableOpacity>
          <TouchableOpacity className="bg-red-900 px-3 py-1.5 rounded-lg" onPress={() => {
            Alert.alert("清除全部", "确定清除所有标注？", [
              { text: "取消", style: "cancel" },
              { text: "清除", style: "destructive", onPress: () => { pushHistory(annotations); setAnnotations([]); } },
            ]);
          }}>
            <Text className="text-red-300 text-xs">清除全部</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Text Input Modal ── */}
      {textInputVisible && (
        <View className="absolute inset-0 bg-black/50 justify-center items-center px-6">
          <View className="bg-white rounded-2xl p-5 w-full">
            <Text className="text-lg font-bold text-gray-900 mb-3">输入文字标注</Text>
            <TextInput
              className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-base mb-4"
              value={textValue} onChangeText={setTextValue}
              placeholder="标注文字..." autoFocus
              onSubmitEditing={confirmText}
            />
            <View className="flex-row space-x-3">
              <TouchableOpacity className="flex-1 bg-gray-100 py-3 rounded-xl items-center" onPress={() => setTextInputVisible(false)}>
                <Text className="text-gray-600 font-semibold">取消</Text>
              </TouchableOpacity>
              <TouchableOpacity className="flex-1 bg-primary-600 py-3 rounded-xl items-center" onPress={confirmText}>
                <Text className="text-white font-semibold">确定</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
