import fs from "node:fs";
import path from "node:path";

import type { SessionState, SessionStatus } from "../types.js";

import { getStateDir } from "./state-dir.js";

function resolveSessionStatusDir(): string {
  return path.join(getStateDir(), "session-status");
}

function getSessionStatusFilePath(accountId: string): string {
  return path.join(resolveSessionStatusDir(), `${accountId}.json`);
}

function defaultSessionStatus(accountId: string): SessionStatus {
  return {
    accountId,
    status: "disconnected",
    changedAt: 0,
  };
}

export function loadSessionStatus(accountId: string): SessionStatus {
  const filePath = getSessionStatusFilePath(accountId);
  try {
    if (!fs.existsSync(filePath)) {
      return defaultSessionStatus(accountId);
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<SessionStatus>;
    if (raw.status !== "connected" && raw.status !== "disconnected" && raw.status !== "session_expired") {
      return defaultSessionStatus(accountId);
    }
    return {
      accountId,
      status: raw.status,
      changedAt: typeof raw.changedAt === "number" ? raw.changedAt : 0,
      ...(typeof raw.errorCode === "number" ? { errorCode: raw.errorCode } : {}),
      ...(typeof raw.errorMessage === "string" && raw.errorMessage
        ? { errorMessage: raw.errorMessage }
        : {}),
    };
  } catch {
    return defaultSessionStatus(accountId);
  }
}

export function saveSessionStatus(
  accountId: string,
  status: SessionState,
  options: {
    changedAt?: number;
    errorCode?: number;
    errorMessage?: string;
  } = {},
): SessionStatus {
  const data: SessionStatus = {
    accountId,
    status,
    changedAt: options.changedAt ?? Date.now(),
    ...(typeof options.errorCode === "number" ? { errorCode: options.errorCode } : {}),
    ...(typeof options.errorMessage === "string" && options.errorMessage
      ? { errorMessage: options.errorMessage }
      : {}),
  };

  const filePath = getSessionStatusFilePath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return data;
}

export function deleteSessionStatus(accountId: string): void {
  try {
    fs.unlinkSync(getSessionStatusFilePath(accountId));
  } catch {
    // ignore
  }
}
