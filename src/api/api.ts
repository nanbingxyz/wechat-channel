import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTrailingSlash } from "../util.js";
import { WeixinClientError, isSessionExpiredPayload } from "../errors.js";

import type {
  BaseInfo,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Long-poll timeout for getUpdates (server may hold the request up to this). */
  longPollTimeoutMs?: number;
  /** 日志函数 */
  log?: (msg: string) => void;
  /** 调试日志函数 */
  debugLog?: (msg: string) => void;
};

// ---------------------------------------------------------------------------
// BaseInfo — attached to every outgoing CGI request
// ---------------------------------------------------------------------------

function readChannelVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const CHANNEL_VERSION = readChannelVersion();

/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

/**
 * Redact sensitive data from body for logging
 */
function redactBody(body: string | undefined, maxLen = 200): string {
  if (!body) return "(empty)";
  if (body.length <= maxLen) return body;
  return `${body.slice(0, maxLen)}…(truncated, totalLen=${body.length})`;
}

/**
 * Strip query string from URL for safe logging
 */
function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const base = `${u.origin}${u.pathname}`;
    return u.search ? `${base}?<redacted>` : base;
  } catch {
    return rawUrl.slice(0, 80);
  }
}

/**
 * Common fetch wrapper: POST JSON to a Weixin API endpoint with timeout + abort.
 * Returns the raw response text on success; throws on HTTP error or timeout.
 */
async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
  debugLog?: (msg: string) => void;
}): Promise<{ ok: boolean; status: number; rawText: string }> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });
  params.debugLog?.(`POST ${redactUrl(url.toString())} body=${redactBody(params.body)}`);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    params.debugLog?.(`${params.label} status=${res.status} raw=${redactBody(rawText)}`);
    return {
      ok: res.ok,
      status: res.status,
      rawText,
    };
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

function parseJsonBody<T>(rawText: string, label: string): T {
  if (!rawText.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(rawText) as T;
  } catch (err) {
    throw new WeixinClientError(
      "ERR_API_FAILURE",
      `${label} returned invalid JSON`,
      { cause: err, details: { rawText } },
    );
  }
}

function throwApiFailure(params: {
  label: string;
  status: number;
  payload?: { errcode?: number; errmsg?: string; ret?: number };
  rawText: string;
}): never {
  const payload = params.payload;
  const message = payload?.errmsg?.trim() || `${params.label} failed with status ${params.status}`;
  if (payload && isSessionExpiredPayload(payload)) {
    throw new WeixinClientError(
      "ERR_SESSION_EXPIRED",
      message,
      {
        apiErrorCode: payload.errcode,
        details: { status: params.status, rawText: params.rawText, payload },
      },
    );
  }
  throw new WeixinClientError(
    "ERR_API_FAILURE",
    message,
    {
      apiErrorCode: payload?.errcode,
      details: { status: params.status, rawText: params.rawText, payload },
    },
  );
}

function ensureApiSuccess(
  label: string,
  result: { ok: boolean; status: number; rawText: string },
): { errcode?: number; errmsg?: string; ret?: number } {
  const payload = parseJsonBody<{ errcode?: number; errmsg?: string; ret?: number }>(
    result.rawText,
    label,
  );
  if (!result.ok) {
    throwApiFailure({ label, status: result.status, payload, rawText: result.rawText });
  }
  if ((typeof payload.ret === "number" && payload.ret !== 0) || (typeof payload.errcode === "number" && payload.errcode !== 0)) {
    throwApiFailure({ label, status: result.status, payload, rawText: result.rawText });
  }
  return payload;
}

/**
 * Long-poll getUpdates. Server should hold the request until new messages or timeout.
 *
 * On client-side timeout (no server response within timeoutMs), returns an empty response
 * with ret=0 so the caller can simply retry. This is normal for long-poll.
 */
export async function getUpdates(
  params: GetUpdatesReq & {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    debugLog?: (msg: string) => void;
  },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      debugLog: params.debugLog,
    });
    if (!rawText.ok) {
      throw new Error(`getUpdates ${rawText.status}: ${rawText.rawText}`);
    }
    const resp: GetUpdatesResp = parseJsonBody(rawText.rawText, "getUpdates");
    return resp;
  } catch (err) {
    // Long-poll timeout is normal; return empty response so caller can retry
    if (err instanceof Error && err.name === "AbortError") {
      params.debugLog?.(`getUpdates: client-side timeout after ${timeout}ms, returning empty response`);
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
    const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
    debugLog: params.debugLog,
  });
  if (!rawText.ok) {
    throw new Error(`getUploadUrl ${rawText.status}: ${rawText.rawText}`);
  }
  const resp: GetUploadUrlResp = parseJsonBody(rawText.rawText, "getUploadUrl");
  return resp;
}

/** Send a single message downstream. */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  const result = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
    debugLog: params.debugLog,
  });
  ensureApiSuccess("sendMessage", result);
}

/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const result = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
    debugLog: params.debugLog,
  });
  ensureApiSuccess("getConfig", result);
  const resp: GetConfigResp = parseJsonBody(result.rawText, "getConfig");
  return resp;
}

/** Send a typing indicator to a user. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  const result = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
    debugLog: params.debugLog,
  });
  ensureApiSuccess("sendTyping", result);
}
