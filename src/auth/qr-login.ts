/**
 * QR 登录 - 微信扫码登录流程
 */

import { randomUUID } from "node:crypto";

import type { LoginResult, LoginWaitResult } from "../types.js";

type ActiveLogin = {
  sessionKey: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  botToken?: string;
  status?: "wait" | "scaned" | "confirmed" | "expired";
  error?: string;
};

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
/** Client-side timeout for the long-poll get_qrcode_status request. */
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

/** Default `bot_type` for ilink get_bot_qrcode / get_qrcode_status (this channel build). */
export const DEFAULT_ILINK_BOT_TYPE = "3";

const activeLogins = new Map<string, ActiveLogin>();

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** The user ID of the person who scanned the QR code. */
  ilink_user_id?: string;
}

export interface QrLoginOptions {
  /** API 基础 URL */
  apiBaseUrl: string;
  /** Bot 类型，默认 "3" */
  botType?: string;
  /** 是否强制刷新二维码 */
  force?: boolean;
  /** 账户 ID (可选，用于重新登录) */
  accountId?: string;
  /** 日志函数 */
  log?: (msg: string) => void;
  /** 调试日志函数 */
  debugLog?: (msg: string) => void;
}

export interface QrWaitOptions {
  /** Session Key (从 startQrLogin 返回) */
  sessionKey: string;
  /** API 基础 URL */
  apiBaseUrl: string;
  /** Bot 类型 */
  botType?: string;
  /** 超时时间 (毫秒) */
  timeoutMs?: number;
  /** 是否显示详细输出 */
  verbose?: boolean;
  /** 日志函数 */
  log?: (msg: string) => void;
  /** 调试日志函数 */
  debugLog?: (msg: string) => void;
  /** QR 码显示回调 */
  onQrCode?: (qrcodeUrl: string) => void;
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

/** Remove all expired entries from the activeLogins map to prevent memory leaks. */
function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(id);
    }
  }
}

async function fetchQRCode(
  apiBaseUrl: string,
  botType: string,
  log?: (msg: string) => void,
): Promise<QRCodeResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  log?.(`Fetching QR code from: ${url.toString()}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    log?.(`QR code fetch failed: ${response.status} ${response.statusText} body=${body}`);
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  debugLog?: (msg: string) => void,
): Promise<StatusResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  debugLog?.(`Long-poll QR status from: ${url.toString()}`);

  const headers: Record<string, string> = {
    "iLink-App-ClientVersion": "1",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);
    debugLog?.(`pollQRStatus: HTTP ${response.status}, reading body...`);
    const rawText = await response.text();
    debugLog?.(`pollQRStatus: body=${rawText.substring(0, 200)}`);
    if (!response.ok) {
      debugLog?.(`QR status poll failed: ${response.status} ${response.statusText} body=${rawText}`);
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText}`);
    }
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      debugLog?.(`pollQRStatus: client-side timeout after ${QR_LONG_POLL_TIMEOUT_MS}ms, returning wait`);
      return { status: "wait" };
    }
    throw err;
  }
}

/**
 * 启动 QR 登录流程
 * 返回二维码 URL 和 session key
 */
export async function startQrLogin(options: QrLoginOptions): Promise<LoginResult> {
  const sessionKey = options.accountId || randomUUID();

  purgeExpiredLogins();

  const existing = activeLogins.get(sessionKey);
  if (!options.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      success: true,
      qrcodeUrl: existing.qrcodeUrl,
      sessionKey,
      message: "二维码已就绪，请使用微信扫描。",
    };
  }

  try {
    const botType = options.botType || DEFAULT_ILINK_BOT_TYPE;
    options.log?.(`Starting Weixin login with bot_type=${botType}`);

    if (!options.apiBaseUrl) {
      return {
        success: false,
        message: "No baseUrl configured.",
        sessionKey,
      };
    }

    const qrResponse = await fetchQRCode(options.apiBaseUrl, botType, options.log);
    options.log?.(`QR code received, url length=${qrResponse.qrcode_img_content?.length ?? 0}`);

    const login: ActiveLogin = {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    };

    activeLogins.set(sessionKey, login);

    return {
      success: true,
      qrcodeUrl: qrResponse.qrcode_img_content,
      sessionKey,
      message: "使用微信扫描以下二维码，以完成连接。",
    };
  } catch (err) {
    options.log?.(`Failed to start Weixin login: ${String(err)}`);
    return {
      success: false,
      message: `Failed to start login: ${String(err)}`,
      sessionKey,
    };
  }
}

const MAX_QR_REFRESH_COUNT = 3;

/**
 * 等待 QR 登录完成
 * 阻塞直到用户扫码或超时
 */
