/**
 * Wechannel - 独立的微信消息库
 *
 * 提供简洁的 API 用于:
 * - 登录 (QR 扫码)
 * - 接收消息 (事件驱动)
 * - 发送消息 (文本、媒体)
 * - 管理账户
 *
 * @example
 * ```typescript
 * import { WeixinClient } from 'wechannel';
 *
 * const client = new WeixinClient({
 *   stateDir: './data',
 *   log: console.log,
 * });
 *
 * await client.init();
 *
 * // 处理收到的消息
 * client.on('message', async (msg) => {
 *   console.log(`收到来自 ${msg.from} 的消息:`, msg.text);
 *
 *   // 回复文本
 *   await client.sendText(msg.accountId, msg.from, '收到！', {
 *     contextToken: msg.contextToken,
 *   });
 * });
 *
 * // 登录
 * const result = await client.login();
 * if (result.success && result.account) {
 *   await client.start(result.account.id);
 * }
 * ```
 */

// 主类
export { WeixinClient } from "./client.js";

// 类型导出
export type {
  WeixinClientOptions,
  WeixinAccount,
  WeixinAccountData,
  WeixinMessage,
  WeixinMediaInfo,
  WeixinVoiceInfo,
  WeixinFileInfo,
  WeixinQuoteInfo,
  SendTextOptions,
  SendMediaOptions,
  SendResult,
  LoginOptions,
  LoginResult,
  LoginWaitResult,
  MessageHandler,
  ErrorHandler,
  LoginHandler,
  LogoutHandler,
} from "./types.js";

// 常量导出
export { DEFAULT_BASE_URL, CDN_BASE_URL } from "./auth/account-store.js";
