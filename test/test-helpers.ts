import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setAccountStateDir } from "../src/auth/account-store.js";
import { setStateDir } from "../src/storage/state-dir.js";

export function createTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechannel-test-"));
  setStateDir(dir);
  setAccountStateDir(dir);
  return dir;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise.resolve(handler(input, init))) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), "timed out waiting for predicate");
}
