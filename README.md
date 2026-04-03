# WeChat-Channel

独立的微信消息库，支持消息收发、媒体传输、QR码登录。

基于 openclaw-weixin 改造。

## 功能特性

- **QR码登录** - 终端扫码即可登录微信机器人
- **消息接收** - 长轮询方式实时接收消息
- **消息发送** - 支持文本、图片、视频、文件
- **多账户** - 支持同时管理多个机器人账户
- **独立运行** - 无需依赖其他框架，开箱即用

## 安装

```bash
npm install wechat-channel
# 或
pnpm add wechat-channel
```

## 快速开始

### 1. 创建客户端

```typescript
import { WeixinClient } from 'wechannel';

const client = new WeixinClient({
  stateDir: './data',           // 数据存储目录
  log: console.log,             // 日志输出
  errorLog: console.error,      // 错误日志
});

await client.init();
```

### 2. 处理消息

```typescript
client.on('message', async (msg) => {
  console.log(`收到消息: ${msg.text}`);
  console.log(`来自: ${msg.from}`);

  const capability = await client.getReplyCapability(msg.accountId, msg.from);
  if (!capability.canReply) {
    console.log(`当前不可回复: ${capability.reason}`);
    return;
  }

  // 回复消息（会自动使用持久化的 contextToken）
  await client.sendText(msg.accountId, msg.from, '收到！');
});
```

### 3. 登录并启动

```typescript
// 登录（会显示二维码）
const result = await client.login();

if (result.success && result.account) {
  console.log('登录成功！');
  await client.start(result.account.id);
}
```

### 完整示例

```typescript
import { WeixinClient } from 'wechannel';

async function main() {
  const client = new WeixinClient({
    stateDir: './data',
    log: (msg) => console.log(`[LOG] ${msg}`),
    errorLog: (msg) => console.error(`[ERR] ${msg}`),
  });

  await client.init();

  // 处理文本消息
  client.on('message', async (msg) => {
    // 忽略空消息
    if (!msg.text) return;

    console.log(`${msg.from}: ${msg.text}`);

    const capability = await client.getReplyCapability(msg.accountId, msg.from);
    if (!capability.canReply) {
      console.log(`当前不可回复: ${capability.reason}`);
      return;
    }

    // 简单的 echo 机器人
    await client.sendText(msg.accountId, msg.from, `你说: ${msg.text}`);
  });

  // 处理错误
  client.on('error', (err, accountId) => {
    console.error(`账户 ${accountId} 错误:`, err.message);
  });

  client.on('session_status', (status) => {
    console.log(`会话状态: ${status.accountId} -> ${status.status}`);
  });

  // 检查已有账户
  const accounts = client.getAccounts();

  if (accounts.length > 0 && accounts[0].configured) {
    // 已有账户，直接启动
    await client.start(accounts[0].id);
    console.log('消息接收已启动');
  } else {
    // 新用户，扫码登录
    console.log('请扫描二维码登录...');
    const result = await client.login();

    if (result.success && result.account) {
      await client.start(result.account.id);
    }
  }
}

main().catch(console.error);
```

## API 文档

### WeixinClient

主类，提供所有功能。

#### 构造函数

```typescript
new WeixinClient(options?: WeixinClientOptions)
```

**选项:**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `stateDir` | `string` | `~/.wechannel` | 数据存储目录 |
| `baseUrl` | `string` | `https://ilinkai.weixin.qq.com` | API 地址 |
| `cdnBaseUrl` | `string` | CDN 地址 | |
| `log` | `(msg: string) => void` | - | 日志函数 |
| `errorLog` | `(msg: string) => void` | `console.error` | 错误日志函数 |
| `debugLog` | `(msg: string) => void` | - | 调试日志函数 |

#### 方法

##### `init(): Promise<void>`

初始化客户端。**必须在使用其他方法前调用。**

##### `login(options?: LoginOptions): Promise<LoginResult>`

QR码登录。

```typescript
const result = await client.login({
  timeoutMs: 300000,  // 超时时间，默认 8 分钟
  force: false,       // 强制重新登录
});
```

##### `getAccounts(): WeixinAccount[]`

获取所有已登录账户。

##### `start(accountId: string): Promise<void>`

开始接收指定账户的消息。

##### `stop(accountId: string): Promise<void>`

停止接收指定账户的消息。

##### `sendText(accountId, to, text, options?): Promise<SendResult>`

发送文本消息。

```typescript
await client.sendText(
  accountId,
  toUserId,
  '你好！'
);
```

##### `getReplyCapability(accountId, peerId): Promise<ReplyCapability>`

查询当前是否还能对某个用户回复。

```typescript
const capability = await client.getReplyCapability(accountId, toUserId);
if (!capability.canReply) {
  console.log(capability.reason);
}
```

