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
  MessageHandler,
  ErrorHandler,
  LoginHandler,
  LogoutHandler,
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
import { getContextToken } from "./messaging/context-token.js";

type ClientEvents = {
  message: MessageHandler;
  error: ErrorHandler;
  login: LoginHandler;
  logout: LogoutHandler;
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
      throw new Error(`Account ${accountId} is not configured. Please login first.`);
    }

    const token = getAccountToken(accountId);
    if (!token) {
      throw new Error(`Account ${accountId} has no token. Please login first.`);
    }

    // 获取 context token
    const contextToken = options.contextToken ?? getContextToken(accountId, to);
    if (!contextToken) {
      throw new Error(
        `No context token available for ${to}. You can only reply to received messages.`,
      );
    }

    return sendText(
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
      throw new Error(`Account ${accountId} is not configured. Please login first.`);
    }

    const token = getAccountToken(accountId);
    if (!token) {
      throw new Error(`Account ${accountId} has no token. Please login first.`);
    }

    // 获取 context token
    const contextToken = options.contextToken ?? getContextToken(accountId, to);
    if (!contextToken) {
      throw new Error(
        `No context token available for ${to}. You can only reply to received messages.`,
      );
    }

    return sendMedia(
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
}
