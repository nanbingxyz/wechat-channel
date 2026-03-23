/**
 * AES 加解密工具 - CDN 上传下载使用
 */

import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-128-ECB 加密
 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * AES-128-ECB 解密
 */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 计算 AES-128-ECB 加密后的密文大小 (PKCS7 padding to 16-byte boundary)
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * 解析 CDN 返回的 AES 密钥
 *
 * 支持两种编码格式:
 *   - base64(raw 16 bytes) → 图片 (aes_key from media field)
 *   - base64(hex string of 16 bytes) → 文件/语音/视频
 *
 * 第二种情况，base64 解码后得到 32 个 ASCII hex 字符，需要再解析为 hex 才能获得实际的 16 字节密钥
 */
export function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    // hex-encoded key: base64 → hex string → raw bytes
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}
