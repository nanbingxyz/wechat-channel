/**
 * WeixinClient - 微信消息客户端主类
 *
 * 提供简洁的 API 用于:
 * - 登录 (QR 扫码)
 * - 接收消息 (事件驱动)
 * - 发送消息 (文本、媒体)
 * - 管理账户
 */

import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import type {
  WeixinClientOptions,
  WeixinAccount,
  WeixinMessage,
  SendTextOptions,
  SendMediaOptions,
  SendResult,
  LoginOptions,
  LoginResult,
  ReplyCapability,
  SessionStatus,
  MessageHandler,
  ErrorHandler,
  LoginHandler,
  LogoutHandler,
  SessionStatusHandler,
} from "./types.js";
import { setStateDir } from "./storage/state-dir.js";
import {
  setAccountStateDir as setAuthStateDir,
  getAllAccounts,
  resolveAccount,
  getAccountToken,
  saveAccount,
  deleteAccount,
  DEFAULT_BASE_URL,
  CDN_BASE_URL,
} from "./auth/account-store.js";
import { loginWithQr } from "./auth/qr-login.js";
import { MessageReceiver } from "./messaging/receiver.js";
import { sendText, sendMedia } from "./messaging/sender.js";
import { clearReplyContexts, getReplyCapabilityFromContext } from "./messaging/context-token.js";
import { deleteSessionStatus, loadSessionStatus, saveSessionStatus } from "./storage/session-status.js";
import { WeixinClientError, isSessionExpiredError } from "./errors.js";

type ClientEvents = {
  message: MessageHandler;
  error: ErrorHandler;
  login: LoginHandler;
  logout: LogoutHandler;
  session_status: SessionStatusHandler;
};

/**
 * 微信消息客户端
 */
export class WeixinClient extends EventEmitter {
  private options: Required<WeixinClientOptions>;
  private receivers: Map<string, MessageReceiver> = new Map();
  private initialized = false;

  constructor(options: WeixinClientOptions = {}) {
    super();

    this.options = {
      stateDir: options.stateDir ?? "",
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      cdnBaseUrl: options.cdnBaseUrl ?? CDN_BASE_URL,
      log: options.log ?? (() => {}),
      errorLog: options.errorLog ?? console.error,
      debugLog: options.debugLog ?? (() => {}),
    };
  }

  /**
   * 初始化客户端
   * 必须在使用其他方法之前调用
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 设置状态目录
    const stateDir = this.options.stateDir || this.getDefaultStateDir();
    setStateDir(stateDir);
    setAuthStateDir(stateDir);

    // 确保状态目录存在
    await fs.mkdir(stateDir, { recursive: true });

    this.initialized = true;
    this.options.log?.(`WeixinClient initialized, stateDir=${stateDir}`);
  }

  /**
   * 获取默认状态目录
   */
  private getDefaultStateDir(): string {
    return (
      process.env.WECHANNEL_STATE_DIR?.trim() ||
      path.join(os.homedir(), ".wechannel")
    );
  }

