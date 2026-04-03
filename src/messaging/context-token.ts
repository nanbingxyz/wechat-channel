import fs from "node:fs";
import path from "node:path";

import type { ReplyCapability } from "../types.js";

import { getStateDir } from "../storage/state-dir.js";

const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ReplyContextEntry {
  peerId: string;
  contextToken: string;
  lastInboundAt: number;
  expiresAt: number;
  messageId?: string;
}

type ReplyContextStore = Record<string, ReplyContextEntry>;

function resolveReplyContextDir(): string {
  return path.join(getStateDir(), "reply-context");
}

function getReplyContextFilePath(accountId: string): string {
  return path.join(resolveReplyContextDir(), `${accountId}.json`);
}

function readReplyContextStore(accountId: string): ReplyContextStore {
  const filePath = getReplyContextFilePath(accountId);
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, Partial<ReplyContextEntry>>;
    const result: ReplyContextStore = {};
    for (const [peerId, value] of Object.entries(raw)) {
      if (
        typeof value.contextToken === "string" &&
        typeof value.lastInboundAt === "number" &&
        typeof value.expiresAt === "number"
      ) {
        result[peerId] = {
          peerId,
          contextToken: value.contextToken,
          lastInboundAt: value.lastInboundAt,
          expiresAt: value.expiresAt,
          ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeReplyContextStore(accountId: string, data: ReplyContextStore): void {
  const filePath = getReplyContextFilePath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function setContextToken(
  accountId: string,
  userId: string,
  token: string,
  options: {
    receivedAt?: number;
    messageId?: string;
  } = {},
): ReplyContextEntry {
  const now = options.receivedAt ?? Date.now();
  const entry: ReplyContextEntry = {
    peerId: userId,
    contextToken: token,
    lastInboundAt: now,
    expiresAt: now + REPLY_WINDOW_MS,
    ...(options.messageId ? { messageId: options.messageId } : {}),
  };
  const store = readReplyContextStore(accountId);
  store[userId] = entry;
  writeReplyContextStore(accountId, store);
  return entry;
}

export function getStoredReplyContext(
  accountId: string,
  userId: string,
): ReplyContextEntry | undefined {
  return readReplyContextStore(accountId)[userId];
}

export function getContextToken(
  accountId: string,
  userId: string,
  now: number = Date.now(),
): string | undefined {
  const entry = getStoredReplyContext(accountId, userId);
  if (!entry || entry.expiresAt <= now) {
    return undefined;
  }
  return entry.contextToken;
}

export function getReplyCapabilityFromContext(
  accountId: string,
  userId: string,
  now: number = Date.now(),
): ReplyCapability {
  const entry = getStoredReplyContext(accountId, userId);
  if (!entry) {
    return { canReply: false, reason: "missing_context" };
  }
  if (entry.expiresAt <= now) {
    return {
      canReply: false,
      reason: "expired",
      lastInboundAt: entry.lastInboundAt,
      expiresAt: entry.expiresAt,
    };
  }
  return {
    canReply: true,
    lastInboundAt: entry.lastInboundAt,
    expiresAt: entry.expiresAt,
    contextToken: entry.contextToken,
  };
}

export function deleteContextToken(accountId: string, userId: string): void {
  const store = readReplyContextStore(accountId);
  if (!store[userId]) {
    return;
  }
  delete store[userId];
  writeReplyContextStore(accountId, store);
}

export function clearReplyContexts(accountId: string): void {
  try {
    fs.unlinkSync(getReplyContextFilePath(accountId));
  } catch {
    // ignore
  }
}

export function clearAllContextTokens(): void {
  try {
    fs.rmSync(resolveReplyContextDir(), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function getContextTokenCount(accountId?: string): number {
  if (accountId) {
    return Object.keys(readReplyContextStore(accountId)).length;
  }
  try {
    const dir = resolveReplyContextDir();
    if (!fs.existsSync(dir)) {
      return 0;
    }
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
