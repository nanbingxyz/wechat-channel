/**
 * 工具函数 - 本地实现，替代 openclaw/plugin-sdk 中的函数
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// ID 标准化
// ---------------------------------------------------------------------------

/**
 * 将微信 ID 标准化为文件系统安全的格式
 * 例如: "hex@im.bot" -> "hex-im-bot"
 */
export function normalizeAccountId(id: string): string {
  return id.replace(/[@.]/g, "-");
}

/**
 * 从标准化 ID 反推原始 ID
 * 例如: "hex-im-bot" -> "hex@im.bot"
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 文件锁 (简化实现)
// ---------------------------------------------------------------------------

/**
 * 简化版文件锁 - 单进程场景下直接执行
 * 对于多进程场景，建议使用 proper-lockfile 等库
 */
export async function withFileLock<T>(
  _filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  // 单进程简化实现：直接执行
  return fn();
}

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

/**
 * 移除 Markdown 格式，保留纯文本
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // 移除标题标记
      .replace(/^#{1,6}\s+/gm, "")
      // 移除粗体和斜体
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
      // 移除删除线
      .replace(/~~([^~]+)~~/g, "$1")
      // 移除代码块
      .replace(/```[\s\S]*?```/g, (match) => {
        // 保留代码内容，移除语言标记
        const lines = match.split("\n");
        if (lines.length > 2) {
          return lines.slice(1, -1).join("\n");
        }
        return match.replace(/```\w*\n?/g, "");
      })
      // 移除行内代码
      .replace(/`([^`]+)`/g, "$1")
      // 移除链接，保留文本
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // 移除图片
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
      // 移除引用标记
      .replace(/^>\s+/gm, "")
      // 移除列表标记
      .replace(/^[\s]*[-*+]\s+/gm, "")
      .replace(/^[\s]*\d+\.\s+/gm, "")
      // 移除水平线
      .replace(/^[-*_]{3,}$/gm, "")
      // 清理多余空行
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// ID 生成
// ---------------------------------------------------------------------------

/**
 * 生成随机 ID
 */
export function generateId(prefix: string = "wechannel"): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString("hex");
  return `${prefix}-${timestamp}-${random}`;
}

// ---------------------------------------------------------------------------
// 文件路径
// ---------------------------------------------------------------------------

/**
 * 确保路径以斜杠结尾
 */
export function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * 解析本地文件路径
 * 支持 file:// 协议和相对路径
 */
export function resolveLocalPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) {
    return new URL(mediaUrl).pathname;
  }
  return mediaUrl;
}

/**
 * 判断是否为本地文件路径
 */
export function isLocalFilePath(url: string): boolean {
  return !url.includes("://");
}

/**
 * 判断是否为远程 URL
 */
export function isRemoteUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

// ---------------------------------------------------------------------------
// 重试逻辑
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** 最大重试次数 */
  maxRetries?: number;
  /** 初始延迟 (毫秒) */
  initialDelayMs?: number;
  /** 最大延迟 (毫秒) */
  maxDelayMs?: number;
  /** 退避因子 */
  backoffFactor?: number;
  /** 是否重试的判断函数 */
  shouldRetry?: (error: Error) => boolean;
}

/**
 * 带指数退避的重试
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 30000,
    backoffFactor = 2,
    shouldRetry = () => true,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxRetries || !shouldRetry(lastError)) {
        throw lastError;
      }

      await sleep(delay);
      delay = Math.min(delay * backoffFactor, maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * 睡眠函数
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// 日志工具
// ---------------------------------------------------------------------------

/**
 * 创建简单的日志函数
 */
export function createLogger(prefix: string) {
  return {
    info: (msg: string) => console.log(`[${prefix}] ${msg}`),
    warn: (msg: string) => console.warn(`[${prefix}] ${msg}`),
    error: (msg: string) => console.error(`[${prefix}] ${msg}`),
    debug: (msg: string) => console.debug(`[${prefix}] ${msg}`),
  };
}
