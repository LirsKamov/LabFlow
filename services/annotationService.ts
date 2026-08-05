/**
 * 图片标注服务
 *
 * 设计原则：原始图片永不修改，标注以 JSON 元数据存储（annotations_json）。
 * 前端基于 SVG 实时渲染标注，导出侧导出 JSON（而非生成假 PNG）。
 */

import * as FileSystem from "expo-file-system";
import { manipulateAsync } from "expo-image-manipulator";
import { getDb } from "../db/database";
import type { Annotation, RecordImage } from "../db/schema";
import { ensureDir, deleteFileIfExists } from "../utils/file";

export type { RecordImage } from "../db/schema";

const ORIGINALS_DIR = `${FileSystem.documentDirectory}images/originals/`;

// ─── Helpers ────────────────────────────────────────────────

function uuid(): string {
  return "img_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
}

/** 从源 URI 推断扩展名（.png/.heic/.webp 等），无则默认 jpg */
function inferExtension(uri: string): string {
  const clean = uri.split(/[?#]/)[0];
  const m = clean.match(/\.([a-zA-Z0-9]{2,5})$/);
  return m ? m[1].toLowerCase() : "jpg";
}

// ════════════════════════════════════════════════════════════

/**
 * 保存图片（复制到持久目录 + 写DB）
 *
 * 原子性：复制文件成功、INSERT 失败时补偿删除刚复制的文件，
 * 保证文件与 DB 记录一致。
 */
export async function saveImage(
  uri: string,
  recordId: number,
  caption: string = ""
): Promise<RecordImage> {
  await ensureDir(ORIGINALS_DIR);

  const ext = inferExtension(uri);
  const filename = `${uuid()}.${ext}`;
  const destPath = `${ORIGINALS_DIR}${filename}`;

  // 复制原图
  await FileSystem.copyAsync({ from: uri, to: destPath });

  // 读取尺寸（部分格式可能失败，保持 0）
  let width = 0;
  let height = 0;
  try {
    const result = await manipulateAsync(uri, [], { base64: false });
    width = result.width;
    height = result.height;
  } catch {
    // 忽略尺寸读取失败
  }

  try {
    const db = await getDb();
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
  } catch (err) {
    // DB 写入失败 → 补偿删除刚复制的文件
    try { await deleteFileIfExists(destPath); } catch { /* 补偿失败仅残留孤儿文件 */ }
    throw err;
  }
}

/**
 * 保存标注元数据
 */
export async function saveAnnotations(
  imageId: number,
  annotations: Annotation[]
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE record_images SET annotations_json = ?, updated_at = datetime('now','localtime') WHERE id = ?",
    [JSON.stringify(annotations), imageId]
  );
}

/**
 * 加载标注
 */
export async function loadAnnotations(imageId: number): Promise<Annotation[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ annotations_json: string }>(
    "SELECT annotations_json FROM record_images WHERE id = ?", [imageId]
  );
  if (!row) return [];
  try { return JSON.parse(row.annotations_json); } catch { return []; }
}

/**
 * 渲染标注图片
 *
 * 约定：标注以 annotations_json 存储，前端（ImageAnnotator）基于 SVG 实时渲染，
 * 不再生成物理"标注图"。导出侧（exportService）应导出 annotations_json 而非假图。
 * 本函数保留签名返回 null，未来接入 react-native-view-shot 方案时再填充。
 */
export async function renderAnnotatedImage(_imageId: number): Promise<string | null> {
  return null;
}

/**
 * 获取记录下所有图片
 */
export async function getImagesForRecord(recordId: number): Promise<RecordImage[]> {
  const db = await getDb();
  return await db.getAllAsync<RecordImage>(
    "SELECT * FROM record_images WHERE record_id = ? ORDER BY created_at ASC",
    [recordId]
  );
}

/**
 * 删除图片
 *
 * 顺序：先删 DB 行，再删文件（幂等，失败仅 console.warn）。
 * 避免"先删文件后删行失败 → DB 指向破图"。
 */
export async function deleteImage(imageId: number): Promise<void> {
  const db = await getDb();
  const img = await db.getFirstAsync<Pick<RecordImage, "original_path" | "annotated_path">>(
    "SELECT original_path, annotated_path FROM record_images WHERE id = ?", [imageId]
  );
  if (!img) return; // 幂等：记录不存在直接返回

  await db.runAsync("DELETE FROM record_images WHERE id = ?", [imageId]);

  for (const p of [img.original_path, img.annotated_path]) {
    if (!p) continue;
    try { await deleteFileIfExists(p); } catch (e) { console.warn("删除图片文件失败", p, e); }
  }
}
