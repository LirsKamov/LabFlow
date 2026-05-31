/**
 * 图片标注服务
 *
 * 设计原则：原始图片永不修改，标注以 JSON 元数据存储。
 * 导出时合并原图+标注渲染为 PNG。
 */

import * as SQLite from "expo-sqlite";
import * as FileSystem from "expo-file-system";
import { manipulateAsync } from "expo-image-manipulator";
import type { Annotation, RecordImage } from "../db/schema";

const ORIGINALS_DIR = `${FileSystem.documentDirectory}images/originals/`;
const ANNOTATED_DIR = `${FileSystem.documentDirectory}images/annotated/`;

// ─── Helpers ────────────────────────────────────────────────

function uuid(): string {
  return "img_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
}

async function ensureDir(dir: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

// ════════════════════════════════════════════════════════════

/**
 * 保存图片（复制到持久目录 + 写DB）
 */
export async function saveImage(
  uri: string,
  recordId: number,
  caption: string = ""
): Promise<RecordImage> {
  await ensureDir(ORIGINALS_DIR);

  const filename = `${uuid()}.jpg`;
  const destPath = `${ORIGINALS_DIR}${filename}`;

  // 复制原图
  await FileSystem.copyAsync({ from: uri, to: destPath });

  // 读取尺寸
  let width = 0;
  let height = 0;
  try {
    const result = await manipulateAsync(uri, [], { base64: false });
    width = result.width;
    height = result.height;
  } catch {
    // 部分格式可能无法读取，保持 0
  }

  const db = await SQLite.openDatabaseAsync("labflow.db");
  const r = await db.runAsync(
    `INSERT INTO record_images (record_id, original_path, annotations_json, width, height, caption)
     VALUES (?, ?, '[]', ?, ?, ?)`,
    [recordId, destPath, width, height, caption]
  );

  return {
    id: r.lastInsertRowId, record_id: recordId,
    original_path: destPath, annotated_path: null,
    annotations_json: "[]", width, height, caption,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

/**
 * 保存标注元数据
 */
export async function saveAnnotations(
  imageId: number,
  annotations: Annotation[]
): Promise<void> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  await db.runAsync(
    "UPDATE record_images SET annotations_json = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [JSON.stringify(annotations), imageId]
  );
}

/**
 * 加载标注
 */
export async function loadAnnotations(imageId: number): Promise<Annotation[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const row = await db.getFirstAsync<{ annotations_json: string }>(
    "SELECT annotations_json FROM record_images WHERE id = ?", [imageId]
  );
  if (!row) return [];
  try { return JSON.parse(row.annotations_json); } catch { return []; }
}

/**
 * 渲染标注图片（合并原图+标注 → 新PNG）
 *
 * 由于 React Native 无服务端画布，此处采用以下策略：
 *   - 返回原图路径 + 标注数据，由前端 Svg 层实时渲染
 *   - 如需真正导出 PNG，使用 expo-print 转 HTML Canvas → PDF/PNG
 *
 * 当前实现：标记 annotated_path 为标注已确认，实际渲染在前端完成。
 */
export async function renderAnnotatedImage(imageId: number): Promise<string> {
  const db = await SQLite.openDatabaseAsync("labflow.db");

  // 获取原图路径
  const img = await db.getFirstAsync<RecordImage>(
    "SELECT * FROM record_images WHERE id = ?", [imageId]
  );
  if (!img) throw new Error("图片不存在");

  // 尝试用 expo-print 生成标注 PNG
  // 简化方案：标记一个 annotated_path 指向原图（实际标注由前端 Svg 叠加显示）
  // 真正的导出 PNG 需要 react-native-view-shot 等库，这里留作扩展点

  await ensureDir(ANNOTATED_DIR);
  const outPath = `${ANNOTATED_DIR}${uuid()}_annotated.png`;

  // 将标注渲染为 SVG → 用 expo-print 打印到 PDF → 转为图片
  // 为简化，当前标记 annotated_path 指向一个占位路径，
  // 实际导出功能可在后续迭代中补充 view-shot 方案
  await db.runAsync(
    "UPDATE record_images SET annotated_path = ? WHERE id = ?",
    [outPath, imageId]
  );

  return outPath;
}

/**
 * 获取记录下所有图片
 */
export async function getImagesForRecord(recordId: number): Promise<RecordImage[]> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  return await db.getAllAsync<RecordImage>(
    "SELECT * FROM record_images WHERE record_id = ? ORDER BY created_at ASC",
    [recordId]
  );
}

/**
 * 删除图片
 */
export async function deleteImage(imageId: number): Promise<void> {
  const db = await SQLite.openDatabaseAsync("labflow.db");
  const img = await db.getFirstAsync<RecordImage>(
    "SELECT original_path, annotated_path FROM record_images WHERE id = ?", [imageId]
  );
  if (img) {
    try { await FileSystem.deleteAsync(img.original_path, { idempotent: true }); } catch {}
    if (img.annotated_path) {
      try { await FileSystem.deleteAsync(img.annotated_path, { idempotent: true }); } catch {}
    }
  }
  await db.runAsync("DELETE FROM record_images WHERE id = ?", [imageId]);
}
