import os from "node:os";
import path from "node:path";

let customStateDir: string | null = null;

/**
 * 设置自定义状态目录
 */
export function setStateDir(dir: string): void {
  customStateDir = dir;
}

/**
 * 获取当前状态目录
 */
export function getStateDir(): string {
  return customStateDir ?? resolveDefaultStateDir();
}

/**
 * 解析默认状态目录
 */
export function resolveDefaultStateDir(): string {
  return (
    process.env.WECHANNEL_STATE_DIR?.trim() ||
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".wechannel")
  );
}

/**
 * 解析状态目录 (保持向后兼容)
 * @deprecated 使用 getStateDir() 代替
 */
export function resolveStateDir(): string {
  return getStateDir();
}
