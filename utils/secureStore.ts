/**
 * API Key 安全存储模块（expo-secure-store）。
 *
 * 背景：项目原有 API Key 用 AsyncStorage 明文存储，不安全。
 *
 * 解决方案：本模块封装 expo-secure-store（iOS Keychain / Android
 * Keystore），后续 llm.ts / kitParser.ts / settings.tsx 等涉及密钥
 * 存取的位置将统一改用本模块。
 *
 * 注意：expo-secure-store 在 iOS 模拟器上默认可用；Android 上如需
 * 备份容错可调整属性，当前保持默认行为。
 */
import * as SecureStore from "expo-secure-store";

/** 读取密钥；不存在时返回 null */
export async function getSecret(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

/** 写入密钥 */
export async function setSecret(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

/** 删除密钥 */
export async function deleteSecret(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}
