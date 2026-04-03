import test from "node:test";
import assert from "node:assert/strict";

import { WeixinClient } from "../src/client.js";
import { saveAccount } from "../src/auth/account-store.js";
import {
  clearReplyContexts,
  getContextToken,
  getStoredReplyContext,
  setContextToken,
} from "../src/messaging/context-token.js";
import { saveSessionStatus } from "../src/storage/session-status.js";

import { createTempStateDir, installFetchMock, jsonResponse } from "./test-helpers.js";

test("reply context persists and expires after 24 hours", async () => {
  createTempStateDir();

  setContextToken("bot-1", "user-1", "ctx-1", {
    receivedAt: 1_000,
    messageId: "msg-1",
  });

  const entry = getStoredReplyContext("bot-1", "user-1");
  assert.ok(entry);
  assert.equal(entry.messageId, "msg-1");
  assert.equal(getContextToken("bot-1", "user-1", 1_000 + 23 * 60 * 60 * 1000), "ctx-1");
  assert.equal(getContextToken("bot-1", "user-1", 1_000 + 24 * 60 * 60 * 1000), undefined);
});

test("getReplyCapability reports missing, expired, session expired and not connected", async () => {
  const stateDir = createTempStateDir();
  saveAccount("bot-2", { token: "token-2" });

  const client = new WeixinClient({ stateDir });
  await client.init();
  saveAccount("bot-2", { token: "token-2" });

  saveSessionStatus("bot-2", "connected", { changedAt: 1 });
  let capability = await client.getReplyCapability("bot-2", "user-1");
  assert.deepEqual(capability, { canReply: false, reason: "missing_context" });

  setContextToken("bot-2", "user-1", "ctx-2", {
    receivedAt: Date.now() - 25 * 60 * 60 * 1000,
  });
  capability = await client.getReplyCapability("bot-2", "user-1");
  assert.equal(capability.canReply, false);
  assert.equal(capability.reason, "expired");

  saveSessionStatus("bot-2", "session_expired", { changedAt: 2 });
  capability = await client.getReplyCapability("bot-2", "user-1");
  assert.deepEqual(capability, { canReply: false, reason: "session_expired" });

  saveSessionStatus("bot-2", "disconnected", { changedAt: 3 });
  capability = await client.getReplyCapability("bot-2", "user-1");
  assert.deepEqual(capability, { canReply: false, reason: "not_connected" });
});

test("login success clears stale reply context and resets session state", async () => {
  const stateDir = createTempStateDir();
  saveAccount("bot-3-im-bot", { token: "old-token" });
  setContextToken("bot-3-im-bot", "user-1", "ctx-stale");
  saveSessionStatus("bot-3-im-bot", "session_expired", {
    changedAt: 1,
    errorCode: -14,
    errorMessage: "old expired",
  });

  const restoreFetch = installFetchMock((input) => {
    const url = input.toString();
    if (url.includes("get_bot_qrcode")) {
      return jsonResponse({
        qrcode: "qr-1",
        qrcode_img_content: "https://example.com/qr-1",
      });
    }
    if (url.includes("get_qrcode_status")) {
      return jsonResponse({
        status: "confirmed",
        bot_token: "new-token",
        ilink_bot_id: "bot-3@im.bot",
        baseurl: "https://ilinkai.weixin.qq.com",
        ilink_user_id: "user-bot-3",
      });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });

  try {
    const client = new WeixinClient({ stateDir });
    await client.init();

    const result = await client.login({
      accountId: "bot-3-im-bot",
      timeoutMs: 1_000,
    });

    assert.equal(result.success, true);
    assert.equal(getStoredReplyContext("bot-3-im-bot", "user-1"), undefined);
    assert.equal(client.getSessionStatus("bot-3-im-bot").status, "disconnected");
  } finally {
    restoreFetch();
    clearReplyContexts("bot-3-im-bot");
  }
});
