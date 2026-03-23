/**
 * Wechannel 基本使用示例
 *
 * 运行: npx tsx examples/basic-usage.ts
 */

import { WeixinClient } from "../src/index.js";

async function main() {
  // 创建客户端
  const client = new WeixinClient({
    stateDir: "./data", // 数据存储目录
    log: (msg) => console.log(`[LOG] ${msg}`),
    errorLog: (msg) => console.error(`[ERROR] ${msg}`),
    debugLog: (msg) => console.log(`[DEBUG] ${msg}`),
  });

  // 初始化
  await client.init();

  // 处理收到的消息
  client.on("message", async (msg) => {
    console.log(`\n收到消息:`);
    console.log(`  来自: ${msg.from}`);
    console.log(`  文本: ${msg.text ?? "(无)"}`);

    if (msg.image) {
      console.log(`  图片: ${msg.image.path}`);
    }
    if (msg.video) {
      console.log(`  视频: ${msg.video.path}`);
    }
    if (msg.voice) {
      console.log(`  语音: ${msg.voice.path}`);
    }
    if (msg.file) {
      console.log(`  文件: ${msg.file.filename} -> ${msg.file.path}`);
    }

    // 回复文本消息
    if (msg.text) {
      try {
        const result = await client.sendText(msg.accountId, msg.from, `收到: ${msg.text}`, {
          contextToken: msg.contextToken,
        });
        console.log(`  回复成功: ${result.messageId}`);
      } catch (err) {
        console.error(`  回复失败: ${String(err)}`);
      }
    }
  });

  // 处理错误
  client.on("error", (err, accountId) => {
    console.error(`账户 ${accountId} 错误: ${err.message}`);
  });

  // 处理登录事件
  client.on("login", (account) => {
    console.log(`账户登录成功: ${account.id}`);
  });

  // 处理登出事件
  client.on("logout", (accountId) => {
    console.log(`账户已登出: ${accountId}`);
  });

  // 检查已有账户
  const accounts = client.getAccounts();
  console.log(`已有 ${accounts.length} 个账户`);

  if (accounts.length > 0) {
    // 显示已有账户
    for (const account of accounts) {
      console.log(`  - ${account.id} (configured: ${account.configured})`);
    }

    // 启动第一个账户
    const firstAccount = accounts[0];
    if (firstAccount.configured) {
      console.log(`\n启动账户 ${firstAccount.id} 的消息接收...`);
      await client.start(firstAccount.id);
      console.log("消息接收已启动，等待消息...\n");
    }
  } else {
    // 没有账户，开始登录
    console.log("\n没有已登录的账户，开始 QR 登录...");
    const loginResult = await client.login();

    if (loginResult.success && loginResult.account) {
      console.log(`\n登录成功！账户 ID: ${loginResult.account.id}`);
      await client.start(loginResult.account.id);
      console.log("消息接收已启动，等待消息...\n");
    } else {
      console.error(`\n登录失败: ${loginResult.message}`);
    }
  }

  // 保持运行
  console.log("\n按 Ctrl+C 退出...\n");

  // 优雅关闭
  process.on("SIGINT", async () => {
    console.log("\n正在关闭...");
    await client.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
