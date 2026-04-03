/**
 * 消息接收器 - 长轮询接收微信消息
 */

import type {
  WeixinMessage,
  MessageHandler,
  ErrorHandler,
  SessionStatus,
  SessionStatusHandler,
} from "../types.js";
import { getUpdates } from "../api/api.js";
import { MessageItemType } from "../api/types.js";
import { setContextToken } from "./context-token.js";
import { downloadMediaFromItem } from "../media/downloader.js";
import { generateId, sleep } from "../util.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { saveSessionStatus } from "../storage/session-status.js";
import { isSessionExpiredError, isSessionExpiredPayload } from "../errors.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export interface ReceiverOptions {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  stateDir: string;
  longPollTimeoutMs?: number;
  mediaSaveDir?: string;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  debugLog?: (msg: string) => void;
  now?: () => number;
}

/**
 * 消息接收器
 */
export class MessageReceiver {
  private options: ReceiverOptions;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private sessionStatusHandlers: SessionStatusHandler[] = [];
  private getUpdatesBuf = "";
  private consecutiveFailures = 0;

  constructor(options: ReceiverOptions) {
    this.options = options;
  }

  /**
   * 添加消息处理器
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * 添加错误处理器
   */
  onError(handler: ErrorHandler): void {
    this.errorHandlers.push(handler);
  }

  /**
   * 添加会话状态处理器
   */
  onSessionStatus(handler: SessionStatusHandler): void {
    this.sessionStatusHandlers.push(handler);
  }

  /**
   * 开始接收消息
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.options.log?.("Receiver already running");
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.options.log?.(
      `Receiver started for account ${this.options.accountId}`,
    );

    // 加载之前的同步缓冲
    await this.loadSyncBuffer();

    this.emitSessionStatus(
      saveSessionStatus(this.options.accountId, "connected", {
        changedAt: this.now(),
      }),
    );

    // 开始轮询
    void this.pollLoop();
  }

  /**
   * 停止接收消息
   */
  async stop(): Promise<void> {
    const wasRunning = this.isRunning;
    this.isRunning = false;

    if (wasRunning && this.abortController) {
      this.abortController.abort();
    }
    this.abortController = null;

    // 保存同步缓冲
    await this.saveSyncBuffer();
    this.emitSessionStatus(
      saveSessionStatus(this.options.accountId, "disconnected", {
        changedAt: this.now(),
      }),
    );
    this.options.log?.(
      `Receiver stopped for account ${this.options.accountId}`,
    );
  }

  /**
   * 轮询循环
   */
  private async pollLoop(): Promise<void> {
    const timeoutMs =
      this.options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;

    while (this.isRunning && !this.abortController?.signal.aborted) {
      try {
        this.options.debugLog?.(
          `pollLoop: polling with get_updates_buf=${this.getUpdatesBuf.slice(0, 50)}...`,
        );

        const resp = await getUpdates({
          baseUrl: this.options.baseUrl,
          token: this.options.token,
          get_updates_buf: this.getUpdatesBuf,
          timeoutMs,
          debugLog: this.options.debugLog,
        });

        this.options.debugLog?.(
          `pollLoop: response ret=${resp.ret} msgs=${resp.msgs?.length ?? 0}`,
        );

        // 检查 API 错误
        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          if (isSessionExpiredPayload({ errcode: resp.errcode, errmsg: resp.errmsg })) {
            this.options.errorLog?.("getUpdates detected session expired");
            this.handleSessionExpired(resp.errcode, resp.errmsg);
            return;
          }

          this.consecutiveFailures++;
          const errMsg = `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`;
          this.options.errorLog?.(errMsg);
          this.handleError(new Error(errMsg));

          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.options.errorLog?.(`Backing off for ${BACKOFF_DELAY_MS}ms`);
            await sleep(BACKOFF_DELAY_MS, this.abortController?.signal);
            this.consecutiveFailures = 0;
          } else {
            await sleep(RETRY_DELAY_MS, this.abortController?.signal);
          }
          continue;
        }

        this.consecutiveFailures = 0;

        // 更新同步缓冲
        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          await this.saveSyncBuffer();
        }

