import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { WeixinClient } from "../src/client.js";
import { saveAccount } from "../src/auth/account-store.js";
import { getSyncBufFilePath } from "../src/storage/sync-buf.js";

import {
  createTempStateDir,
  installFetchMock,
  jsonResponse,
  waitFor,
} from "./test-helpers.js";

test("start and stop emit session status and migrate sync buffer through shared helper", async () => {
  const stateDir = createTempStateDir();
  saveAccount("bot-sync", { token: "token-sync" });

  fs.mkdirSync(path.join(stateDir, "sync-buf"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "sync-buf", "bot-sync.json"),
    JSON.stringify({ getUpdatesBuf: "legacy-buf" }),
    "utf-8",
  );

  const seenRequestBodies: string[] = [];
  let updatesCalls = 0;
  const restoreFetch = installFetchMock(async (input, init) => {
    const url = input.toString();
    if (!url.includes("getupdates")) {
      throw new Error(`unexpected fetch url: ${url}`);
    }

    const body = typeof init?.body === "string" ? init.body : "";
    seenRequestBodies.push(body);
    updatesCalls += 1;

    if (updatesCalls === 1) {
      return jsonResponse({
        ret: 0,
        msgs: [],
        get_updates_buf: "next-buf",
      });
    }

    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  });

  try {
    const client = new WeixinClient({ stateDir });
    await client.init();

    const statuses: string[] = [];
    client.on("session_status", (status) => {
      statuses.push(status.status);
    });

    await client.start("bot-sync");

    await waitFor(() => seenRequestBodies.length > 0);
    assert.match(seenRequestBodies[0], /"get_updates_buf":"legacy-buf"/);
    await waitFor(() => client.getSessionStatus("bot-sync").status === "connected");
    await waitFor(() => {
      try {
        const persisted = JSON.parse(fs.readFileSync(getSyncBufFilePath("bot-sync"), "utf-8")) as {
          get_updates_buf: string;
        };
        return persisted.get_updates_buf === "next-buf";
      } catch {
        return false;
      }
    });

    await client.stop("bot-sync");
    assert.equal(client.getSessionStatus("bot-sync").status, "disconnected");
    assert.deepEqual(statuses.slice(0, 2), ["connected", "disconnected"]);

    const persisted = JSON.parse(fs.readFileSync(getSyncBufFilePath("bot-sync"), "utf-8")) as {
      get_updates_buf: string;
    };
    assert.equal(persisted.get_updates_buf, "next-buf");
  } finally {
    restoreFetch();
  }
});

test("polling session_expired updates persisted status and emits event", async () => {
  const stateDir = createTempStateDir();
  saveAccount("bot-expired", { token: "token-expired" });

  const restoreFetch = installFetchMock((input) => {
    const url = input.toString();
    if (!url.includes("getupdates")) {
      throw new Error(`unexpected fetch url: ${url}`);
    }
    return jsonResponse({
      ret: 1,
      errcode: -14,
      errmsg: "session expired",
      msgs: [],
    });
  });

  try {
    const client = new WeixinClient({ stateDir });
    await client.init();

    const statuses: string[] = [];
    client.on("session_status", (status) => {
      statuses.push(status.status);
    });

    await client.start("bot-expired");
    await waitFor(() => client.getSessionStatus("bot-expired").status === "session_expired");

    assert.equal(client.getSessionStatus("bot-expired").errorCode, -14);
    assert.ok(statuses.includes("session_expired"));
  } finally {
    restoreFetch();
  }
});
