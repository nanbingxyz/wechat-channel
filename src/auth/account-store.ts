/**
 * 账户存储 - 管理微信机器人账户的持久化
 */

import fs from "node:fs";
import path from "node:path";

import { normalizeAccountId, deriveRawAccountId } from "../util.js";
import type { WeixinAccount, WeixinAccountData } from "../types.js";

// 默认配置
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ---------------------------------------------------------------------------
// 存储路径解析
// ---------------------------------------------------------------------------

let stateDir: string | null = null;

/**
 * 设置状态目录
 */
export function setAccountStateDir(dir: string): void {
  stateDir = dir;
}

/**
 * 获取状态目录
 */
function getStateDir(): string {
  if (!stateDir) {
    throw new Error("State directory not set. Call setAccountStateDir() first.");
  }
  return stateDir;
}

function resolveWeixinStateDir(): string {
  return path.join(getStateDir(), "accounts");
}

function resolveAccountIndexPath(): string {
  return path.join(getStateDir(), "accounts.json");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveWeixinStateDir(), `${accountId}.json`);
}

// ---------------------------------------------------------------------------
// 账户索引
// ---------------------------------------------------------------------------

/**
 * 获取所有已注册的账户 ID
 */
export function listAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * 注册账户 ID (添加到索引)
 */
export function registerAccountId(accountId: string): void {
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = listAccountIds();
  if (existing.includes(accountId)) return;

  const updated = [...existing, accountId];
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * 从索引中移除账户 ID
 */
export function unregisterAccountId(accountId: string): void {
  const existing = listAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length === existing.length) return;
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// 账户数据读写
// ---------------------------------------------------------------------------

/**
 * 读取账户数据文件
 */
function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 加载账户数据
 * 支持标准化 ID 和原始 ID 的兼容
 */
export function loadAccount(accountId: string): WeixinAccountData | null {
  // 首先尝试给定的 ID
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;

  // 兼容：如果是标准化 ID，尝试从原始 ID 文件读取
  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readAccountFile(resolveAccountPath(rawId));
    if (compat) return compat;
  }

  return null;
}

/**
 * 保存账户数据
 */
export function saveAccount(
  accountId: string,
  data: { token?: string; baseUrl?: string; userId?: string },
): void {
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });

  const normalizedId = normalizeAccountId(accountId);
  const existing = loadAccount(normalizedId) ?? {};

  const token = data.token?.trim() || existing.token;
  const baseUrl = data.baseUrl?.trim() || existing.baseUrl;
  const userId =
    data.userId !== undefined
      ? data.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const accountData: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(normalizedId);
  fs.writeFileSync(filePath, JSON.stringify(accountData, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }

  // 确保在索引中注册
  registerAccountId(normalizedId);
}

/**
 * 删除账户数据
 */
export function deleteAccount(accountId: string): void {
  const normalizedId = normalizeAccountId(accountId);
  try {
    fs.unlinkSync(resolveAccountPath(normalizedId));
  } catch {
    // ignore if not found
  }
  unregisterAccountId(normalizedId);
}

// ---------------------------------------------------------------------------
// 账户解析
// ---------------------------------------------------------------------------

/**
 * 解析账户信息
 * 合并存储的凭证和配置
 */
export function resolveAccount(
  accountId: string,
  options?: {
    baseUrl?: string;
    cdnBaseUrl?: string;
  },
): WeixinAccount {
  const normalizedId = normalizeAccountId(accountId);
  const accountData = loadAccount(normalizedId);
  const token = accountData?.token?.trim() || undefined;
  const storedBaseUrl = accountData?.baseUrl?.trim() || "";

  return {
    id: normalizedId,
    userId: accountData?.userId?.trim() || undefined,
    configured: Boolean(token),
    baseUrl: storedBaseUrl || options?.baseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: options?.cdnBaseUrl || CDN_BASE_URL,
  };
}

/**
 * 获取所有账户
 */
export function getAllAccounts(options?: {
  baseUrl?: string;
  cdnBaseUrl?: string;
}): WeixinAccount[] {
  const ids = listAccountIds();
  return ids.map((id) => resolveAccount(id, options));
}

/**
 * 获取账户 Token
 */
export function getAccountToken(accountId: string): string | undefined {
  return loadAccount(accountId)?.token?.trim() || undefined;
}