export async function waitForQrLogin(options: QrWaitOptions): Promise<LoginWaitResult> {
  let activeLogin = activeLogins.get(options.sessionKey);

  if (!activeLogin) {
    options.log?.(`waitForQrLogin: no active login sessionKey=${options.sessionKey}`);
    return {
      connected: false,
      message: "当前没有进行中的登录，请先发起登录。",
    };
  }

  if (!isLoginFresh(activeLogin)) {
    options.log?.(`waitForQrLogin: login QR expired sessionKey=${options.sessionKey}`);
    activeLogins.delete(options.sessionKey);
    return {
      connected: false,
      message: "二维码已过期，请重新生成。",
    };
  }

  const timeoutMs = Math.max(options.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  options.log?.("Starting to poll QR code status...");

  while (Date.now() < deadline) {
    try {
      const statusResponse = await pollQRStatus(
        options.apiBaseUrl,
        activeLogin.qrcode,
        options.debugLog,
      );
      options.debugLog?.(
        `pollQRStatus: status=${statusResponse.status} hasBotToken=${Boolean(statusResponse.bot_token)}`,
      );
      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case "wait":
          if (options.verbose) {
            process.stdout.write(".");
          }
          break;
        case "scaned":
          if (!scannedPrinted) {
            options.log?.("已扫码，在微信继续操作...");
            scannedPrinted = true;
          }
          break;
        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            options.log?.(
              `waitForQrLogin: QR expired ${MAX_QR_REFRESH_COUNT} times, giving up sessionKey=${options.sessionKey}`,
            );
            activeLogins.delete(options.sessionKey);
            return {
              connected: false,
              message: "登录超时：二维码多次过期，请重新开始登录流程。",
            };
          }

          options.log?.(`二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`);

          try {
            const botType = DEFAULT_ILINK_BOT_TYPE;
            const qrResponse = await fetchQRCode(options.apiBaseUrl, botType, options.log);
            activeLogin.qrcode = qrResponse.qrcode;
            activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
            activeLogin.startedAt = Date.now();
            scannedPrinted = false;
            options.log?.("新二维码已生成，请重新扫描");
            options.onQrCode?.(qrResponse.qrcode_img_content);
          } catch (refreshErr) {
            options.log?.(`waitForQrLogin: failed to refresh QR code: ${String(refreshErr)}`);
            activeLogins.delete(options.sessionKey);
            return {
              connected: false,
              message: `刷新二维码失败: ${String(refreshErr)}`,
            };
          }
          break;
        }
        case "confirmed": {
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(options.sessionKey);
            options.log?.("Login confirmed but ilink_bot_id missing from response");
            return {
              connected: false,
              message: "登录失败：服务器未返回 ilink_bot_id。",
            };
          }

          activeLogin.botToken = statusResponse.bot_token;
          activeLogins.delete(options.sessionKey);

          options.log?.(`Login confirmed! ilink_bot_id=${statusResponse.ilink_bot_id}`);

          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "与微信连接成功！",
          };
        }
      }
    } catch (err) {
      options.log?.(`Error polling QR status: ${String(err)}`);
      activeLogins.delete(options.sessionKey);
      return {
        connected: false,
        message: `Login failed: ${String(err)}`,
      };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  options.log?.(
    `waitForQrLogin: timed out waiting for QR scan sessionKey=${options.sessionKey} timeoutMs=${timeoutMs}`,
  );
  activeLogins.delete(options.sessionKey);
  return {
    connected: false,
    message: "登录超时，请重试。",
  };
}

/**
 * 完整的 QR 登录流程
 * 1. 获取二维码
 * 2. 等待扫码
 * 3. 返回登录结果
 */
export async function loginWithQr(options: QrLoginOptions & { timeoutMs?: number }): Promise<LoginWaitResult> {
  const startResult = await startQrLogin(options);
  if (!startResult.success || !startResult.qrcodeUrl) {
    return {
      connected: false,
      message: startResult.message,
    };
  }

  // 显示二维码
  options.log?.(`请扫描二维码: ${startResult.qrcodeUrl}`);

  // 尝试在终端显示
  try {
    const qrterm = await import("qrcode-terminal");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    qrterm.default?.generate?.(startResult.qrcodeUrl, { small: true }, () => {});
  } catch {
    // qrcode-terminal not available
  }

  return waitForQrLogin({
    sessionKey: startResult.sessionKey!,
    apiBaseUrl: options.apiBaseUrl,
    botType: options.botType,
    timeoutMs: options.timeoutMs ?? 480_000,
    log: options.log,
    debugLog: options.debugLog,
    onQrCode: (url) => {
      options.log?.(`新二维码: ${url}`);
    },
  });
}
