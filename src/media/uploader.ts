/**
 * 媒体上传 - 上传文件到微信 CDN
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getUploadUrl } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { UploadMediaType } from "../api/types.js";
import { encryptAesEcb, aesEcbPaddedSize } from "./crypto.js";

export interface UploadedFileInfo {
  /** 文件标识 */
  filekey: string;
  /** CDN 下载加密参数 (用于 media.encrypt_query_param) */
  downloadEncryptedQueryParam: string;
  /** AES 密钥 (hex 格式) */
  aeskey: string;
  /** 明文文件大小 (字节) */
  fileSize: number;
  /** 密文文件大小 (字节, AES-128-ECB with PKCS7 padding) */
  fileSizeCiphertext: number;
}

export interface UploadOptions {
  /** API 基础 URL */
  baseUrl: string;
  /** Bot Token */
  token: string;
  /** CDN 基础 URL */
  cdnBaseUrl: string;
  /** 目标用户 ID */
  toUserId: string;
  /** 日志函数 */
  log?: (msg: string) => void;
  /** 调试日志函数 */
  debugLog?: (msg: string) => void;
}

/**
 * 构建 CDN 上传 URL
 */
function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

/**
 * 构建 CDN 下载 URL
 */
export function buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/**
 * 上传加密后的数据到 CDN
 */
async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  label: string;
  log?: (msg: string) => void;
  debugLog?: (msg: string) => void;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadParam, filekey, cdnBaseUrl, aeskey, label, log, debugLog } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey);
  debugLog?.(`${label}: CDN POST ciphertextSize=${ciphertext.length}`);

  const UPLOAD_MAX_RETRIES = 3;
  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        log?.(`${label}: CDN client error status=${res.status} errMsg=${errMsg}`);
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }

      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        log?.(`${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`);
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        log?.(`${label}: CDN response missing x-encrypted-param header`);
        throw new Error("CDN upload response missing x-encrypted-param header");
      }

      debugLog?.(`${label}: CDN upload success`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        log?.(`${label}: attempt ${attempt} failed, retrying... err=${String(err)}`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}

/**
 * 通用上传流程: 读取文件 → 计算哈希 → 生成密钥 → 获取上传 URL → 上传到 CDN
 */
async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: Omit<UploadOptions, "toUserId">;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  label: string;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, opts, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  opts.debugLog?.(
    `${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5.slice(0, 8)}...`,
  );

  const uploadUrlResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    debugLog: opts.debugLog,
  });

  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadParam) {
    throw new Error(`${label}: getUploadUrl returned no upload_param`);
  }

  const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadParam,
    filekey,
    cdnBaseUrl: opts.cdnBaseUrl,
    aeskey,
    label,
    log: opts.log,
    debugLog: opts.debugLog,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/**
 * 上传图片到微信 CDN
 */
export async function uploadImage(params: {
  filePath: string;
  toUserId: string;
} & Omit<UploadOptions, "toUserId">): Promise<UploadedFileInfo> {
  const { filePath, toUserId, ...opts } = params;
  return uploadMediaToCdn({
    filePath,
    toUserId,
    opts,
    mediaType: UploadMediaType.IMAGE,
    label: "uploadImage",
  });
}

/**
 * 上传视频到微信 CDN
 */
export async function uploadVideo(params: {
  filePath: string;
  toUserId: string;
} & Omit<UploadOptions, "toUserId">): Promise<UploadedFileInfo> {
  const { filePath, toUserId, ...opts } = params;
  return uploadMediaToCdn({
    filePath,
    toUserId,
    opts,
    mediaType: UploadMediaType.VIDEO,
    label: "uploadVideo",
  });
}

/**
 * 上传文件附件到微信 CDN
 */
export async function uploadFile(params: {
  filePath: string;
  fileName: string;
  toUserId: string;
} & Omit<UploadOptions, "toUserId">): Promise<UploadedFileInfo> {
  const { filePath, fileName, toUserId, ...opts } = params;
  return uploadMediaToCdn({
    filePath,
    toUserId,
    opts,
    mediaType: UploadMediaType.FILE,
    label: "uploadFile",
  });
}
