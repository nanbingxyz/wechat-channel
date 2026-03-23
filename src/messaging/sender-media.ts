/**
 * 媒体发送辅助函数 - 上传并发送媒体消息
 */

import path from "node:path";

import type { SendResult, SendMediaOptions } from "../types.js";
import type { SenderDeps } from "./sender.js";
import { sendImageMessage, sendVideoMessage, sendFileMessage } from "./sender.js";
import { uploadImage, uploadVideo, uploadFile } from "../media/uploader.js";

/**
 * 根据 MIME 类型判断媒体类型
 */
function getMediaType(mimeType: string): "image" | "video" | "file" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

/**
 * 从文件名获取 MIME 类型
 */
function getMimeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    // 图片
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    // 视频
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    webm: "video/webm",
    // 文档
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // 压缩文件
    zip: "application/zip",
    rar: "application/x-rar-compressed",
    "7z": "application/x-7z-compressed",
    // 音频
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}

/**
 * 上传并发送媒体消息
 */
export async function uploadAndSendMedia(params: {
  deps: SenderDeps;
  to: string;
  mediaPath: string;
  text: string;
  contextToken: string;
}): Promise<SendResult> {
  const { deps, to, mediaPath, text, contextToken } = params;

  const fileName = path.basename(mediaPath);
  const mimeType = getMimeFromFilename(fileName);
  const mediaType = getMediaType(mimeType);

  const uploadOpts = {
    baseUrl: deps.baseUrl,
    token: deps.token,
    cdnBaseUrl: deps.cdnBaseUrl,
    log: deps.log,
    debugLog: deps.debugLog,
  };

  let messageId: string;

  if (mediaType === "video") {
    deps.log?.(`sendMedia: uploading video ${mediaPath}`);
    const uploaded = await uploadVideo({
      filePath: mediaPath,
      toUserId: to,
      ...uploadOpts,
    });
    deps.debugLog?.(`sendMedia: video uploaded, filekey=${uploaded.filekey}`);

    const result = await sendVideoMessage(deps, to, text, {
      filekey: uploaded.filekey,
      fileSize: uploaded.fileSize,
      fileSizeCiphertext: uploaded.fileSizeCiphertext,
      aeskey: Buffer.from(uploaded.aeskey, "hex"),
      downloadEncryptedQueryParam: uploaded.downloadEncryptedQueryParam,
    }, contextToken);
    messageId = result.messageId;
  } else if (mediaType === "image") {
    deps.log?.(`sendMedia: uploading image ${mediaPath}`);
    const uploaded = await uploadImage({
      filePath: mediaPath,
      toUserId: to,
      ...uploadOpts,
    });
    deps.debugLog?.(`sendMedia: image uploaded, filekey=${uploaded.filekey}`);

    const result = await sendImageMessage(deps, to, text, {
      filekey: uploaded.filekey,
      fileSize: uploaded.fileSize,
      fileSizeCiphertext: uploaded.fileSizeCiphertext,
      aeskey: Buffer.from(uploaded.aeskey, "hex"),
      downloadEncryptedQueryParam: uploaded.downloadEncryptedQueryParam,
    }, contextToken);
    messageId = result.messageId;
  } else {
    deps.log?.(`sendMedia: uploading file ${mediaPath}`);
    const uploaded = await uploadFile({
      filePath: mediaPath,
      fileName,
      toUserId: to,
      ...uploadOpts,
    });
    deps.debugLog?.(`sendMedia: file uploaded, filekey=${uploaded.filekey}`);

    const result = await sendFileMessage(deps, to, text, fileName, {
      filekey: uploaded.filekey,
      fileSize: uploaded.fileSize,
      fileSizeCiphertext: uploaded.fileSizeCiphertext,
      aeskey: Buffer.from(uploaded.aeskey, "hex"),
      downloadEncryptedQueryParam: uploaded.downloadEncryptedQueryParam,
    }, contextToken);
    messageId = result.messageId;
  }

  deps.log?.(`sendMedia: sent successfully, messageId=${messageId}`);
  return { messageId, success: true };
}
