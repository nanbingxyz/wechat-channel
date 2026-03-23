/**
 * Wechannel 公共类型定义
 */

// ---------------------------------------------------------------------------
// 客户端配置
// ---------------------------------------------------------------------------

export interface WeixinClientOptions {
  /** 状态存储目录，默认 ~/.wechannel */
  stateDir?: string;
  /** API 基础 URL，默认 https://ilinkai.weixin.qq.com */
  baseUrl?: string;
  /** CDN 基础 URL */
  cdnBaseUrl?: string;
  /** 日志输出函数 */
  log?: (msg: string) => void;
  /** 错误日志函数 */
  errorLog?: (msg: string) => void;
  /** 调试日志函数 */
  debugLog?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// 账户
// ---------------------------------------------------------------------------

export interface WeixinAccount {
  /** 账户 ID (标准化后的，如 hex-im-bot) */
  id: string;
  /** 账户名称 */
  name?: string;
  /** 微信用户 ID */
  userId?: string;
  /** 是否已配置 (有 token) */
  configured: boolean;
  /** API 基础 URL */
  baseUrl: string;
  /** CDN 基础 URL */
  cdnBaseUrl: string;
}

export interface WeixinAccountData {
  /** Bot Token */
  token?: string;
  /** 保存时间 */
  savedAt?: string;
  /** API 基础 URL */
  baseUrl?: string;
  /** 微信用户 ID */
  userId?: string;
}

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

export interface WeixinMessage {
  /** 消息 ID */
  id: string;
  /** 账户 ID */
  accountId: string;
  /** 发送者微信 ID */
  from: string;
  /** 接收者微信 ID */
  to: string;
  /** 消息时间戳 (毫秒) */
  timestamp: number;
  /** 上下文 Token (回复时必须使用) */
  contextToken: string;

  // 消息内容 (根据类型，以下字段之一有值)
  /** 文本内容 */
  text?: string;
  /** 图片信息 */
  image?: WeixinMediaInfo;
  /** 视频信息 */
  video?: WeixinMediaInfo;
  /** 语音信息 */
  voice?: WeixinVoiceInfo;
  /** 文件信息 */
  file?: WeixinFileInfo;

  // 引用消息
  /** 引用的消息 */
  quote?: WeixinQuoteInfo;

  // 原始数据 (高级用途)
  /** 原始消息数据 */
  raw?: unknown;
}

export interface WeixinMediaInfo {
  /** 本地文件路径 */
  path: string;
  /** MIME 类型 */
  mediaType: string;
}

export interface WeixinVoiceInfo extends WeixinMediaInfo {
  /** 语音时长 (秒) */
  duration?: number;
}

export interface WeixinFileInfo extends WeixinMediaInfo {
  /** 原始文件名 */
  filename?: string;
  /** 文件大小 (字节) */
  size?: number;
}

export interface WeixinQuoteInfo {
  /** 引用的标题 */
  title?: string;
  /** 引用的文本内容 */
  text?: string;
}

// ---------------------------------------------------------------------------
// 消息发送
// ---------------------------------------------------------------------------

export interface SendTextOptions {
  /** 回复的消息的 contextToken (用于回复) */
  contextToken?: string;
}

export interface SendMediaOptions {
  /** 附加文本 */
  text?: string;
  /** 回复的消息的 contextToken */
  contextToken?: string;
}

export interface SendResult {
  /** 消息 ID */
  messageId: string;
  /** 是否成功 */
  success: boolean;
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

export interface LoginOptions {
  /** 账户 ID (可选，用于重新登录) */
  accountId?: string;
  /** 强制重新登录 */
  force?: boolean;
  /** 超时时间 (毫秒) */
  timeoutMs?: number;
  /** 详细日志 */
  verbose?: boolean;
}

export interface LoginResult {
  /** 是否成功 */
  success: boolean;
  /** 二维码 URL */
  qrcodeUrl?: string;
  /** Session Key (用于等待登录) */
  sessionKey?: string;
  /** 消息 */
  message: string;
  /** 登录成功后的账户信息 */
  account?: WeixinAccount;
}

export interface LoginWaitResult {
  /** 是否连接成功 */
  connected: boolean;
  /** 消息 */
  message: string;
  /** Bot Token */
  botToken?: string;
  /** Bot ID */
  accountId?: string;
  /** 用户 ID */
  userId?: string;
  /** API 基础 URL */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// 事件处理器
// ---------------------------------------------------------------------------

export type MessageHandler = (message: WeixinMessage) => void | Promise<void>;
export type ErrorHandler = (error: Error, accountId?: string) => void;
export type LoginHandler = (account: WeixinAccount) => void | Promise<void>;
export type LogoutHandler = (accountId: string) => void | Promise<void>;

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

export interface ReceiverOptions {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  stateDir: string;
  longPollTimeoutMs?: number;
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
  debugLog?: (msg: string) => void;
}

export interface SenderOptions {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  log?: (msg: string) => void;
  debugLog?: (msg: string) => void;
}
