/**
 * Context Token 管理
 *
 * contextToken 是每条消息附带的令牌，在回复时必须原样返回
 * 它是按 accountId:userId 键值存储的
 */

// Context token 存储: accountId:userId -> contextToken
const contextTokenStore = new Map<string, string>();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

/**
 * 存储指定账户和用户的 context token
 */
export function setContextToken(accountId: string, userId: string, token: string): void {
  const key = contextTokenKey(accountId, userId);
  contextTokenStore.set(key, token);
}

/**
 * 获取指定账户和用户的 context token
 */
export function getContextToken(accountId: string, userId: string): string | undefined {
  const key = contextTokenKey(accountId, userId);
  return contextTokenStore.get(key);
}

/**
 * 删除指定账户和用户的 context token
 */
export function deleteContextToken(accountId: string, userId: string): void {
  const key = contextTokenKey(accountId, userId);
  contextTokenStore.delete(key);
}

/**
 * 清除所有 context tokens
 */
export function clearAllContextTokens(): void {
  contextTokenStore.clear();
}

/**
 * 获取存储中的 token 数量 (用于调试)
 */
export function getContextTokenCount(): number {
  return contextTokenStore.size;
}
