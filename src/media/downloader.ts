/**
 * 媒体下载 - 从微信 CDN 下载和解密媒体文件
 */

import fs from "node:fs/promises";
import path from "node:path";

import { buildCdnDownloadUrl } from "./uploader.js";
import { decryptAesEcb, parseAesKey } from "./crypto.js";
import type { MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

export interface DownloadOptions {
  /** CDN 基础 URL */
  cdnBaseUrl: string;
  /** 保存目录 */
  saveDir: string;
  /** 日志函数 */
  log?: (msg: string) => void;
  /** 调试日志函数 */
  debugLog?: (msg: string) => void;
}

export interface DownloadResult {
  /** 图片路径 */
  imagePath?: string;
  /** 视频路径 */
  videoPath?: string;
  /** 语音路径 */
  voicePath?: string;
  /** 语音 MIME 类型 */
  voiceMediaType?: string;
  /** 文件路径 */
  filePath?: string;
  /** 文件 MIME 类型 */
  fileMediaType?: string;
  /** 原始文件名 */
  filename?: string;
}

/**
 * 从 CDN 下载原始字节 (无解密)
 */
async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`${label}: fetch network error url=${url} err=${String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText} body=${body}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * 从 CDN 下载并 AES-128-ECB 解密
 */
async function downloadAndDecrypt(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  const url = buildCdnDownloadUrl(cdnBaseUrl, encryptedQueryParam);
  const encrypted = await fetchCdnBytes(url, label);
  return decryptAesEcb(encrypted, key);
}

/**
 * 从 CDN 下载原始字节 (无解密)
 */
async function downloadPlain(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(cdnBaseUrl, encryptedQueryParam);
  return fetchCdnBytes(url, label);
}

/**
 * 生成临时文件名
 */
function generateFileName(prefix: string, ext: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${timestamp}-${random}.${ext}`;
}

/**
 * 获取文件扩展名 (根据 MIME 类型或文件名)
 */
function getExtension(mimeType?: string, filename?: string): string {
  if (filename && filename.includes(".")) {
    return filename.split(".").pop() ?? "bin";
  }
  if (mimeType) {
    const mimeToExt: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "video/mp4": "mp4",
      "audio/wav": "wav",
      "audio/silk": "silk",
      "application/pdf": "pdf",
    };
    return mimeToExt[mimeType] ?? "bin";
  }
  return "bin";
}

/**
 * 从消息项下载媒体
 */
export async function downloadMediaFromItem(
  item: MessageItem,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const { cdnBaseUrl, saveDir, log, debugLog } = options;
  const result: DownloadResult = {};

  // 确保保存目录存在
  await fs.mkdir(saveDir, { recursive: true });

  try {
    if (item.type === MessageItemType.IMAGE) {
      const img = item.image_item;
      if (!img?.media?.encrypt_query_param) return result;

      const aesKeyBase64 = img.aeskey
        ? Buffer.from(img.aeskey, "hex").toString("base64")
        : img.media.aes_key;

      debugLog?.(`downloadMedia: downloading image...`);

      const buf = aesKeyBase64
        ? await downloadAndDecrypt(img.media.encrypt_query_param, aesKeyBase64, cdnBaseUrl, "image")
        : await downloadPlain(img.media.encrypt_query_param, cdnBaseUrl, "image-plain");

      const ext = getExtension("image/jpeg");
      const fileName = generateFileName("weixin-img", ext);
      const filePath = path.join(saveDir, fileName);
      await fs.writeFile(filePath, buf);

      result.imagePath = filePath;
      debugLog?.(`downloadMedia: image saved to ${filePath}`);
    } else if (item.type === MessageItemType.VIDEO) {
      const video = item.video_item;
      if (!video?.media?.encrypt_query_param || !video.media.aes_key) return result;

      debugLog?.(`downloadMedia: downloading video...`);

      const buf = await downloadAndDecrypt(
        video.media.encrypt_query_param,
        video.media.aes_key,
        cdnBaseUrl,
        "video",
      );

      const ext = getExtension("video/mp4");
      const fileName = generateFileName("weixin-video", ext);
      const filePath = path.join(saveDir, fileName);
      await fs.writeFile(filePath, buf);

      result.videoPath = filePath;
      debugLog?.(`downloadMedia: video saved to ${filePath}`);
    } else if (item.type === MessageItemType.VOICE) {
      const voice = item.voice_item;
      if (!voice?.media?.encrypt_query_param || !voice.media.aes_key) return result;

      debugLog?.(`downloadMedia: downloading voice...`);

      // 语音需要 SILK 解码，这里先保存原始 SILK 数据
      // 如果需要转码为 WAV，需要额外的 SILK 解码器
      const buf = await downloadAndDecrypt(
        voice.media.encrypt_query_param,
        voice.media.aes_key,
        cdnBaseUrl,
        "voice",
      );

      // 检查是否有语音转文字结果
      if (voice.text) {
        // 如果有文字，不需要保存语音文件
        debugLog?.(`downloadMedia: voice has text transcription, skipping file save`);
        return result;
      }

      const ext = "silk";
      const fileName = generateFileName("weixin-voice", ext);
      const filePath = path.join(saveDir, fileName);
      await fs.writeFile(filePath, buf);

      result.voicePath = filePath;
      result.voiceMediaType = "audio/silk";
      debugLog?.(`downloadMedia: voice saved to ${filePath}`);
    } else if (item.type === MessageItemType.FILE) {
      const file = item.file_item;
      if (!file?.media?.encrypt_query_param || !file.media.aes_key) return result;

      debugLog?.(`downloadMedia: downloading file...`);

      const buf = await downloadAndDecrypt(
        file.media.encrypt_query_param,
        file.media.aes_key,
        cdnBaseUrl,
        "file",
      );

      const originalName = file.file_name ?? "file.bin";
      const ext = getExtension(undefined, originalName);
      const fileName = generateFileName("weixin-file", ext);
      const filePath = path.join(saveDir, fileName);
      await fs.writeFile(filePath, buf);

      result.filePath = filePath;
      result.fileMediaType = "application/octet-stream";
      result.filename = originalName;
      debugLog?.(`downloadMedia: file saved to ${filePath}`);
    }
  } catch (err) {
    log?.(`downloadMedia: failed to download media: ${String(err)}`);
  }

  return result;
}

/**
 * 下载远程图片到本地
 */
export async function downloadRemoteImage(url: string, destDir: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`remote media download failed: ${res.status} ${res.statusText} url=${url}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });

  const contentType = res.headers.get("content-type") ?? "";
  const ext = getExtension(contentType, url);
  const fileName = generateFileName("weixin-remote", ext);
  const filePath = path.join(destDir, fileName);

  await fs.writeFile(filePath, buf);
  return filePath;
}
