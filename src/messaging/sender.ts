/**
 * 消息发送 - 文本和媒体消息发送
 */

import path from "node:path";

import { generateId, stripMarkdown } from "../util.js";
import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";
import type { SendResult, SendTextOptions, SendMediaOptions } from "../types.js";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function generateClientId(): string {
  return generateId("wechannel");
}

/**
 * 将 Markdown 格式转换为纯文本
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // 代码块：保留代码内容，移除围栏
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // 图片：完全移除
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // 链接：只保留显示文本
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // 表格：移除分隔行，然后去除首尾管道符并转换内部管道符为空格
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  // 使用通用 markdown 剥离
  result = stripMarkdown(result);
  return result;
}

// ---------------------------------------------------------------------------
// 消息构建
// ---------------------------------------------------------------------------

function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// 发送函数
// ---------------------------------------------------------------------------

export interface SenderDeps {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  log?: (msg: string) => void;
  debugLog?: (msg: string) => void;
}

/**
 * 发送文本消息
 */
export async function sendText(
  deps: SenderDeps,
  to: string,
  text: string,
  options?: SendTextOptions,
): Promise<SendResult> {
  const contextToken = options?.contextToken;
  if (!contextToken) {
    deps.log?.(`sendText: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendText: contextToken is required");
  }

  const clientId = generateClientId();
  const plainText = markdownToPlainText(text);
  const req = buildTextMessageReq({
    to,
    text: plainText,
    contextToken,
    clientId,
  });

  try {
    await sendMessageApi({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: req,
      debugLog: deps.debugLog,
    });
    deps.debugLog?.(`sendText: success to=${to} clientId=${clientId}`);
    return { messageId: clientId, success: true };
  } catch (err) {
    deps.log?.(`sendText: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
}

/**
 * 发送媒体消息 (图片、视频、文件)
 * 需要先上传到 CDN，然后发送消息引用
 */
export async function sendMedia(
  deps: SenderDeps,
  to: string,
  mediaPath: string,
  options?: SendMediaOptions,
): Promise<SendResult> {
  const contextToken = options?.contextToken;
  if (!contextToken) {
    deps.log?.(`sendMedia: contextToken missing, refusing to send to=${to}`);
    throw new Error("sendMedia: contextToken is required");
  }

  // 动态导入上传函数 (避免循环依赖)
  const { uploadAndSendMedia } = await import("./sender-media.js");
  return uploadAndSendMedia({
    deps,
    to,
    mediaPath,
    text: options?.text ?? "",
    contextToken,
  });
}

/**
 * 发送单条消息项 (内部使用)
 */
async function sendMediaItem(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinApiOptions & { contextToken?: string };
  label: string;
  log?: (msg: string) => void;
  debugLog?: (msg: string) => void;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label, log, debugLog } = params;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
      },
    };
    try {
      await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
        debugLog,
      });
    } catch (err) {
      log?.(`${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`);
      throw err;
    }
  }

  debugLog?.(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId };
}

// ---------------------------------------------------------------------------
// 媒体消息发送 (使用已上传的文件)
// ---------------------------------------------------------------------------

export interface UploadedFileInfo {
  filekey: string;
  fileSize: number;
  fileSizeCiphertext: number;
  aeskey: Buffer;
  downloadEncryptedQueryParam: string;
}

/**
 * 发送图片消息 (使用已上传的文件)
 */
export async function sendImageMessage(
  deps: SenderDeps,
  to: string,
  text: string,
  uploaded: UploadedFileInfo,
  contextToken: string,
): Promise<{ messageId: string }> {
  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItem({
    to,
    text,
    mediaItem: imageItem,
    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
    label: "sendImageMessage",
    log: deps.log,
    debugLog: deps.debugLog,
  });
}

/**
 * 发送视频消息 (使用已上传的文件)
 */
export async function sendVideoMessage(
  deps: SenderDeps,
  to: string,
  text: string,
  uploaded: UploadedFileInfo,
  contextToken: string,
): Promise<{ messageId: string }> {
  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItem({
    to,
    text,
    mediaItem: videoItem,
    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
    label: "sendVideoMessage",
    log: deps.log,
    debugLog: deps.debugLog,
  });
}

/**
 * 发送文件消息 (使用已上传的文件)
 */
export async function sendFileMessage(
  deps: SenderDeps,
  to: string,
  text: string,
  fileName: string,
  uploaded: UploadedFileInfo,
  contextToken: string,
): Promise<{ messageId: string }> {
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItem({
    to,
    text,
    mediaItem: fileItem,
    opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
    label: "sendFileMessage",
    log: deps.log,
    debugLog: deps.debugLog,
  });
}