##### `getSessionStatus(accountId): SessionStatus`

读取本地持久化的会话状态：`connected`、`disconnected` 或 `session_expired`。

##### `sendMedia(accountId, to, mediaPath, options?): Promise<SendResult>`

发送媒体文件（图片、视频、文件）。

```typescript
await client.sendMedia(
  accountId,
  toUserId,
  '/path/to/image.jpg',
  {
    text: '看看这张图片',
    contextToken: msg.contextToken,
  }
);
```

##### `logout(accountId: string): Promise<void>`

登出账户，删除本地凭证。

##### `close(): Promise<void>`

关闭客户端，停止所有接收器。

#### 事件

| 事件 | 参数 | 说明 |
|------|------|------|
| `message` | `WeixinMessage` | 收到消息 |
| `error` | `Error, accountId?` | 发生错误 |
| `login` | `WeixinAccount` | 账户登录成功 |
| `logout` | `accountId: string` | 账户登出 |
| `session_status` | `SessionStatus` | 会话状态变化 |

### WeixinMessage

消息对象结构：

```typescript
interface WeixinMessage {
  id: string;              // 消息 ID
  accountId: string;       // 账户 ID
  from: string;            // 发送者 ID
  to: string;              // 接收者 ID
  timestamp: number;       // 时间戳 (毫秒)
  contextToken: string;    // 上下文 Token (回复必需)

  text?: string;           // 文本内容
  image?: MediaInfo;       // 图片
  video?: MediaInfo;       // 视频
  voice?: VoiceInfo;       // 语音
  file?: FileInfo;         // 文件
}
```

## 项目架构

```
src/
├── index.ts              # 入口，导出公共 API
├── client.ts             # WeixinClient 主类
├── types.ts              # 类型定义
├── util.ts               # 工具函数
│
├── api/
│   ├── api.ts            # HTTP API 客户端
│   └── types.ts          # API 请求/响应类型
│
├── auth/
│   ├── account-store.ts  # 账户凭证存储
│   └── qr-login.ts       # QR码登录流程
│
├── messaging/
│   ├── receiver.ts       # 消息接收器 (长轮询)
│   ├── sender.ts         # 消息发送器
│   ├── sender-media.ts   # 媒体发送
│   └── context-token.ts  # 上下文 Token 管理
│
├── media/
│   ├── crypto.ts         # AES-128-ECB 加解密
│   ├── uploader.ts       # CDN 上传
│   └── downloader.ts     # CDN 下载
│
└── storage/
    ├── state-dir.ts      # 状态目录管理
    └── sync-buf.ts       # 同步缓冲持久化
```

### 核心流程

**消息接收:**
```
start() → 长轮询 getUpdates → 解析消息 → 下载媒体 → 触发 message 事件
```

**消息发送:**
```
sendText/sendMedia → 获取 contextToken → 调用 API → 返回结果
```

**媒体发送:**
```
sendMedia → 读取文件 → AES加密 → CDN上传 → 发送消息引用
```

## 重要说明

### Context Token

微信要求每条回复消息必须携带 `contextToken`，该 Token 从收到的消息中获取：

```typescript
client.on('message', async (msg) => {
  const capability = await client.getReplyCapability(accountId, msg.from);
  if (!capability.canReply) return;

  // ✅ 正确：sendText 会自动使用最近 24 小时内持久化的 contextToken
  await client.sendText(accountId, msg.from, '回复');

  // 也可以显式覆盖
  await client.sendText(accountId, msg.from, '回复', {
    contextToken: msg.contextToken,
  });
});
```

**这意味着你只能回复收到的消息，不能主动发送消息给用户。**

`getReplyCapability()` 会返回以下原因之一：

- `missing_context`：从未收到该用户的可回复消息
- `expired`：最近一次 `contextToken` 已超过 24 小时
- `session_expired`：会话已经失效
- `not_connected`：当前账户未连接

### 数据存储

默认存储在 `~/.wechannel/` 目录：

```
~/.wechannel/
├── accounts.json         # 账户索引
├── accounts/             # 账户凭证
│   └── {accountId}.json
├── reply-context/        # 最近一次可回复上下文
│   └── {accountId}.json
├── session-status/       # 会话状态
│   └── {accountId}.json
├── media/                # 下载的媒体文件
└── sync-buf/             # 同步缓冲
    └── {accountId}.sync.json
```

可通过 `stateDir` 选项自定义目录。

### 会话过期

长时间不活动后，会话可能过期。客户端会在本地持久化 `session_expired` 状态，并通过 `session_status` 事件通知上层。

## 开发

```bash
# 安装依赖
pnpm install

# 编译
pnpm build

# 类型检查
pnpm tsc --noEmit

# 运行示例
pnpm example
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `WECHANNEL_STATE_DIR` | 自定义数据存储目录 |

## License

MIT
