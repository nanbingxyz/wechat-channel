import test from "node:test";
import assert from "node:assert/strict";

import { WeixinClient } from "../src/client.js";
import { WeixinClientError } from "../src/errors.js";
import { saveAccount } from "../src/auth/account-store.js";
import { setContextToken, getStoredReplyContext } from "../src/messaging/context-token.js";
import { saveSessionStatus } from "../src/storage/session-status.js";

import { createTempStateDir, installFetchMock, jsonResponse } from "./test-helpers.js";

test("sendText uses stored context token and persists session_expired on API failure", async () => {
  const stateDir = createTempStateDir();
  saveAccount("bot-send", { token: "token-send" });
  saveSessionStatus("bot-send", "connected");
  setContextToken("bot-send", "user-1", "ctx-valid");

  let lastBody = "";
  const restoreFetch = installFetchMock(async (input, init) => {
    const url = input.toString();
    if (!url.includes("sendmessage")) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    lastBody = typeof init?.body === "string" ? init.body : "";
    return jsonResponse({ errcode: -14, errmsg: "session expired" });
  });

  try {
    const client = new WeixinClient({ stateDir });
    await client.init();

    await assert.rejects(
      client.sendText("bot-send", "user-1", "hello"),
      (error: unknown) => {
        assert.ok(error instanceof WeixinClientError);
        assert.equal(error.code, "ERR_SESSION_EXPIRED");
        return true;
      },
    );

    assert.match(lastBody, /"context_token":"ctx-valid"/);
    assert.equal(client.getSessionStatus("bot-send").status, "session_expired");
  } finally {
    restoreFetch();
  }
});

test("explicit context token bypasses stored lookup and missing or expired stored token raises structured errors", async () => {
  const stateDir = createTempStateDir();
  saveAccount("bot-send-2", { token: "token-send-2" });
  saveSessionStatus("bot-send-2", "connected");

  let sendCount = 0;
  const restoreFetch = installFetchMock(async (input, init) => {
    const url = input.toString();
    if (!url.includes("sendmessage")) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    sendCount += 1;
    const body = typeof init?.body === "string" ? init.body : "";
    assert.match(body, /"context_token":"ctx-explicit"/);
    return jsonResponse({});
  });

  try {
    const client = new WeixinClient({ stateDir });
    await client.init();

    const result = await client.sendText("bot-send-2", "user-2", "hello", {
      contextToken: "ctx-explicit",
    });
    assert.equal(result.success, true);
    assert.equal(sendCount, 1);

    await assert.rejects(
      client.sendText("bot-send-2", "user-missing", "hello"),
      (error: unknown) => {
        assert.ok(error instanceof WeixinClientError);
        assert.equal(error.code, "ERR_CONTEXT_TOKEN_MISSING");
        return true;
      },
    );

    setContextToken("bot-send-2", "user-expired", "ctx-old", {
      receivedAt: Date.now() - 25 * 60 * 60 * 1000,
    });

    await assert.rejects(
      client.sendText("bot-send-2", "user-expired", "hello"),
      (error: unknown) => {
        assert.ok(error instanceof WeixinClientError);
        assert.equal(error.code, "ERR_CONTEXT_TOKEN_EXPIRED");
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("logout clears reply context", async () => {
  const stateDir = createTempStateDir();
  saveAccount("bot-logout", { token: "token-logout" });
  setContextToken("bot-logout", "user-1", "ctx-logout");

  const client = new WeixinClient({ stateDir });
  await client.init();
  await client.logout("bot-logout");

  assert.equal(getStoredReplyContext("bot-logout", "user-1"), undefined);
  assert.equal(client.getSessionStatus("bot-logout").status, "disconnected");
});