        // 处理消息
        const messages = resp.msgs ?? [];
        for (const rawMsg of messages) {
          await this.processRawMessage(rawMsg);
        }
      } catch (err) {
        if (!this.isRunning || this.abortController?.signal.aborted) {
          break;
        }

        if (isSessionExpiredError(err)) {
          this.options.errorLog?.(`getUpdates session expired: ${String(err)}`);
          this.handleSessionExpired(
            err instanceof Error && "apiErrorCode" in err && typeof err.apiErrorCode === "number"
              ? err.apiErrorCode
              : undefined,
            err instanceof Error ? err.message : String(err),
          );
          return;
        }

        this.consecutiveFailures++;
        const errMsg = `getUpdates error: ${String(err)}`;
        this.options.errorLog?.(errMsg);
        this.handleError(err instanceof Error ? err : new Error(errMsg));

        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await sleep(BACKOFF_DELAY_MS, this.abortController?.signal);
          this.consecutiveFailures = 0;
        } else {
          await sleep(RETRY_DELAY_MS, this.abortController?.signal);
        }
      }
    }
  }

  /**
   * 处理原始消息
   */
  private async processRawMessage(rawMsg: any): Promise<void> {
    const fromUserId = rawMsg.from_user_id ?? "";
    this.options.log?.(`Received message from ${fromUserId}`);
    const receivedAt = this.now();

    // 保存 context token
    if (rawMsg.context_token) {
      setContextToken(this.options.accountId, fromUserId, rawMsg.context_token, {
        receivedAt,
        messageId: rawMsg.message_id !== undefined ? String(rawMsg.message_id) : undefined,
      });
    }

    // 构建消息对象
    const message: WeixinMessage = {
      id: generateId("msg"),
      accountId: this.options.accountId,
      from: fromUserId,
      to: rawMsg.to_user_id ?? "",
      timestamp: rawMsg.create_time_ms ?? Date.now(),
      contextToken: rawMsg.context_token ?? "",
      raw: rawMsg,
    };

    // 提取文本内容
    const itemList = rawMsg.item_list ?? [];
    for (const item of itemList) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        message.text = item.text_item.text;
        break;
      }
      // 语音转文字
      if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
        message.text = item.voice_item.text;
        break;
      }
    }

    // 下载媒体 (如果有)
    const mediaItem =
      itemList.find(
        (i: any) =>
          i.type === MessageItemType.IMAGE &&
          i.image_item?.media?.encrypt_query_param,
      ) ??
      itemList.find(
        (i: any) =>
          i.type === MessageItemType.VIDEO &&
          i.video_item?.media?.encrypt_query_param,
      ) ??
      itemList.find(
        (i: any) =>
          i.type === MessageItemType.FILE &&
          i.file_item?.media?.encrypt_query_param,
      ) ??
      itemList.find(
        (i: any) =>
          i.type === MessageItemType.VOICE &&
          i.voice_item?.media?.encrypt_query_param &&
          !i.voice_item?.text,
      );

    if (mediaItem) {
      try {
        const mediaSaveDir =
          this.options.mediaSaveDir ?? `${this.options.stateDir}/media`;
        const downloadResult = await downloadMediaFromItem(mediaItem, {
          cdnBaseUrl: this.options.cdnBaseUrl,
          saveDir: mediaSaveDir,
          log: this.options.log,
          debugLog: this.options.debugLog,
        });

        if (downloadResult.imagePath) {
          message.image = {
            path: downloadResult.imagePath,
            mediaType: "image/*",
          };
        }
        if (downloadResult.videoPath) {
          message.video = {
            path: downloadResult.videoPath,
            mediaType: "video/mp4",
          };
        }
        if (downloadResult.voicePath) {
          message.voice = {
            path: downloadResult.voicePath,
            mediaType: downloadResult.voiceMediaType ?? "audio/silk",
          };
        }
        if (downloadResult.filePath) {
          message.file = {
            path: downloadResult.filePath,
            mediaType:
              downloadResult.fileMediaType ?? "application/octet-stream",
            filename: downloadResult.filename,
          };
        }
      } catch (err) {
        this.options.errorLog?.(`Failed to download media: ${String(err)}`);
      }
    }

    // 触发消息处理器
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (err) {
        this.options.errorLog?.(`Message handler error: ${String(err)}`);
      }
    }
  }

  /**
   * 触发错误处理器
   */
  private handleError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error, this.options.accountId);
      } catch {
        // ignore
      }
    }
  }

  private emitSessionStatus(status: SessionStatus): void {
    for (const handler of this.sessionStatusHandlers) {
      try {
        void handler(status);
      } catch {
        // ignore
      }
    }
  }

  private handleSessionExpired(errorCode?: number, errorMessage?: string): void {
    this.isRunning = false;
    this.abortController = null;
    this.emitSessionStatus(
      saveSessionStatus(this.options.accountId, "session_expired", {
        changedAt: this.now(),
        errorCode,
        errorMessage,
      }),
    );
  }

  /**
   * 加载同步缓冲
   */
  private async loadSyncBuffer(): Promise<void> {
    const filePath = getSyncBufFilePath(this.options.accountId);
    this.getUpdatesBuf = loadGetUpdatesBuf(filePath) ?? "";
    this.options.debugLog?.(
      `Loaded sync buffer: ${this.getUpdatesBuf.length} bytes`,
    );
  }

  /**
   * 保存同步缓冲
   */
  private async saveSyncBuffer(): Promise<void> {
    try {
      saveGetUpdatesBuf(getSyncBufFilePath(this.options.accountId), this.getUpdatesBuf);
    } catch (err) {
      this.options.errorLog?.(`Failed to save sync buffer: ${String(err)}`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
