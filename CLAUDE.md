# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

独立的微信消息库 (Wechannel)，提供微信机器人消息收发功能。支持 QR 码登录、长轮询接收消息、发送文本和媒体消息。

## Quick Start

```typescript
import { WeixinClient } from 'wechannel';

const client = new WeixinClient({ stateDir: './data' });
await client.init();

// 处理消息
client.on('message', async (msg) => {
  await client.sendText(msg.accountId, msg.from, '收到！', {
    contextToken: msg.contextToken,
  });
});

// 登录并启动
const result = await client.login();
if (result.success && result.account) {
  await client.start(result.account.id);
}
```

## Architecture

```
src/
├── index.ts              # 公共 API 导出
├── client.ts             # WeixinClient 主类
├── types.ts              # 类型定义
├── util.ts               # 工具函数
│
├── api/
│   ├── api.ts            # HTTP API 客户端
│   ├── types.ts          # API 类型
│   └── session-guard.ts  # 会话管理
│
├── auth/
│   ├── account-store.ts  # 账户存储
│   └── qr-login.ts       # QR 登录
│
├── messaging/
│   ├── receiver.ts       # 消息接收器 (事件驱动)
│   ├── sender.ts         # 消息发送
│   ├── sender-media.ts   # 媒体发送
│   └── context-token.ts  # Context Token 管理
│
├── media/
│   ├── crypto.ts         # AES 加解密
│   ├── uploader.ts       # CDN 上传
│   └── downloader.ts     # CDN 下载
│
└── storage/
    ├── state-dir.ts      # 状态目录
    └── sync-buf.ts       # 同步缓冲
```

## Key Concepts

**WeixinClient**: 主入口类，提供完整的消息收发 API
- `init()` - 初始化客户端
- `login()` - QR 码登录
- `start(accountId)` - 开始接收消息
- `sendText/sendMedia()` - 发送消息

**Context Token**: 每条消息附带，回复时必须原样返回。只能回复收到的消息，不能主动发送。

**Account Storage**: 账户数据存储在 `{stateDir}/accounts/{id}.json`

**Sync Buffer**: `get_updates_buf` 持久化，用于断线重连后继续接收

## Commands

```bash
# 编译
pnpm build

# 运行示例
pnpm example

# 类型检查
npx tsc --noEmit
```

## Environment Variables

- `WECHANNEL_STATE_DIR` - 状态目录 (默认: `~/.wechannel`)

## Important Notes

1. **Context Token 必需**: 发送消息需要有效的 contextToken，只能回复收到的消息
2. **会话过期**: 长时间不活动需要重新扫码登录
3. **媒体加密**: 上传图片/视频需要 AES-128-ECB 加密