  /**
   * 确保已初始化
   */
  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error("WeixinClient not initialized. Call init() first.");
    }
  }

  // ---------------------------------------------------------------------------
  // 账户管理
  // ---------------------------------------------------------------------------

  /**
   * 获取所有已登录账户
   */
  getAccounts(): WeixinAccount[] {
    this.ensureInit();
    return getAllAccounts({
      baseUrl: this.options.baseUrl,
      cdnBaseUrl: this.options.cdnBaseUrl,
    });
  }

  /**
   * 获取指定账户
   */
  getAccount(accountId: string): WeixinAccount | undefined {
    this.ensureInit();
    try {
      return resolveAccount(accountId, {
        baseUrl: this.options.baseUrl,
        cdnBaseUrl: this.options.cdnBaseUrl,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * QR 码登录
   */
  async login(options: LoginOptions = {}): Promise<LoginResult> {
    this.ensureInit();

    const result = await loginWithQr({
      apiBaseUrl: options.accountId
        ? resolveAccount(options.accountId, { baseUrl: this.options.baseUrl }).baseUrl
        : this.options.baseUrl,
      force: options.force,
      accountId: options.accountId,
      timeoutMs: options.timeoutMs,
      log: this.options.log,
      debugLog: this.options.debugLog,
    });

    if (result.connected && result.botToken && result.accountId) {
      // 保存账户
      const normalizedId = result.accountId.replace(/[@.]/g, "-");
      saveAccount(normalizedId, {
        token: result.botToken,
        baseUrl: result.baseUrl,
        userId: result.userId,
      });

      const account = resolveAccount(normalizedId, {
        baseUrl: this.options.baseUrl,
        cdnBaseUrl: this.options.cdnBaseUrl,
      });

      clearReplyContexts(normalizedId);
      this.emitSessionStatus(
        saveSessionStatus(normalizedId, "disconnected"),
      );

      this.emit("login", account);
      this.options.log?.(`Login successful, accountId=${normalizedId}`);

      return {
        success: true,
        message: result.message,
        account,
      };
    }

    return {
      success: false,
      message: result.message,
    };
  }

  /**
   * 登出账户
   */
  async logout(accountId: string): Promise<void> {
    this.ensureInit();

    // 停止接收器
    await this.stop(accountId);

    clearReplyContexts(accountId);
    this.emitSessionStatus(saveSessionStatus(accountId, "disconnected"));
    deleteSessionStatus(accountId);

    // 删除账户数据
    deleteAccount(accountId);

    this.emit("logout", accountId);
    this.options.log?.(`Logged out accountId=${accountId}`);
  }

  // ---------------------------------------------------------------------------
  // 消息接收
  // ---------------------------------------------------------------------------

  /**
   * 开始接收消息
   */
  async start(accountId: string): Promise<void> {
    this.ensureInit();

    if (this.receivers.has(accountId)) {
      this.options.log?.(`Receiver already running for accountId=${accountId}`);
      return;
    }

    const account = resolveAccount(accountId, {
      baseUrl: this.options.baseUrl,
      cdnBaseUrl: this.options.cdnBaseUrl,
    });

    if (!account.configured) {
      throw new Error(`Account ${accountId} is not configured. Please login first.`);
    }

    const token = getAccountToken(accountId);
    if (!token) {
      throw new Error(`Account ${accountId} has no token. Please login first.`);
    }

    const receiver = new MessageReceiver({
      accountId,
      baseUrl: account.baseUrl,
      cdnBaseUrl: account.cdnBaseUrl,
      token,
      stateDir: this.options.stateDir || this.getDefaultStateDir(),
      log: this.options.log,
      errorLog: this.options.errorLog,
      debugLog: this.options.debugLog,
    });

    // 转发消息事件
    receiver.onMessage((msg) => {
      this.emit("message", msg);
    });

    receiver.onError((err, aid) => {
      this.emit("error", err, aid);
    });

    receiver.onSessionStatus((status) => {
      this.emitSessionStatus(status);
    });

    this.receivers.set(accountId, receiver);
    await receiver.start();

    this.options.log?.(`Started receiver for accountId=${accountId}`);
  }

  /**
   * 停止接收消息
   */
  async stop(accountId: string): Promise<void> {
    const receiver = this.receivers.get(accountId);
    if (!receiver) return;

    await receiver.stop();
    this.receivers.delete(accountId);
    this.options.log?.(`Stopped receiver for accountId=${accountId}`);
  }

  /**
   * 检查是否正在接收
   */
  isReceiving(accountId: string): boolean {
    return this.receivers.has(accountId);
  }

  getSessionStatus(accountId: string): SessionStatus {
    this.ensureInit();
    return loadSessionStatus(accountId);
  }

  async getReplyCapability(
    accountId: string,
    peerId: string,
  ): Promise<ReplyCapability> {
    this.ensureInit();

    const account = this.getAccount(accountId);
    if (!account?.configured || !getAccountToken(accountId)) {
      return { canReply: false, reason: "not_connected" };
    }

    const sessionStatus = loadSessionStatus(accountId);
    if (sessionStatus.status === "session_expired") {
      return { canReply: false, reason: "session_expired" };
    }
    if (sessionStatus.status !== "connected") {
      return { canReply: false, reason: "not_connected" };
    }

    return getReplyCapabilityFromContext(accountId, peerId);
  }

  // ---------------------------------------------------------------------------
  // 消息发送
  // ---------------------------------------------------------------------------

  /**
   * 发送文本消息
   */
  async sendText(
    accountId: string,
    to: string,
    text: string,
    options: SendTextOptions = {},
  ): Promise<SendResult> {
    this.ensureInit();

    const account = resolveAccount(accountId, {
      baseUrl: this.options.baseUrl,
      cdnBaseUrl: this.options.cdnBaseUrl,
    });

    if (!account.configured) {
      throw new WeixinClientError(
        "ERR_ACCOUNT_NOT_CONFIGURED",
        `Account ${accountId} is not configured. Please login first.`,
      );
    }

    const token = getAccountToken(accountId);
    if (!token) {
      throw new WeixinClientError(
        "ERR_ACCOUNT_TOKEN_MISSING",
        `Account ${accountId} has no token. Please login first.`,
      );
    }

    const contextToken = await this.resolveContextTokenForSend(accountId, to, options.contextToken);

    try {
      return await sendText(
        {
          accountId,
          baseUrl: account.baseUrl,
          cdnBaseUrl: account.cdnBaseUrl,
          token,
          log: this.options.log,
          debugLog: this.options.debugLog,
        },
        to,
        text,
        { contextToken },
      );
    } catch (err) {
      this.handleSendError(accountId, err);
      throw err;
    }
  }

  /**
   * 发送媒体消息
   */
  async sendMedia(
    accountId: string,
    to: string,
    mediaPath: string,
    options: SendMediaOptions = {},
  ): Promise<SendResult> {
    this.ensureInit();

    const account = resolveAccount(accountId, {
      baseUrl: this.options.baseUrl,
      cdnBaseUrl: this.options.cdnBaseUrl,
    });

    if (!account.configured) {
      throw new WeixinClientError(
        "ERR_ACCOUNT_NOT_CONFIGURED",
        `Account ${accountId} is not configured. Please login first.`,
      );
    }

    const token = getAccountToken(accountId);
    if (!token) {
      throw new WeixinClientError(
        "ERR_ACCOUNT_TOKEN_MISSING",
        `Account ${accountId} has no token. Please login first.`,
      );
    }

    const contextToken = await this.resolveContextTokenForSend(accountId, to, options.contextToken);

    try {
      return await sendMedia(
        {
          accountId,
          baseUrl: account.baseUrl,
          cdnBaseUrl: account.cdnBaseUrl,
          token,
          log: this.options.log,
          debugLog: this.options.debugLog,
        },
        to,
        mediaPath,
        { contextToken, text: options.text },
      );
    } catch (err) {
      this.handleSendError(accountId, err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /**
   * 关闭客户端
   */
  async close(): Promise<void> {
    // 停止所有接收器
    for (const [accountId, receiver] of this.receivers) {
      await receiver.stop();
      this.receivers.delete(accountId);
    }

    this.removeAllListeners();
    this.options.log?.("WeixinClient closed");
  }

  private emitSessionStatus(status: SessionStatus): void {
    this.emit("session_status", status);
  }

  private async resolveContextTokenForSend(
    accountId: string,
    peerId: string,
    explicitContextToken?: string,
  ): Promise<string> {
    const sessionStatus = loadSessionStatus(accountId);
    if (sessionStatus.status === "session_expired") {
      throw new WeixinClientError(
        "ERR_SESSION_EXPIRED",
        sessionStatus.errorMessage || "Session expired.",
        { apiErrorCode: sessionStatus.errorCode },
      );
    }
    if (sessionStatus.status !== "connected") {
      throw new WeixinClientError(
        "ERR_NOT_CONNECTED",
        `Account ${accountId} is not connected.`,
      );
    }

    if (explicitContextToken) {
      return explicitContextToken;
    }

    const capability = await this.getReplyCapability(accountId, peerId);
    if (capability.canReply && capability.contextToken) {
      return capability.contextToken;
    }

    switch (capability.reason) {
      case "session_expired":
        throw new WeixinClientError(
          "ERR_SESSION_EXPIRED",
          "Session expired.",
        );
      case "not_connected":
        throw new WeixinClientError(
          "ERR_NOT_CONNECTED",
          `Account ${accountId} is not connected.`,
        );
      case "expired":
        throw new WeixinClientError(
          "ERR_CONTEXT_TOKEN_EXPIRED",
          `Context token for ${peerId} has expired. You can only reply within 24 hours of the last inbound message.`,
          { details: capability },
        );
      case "missing_context":
      default:
        throw new WeixinClientError(
          "ERR_CONTEXT_TOKEN_MISSING",
          `No context token available for ${peerId}. You can only reply to received messages.`,
          { details: capability },
        );
    }
  }

  private handleSendError(accountId: string, error: unknown): void {
    if (!isSessionExpiredError(error)) {
      return;
    }
    this.emitSessionStatus(
      saveSessionStatus(accountId, "session_expired", {
        errorCode:
          error instanceof WeixinClientError && typeof error.apiErrorCode === "number"
            ? error.apiErrorCode
            : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
