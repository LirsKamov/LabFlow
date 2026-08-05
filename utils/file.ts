/**
 * 文件工具模块（expo-file-system）。
 *
 * - ensureDir 使用模块级 in-flight Map 去重并发调用，解决多个并发
 *   调用同时检查 !exists 后重复 makeDirectoryAsync 抛错的问题。
 * - deleteFileIfExists 幂等，删除不存在文件不报错。
 * - safeFileName 清洗文件名，仅保留中英文与数字，其余替换为 _。
 * - copyToPermanent 把临时 URI 复制到应用 documentDirectory 下的
 *   永久目录，返回新路径。
 */
import * as FileSystem from "expo-file-system";

/** 读取文件内容并返回 base64 字符串 */
export async function readFileAsBase64(path: string): Promise<string> {
  const content = await FileSystem.readAsStringAsync(path, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return content;
}

const inFlightMkdir = new Map<string, Promise<void>>();

/** 确保目录存在；并发调用通过 in-flight 去重，避免重复 makeDirectoryAsync 抛错 */
export async function ensureDir(dir: string): Promise<void> {
  const existing = inFlightMkdir.get(dir);
  if (existing) {
    return existing;
  }

  const info = await FileSystem.getInfoAsync(dir);
  if (info.exists) {
    return;
  }

  const task = (async () => {
    try {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    } finally {
      inFlightMkdir.delete(dir);
    }
  })();

  inFlightMkdir.set(dir, task);
  return task;
}

/** 幂等删除文件；文件不存在时静默成功 */
export async function deleteFileIfExists(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) {
    await FileSystem.deleteAsync(path, { idempotent: true });
  }
}

/** 清洗为安全文件名：仅保留中英文与数字（含 ._ 之外的通用字符），其余替换为 _，并截断到 maxLen */
export function safeFileName(name: string, maxLen?: number): string {
  const cleaned = name.replace(/[^\w\u4e00-\u9fa5.-]/g, "_");
  const limit = maxLen ?? 120;
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned;
}

/** 把 sourceUri 复制到 documentDirectory 下永久目录 dir 中，返回新文件路径 */
export async function copyToPermanent(
  dir: string,
  sourceUri: string,
  name: string,
): Promise<string> {
  await ensureDir(dir);
  const fileName = safeFileName(name);
  const dest = `${dir}/${fileName}`;
  await FileSystem.copyAsync({ from: sourceUri, to: dest });
  return dest;
}
