# Z-Image OpenAI Compatible Image Gateway (Cloudflare Worker) 🚀🖼️

一个部署在 **Cloudflare Worker** 上的 **OpenAI 兼容图像生成网关** ✨
它会把梦羽 AI 绘图服务
（`https://sd.exacg.cc/api/v1/generate_image`）封装成标准的 OpenAI 接口：

- `GET /v1/models` ✅
- `POST /v1/chat/completions` ✅

因此你可以像调用 OpenAI 一样调用它，兼容大部分 **OpenAI SDK / 工具 / GPTs Custom API**（如 Cherry Studio 等）🎨

---

## ✨ 功能特性

- ✅ **OpenAI `v1/chat/completions` 协议兼容**（当前仅支持非流式 `stream: false`）
- ✅ 支持 `GET /v1/models`，返回唯一模型：`"Z-Image"`
- ✅ 自动从 `prompt` 中识别比例：`1:1 / 1:2 / 3:2 / 3:4 / 16:9 / 9:16`
- ✅ 每次请求默认使用随机 `seed`（除非客户端显式指定），避免重复画面
- ✅ 自动将结果封装为 **Markdown 图片**：客户端直接渲染 `![alt](url)` 即可
- ✅ 内置网关层 API Key 鉴权，保护上游 `SD_API_KEY`
- ✅ 已开启 CORS，可在浏览器 / 前端直接调用

---

## 🧱 架构说明

```text
Client (OpenAI style)
        |
        |  POST /v1/chat/completions
        v
[ Cloudflare Worker ]
        |
        |  POST https://sd.exacg.cc/api/v1/generate_image
        v
   梦羽 API 服务
```

- 对外：Worker 暴露 **OpenAI 兼容接口**，客户端只需识别模型名 `Z-Image` 🧠
- 对内：Worker 使用你的 **`SD_API_KEY`** 调用 `sd.exacg.cc` 的原始生成接口 🔑

---

## 🔐 环境变量配置

在 Cloudflare Worker 的
**Environment / Settings → Variables → Secrets** 中配置以下变量：

- `SD_API_KEY`
  你在 `https://sd.exacg.cc` 的 **真实 API Key**，用于调用上游梦羽绘图服务。

- `GATEWAY_API_KEY`
  暴露给客户端的 **网关层 API Key**，客户端访问 Worker 时需要带上：

  ```http
  Authorization: Bearer YOUR_GATEWAY_API_KEY
  ```

> 💡 建议：
> 上游 `SD_API_KEY` **只存放在 Worker**，绝不要下发到前端/用户，统一通过网关来隔离。

---

## 🚀 部署方式（示例）

### 1. 复制代码为 `worker.js`

将本仓库的 `worker.js` 复制到你的 Cloudflare Worker 脚本中。

### 2. 使用 Cloudflare Dashboard 部署（最简单）🧩

1. 进入 Cloudflare Dashboard → **Workers & Pages → Create Worker**
2. 将编辑器中的默认代码替换为本项目的 `worker.js`
3. 在该 Worker 的 **Settings → Variables → Secrets** 中添加：
   - `SD_API_KEY`
   - `GATEWAY_API_KEY`
4. 点击 **Deploy** 一键部署 ✅

部署完成后，你会得到一个类似：

```text
https://your-worker-name.your-subdomain.workers.dev
```

的域名，下面的所有示例都以此为基础。

> 🛠️ 如果你习惯使用 `wrangler` CLI，也可以自行添加 `wrangler.toml` 并使用
> `wrangler deploy` 部署，这里不展开。

---

## 📡 API 说明

### 1. 列出模型：`GET /v1/models` 📜

**请求：**

```bash
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_GATEWAY_API_KEY"
```

**响应示例：**

```json
{
  "object": "list",
  "data": [
    {
      "id": "Z-Image",
      "object": "model",
      "created": 1730800000,
      "owned_by": "sd-exacg-gateway"
    }
  ]
}
```

你可以在客户端的 `model` 字段中直接写 `"Z-Image"` 即可使用本网关。

---

### 2. 生成图片：`POST /v1/chat/completions` 🎨

**必需字段：**

- Header：
  - `Authorization: Bearer YOUR_GATEWAY_API_KEY`
- Body：
  - `model`: 必须为 `"Z-Image"`
  - `messages`: OpenAI Chat 风格的消息数组（取最后一个 `role: "user"` 作为 prompt）

**可选字段：**

- 通过在 **prompt 文本中写比例** 控制分辨率：
  - `1:1` → `2048 x 2048`
  - `1:2` → `1024 x 2048`
  - `3:2` → `1920 x 1280`
  - `3:4` → `1536 x 2048`
  - `16:9` → `2048 x 1152`
  - `9:16` → `1152 x 2048`
- 或者直接在 body 里显式传数值字段（优先级最高）：
  - `width`
  - `height`
- 其他参数：
  - `cfg`: 浮点数，不传时默认 `7.0`
  - `seed`: 数值，传了则固定，不传则自动随机
  - `negative_prompt`: 负面提示词（字符串）

#### 📐 分辨率逻辑

Worker 内部对分辨率的处理逻辑为：

- 如果 body 中显式传了 `width` 和 `height`：**优先直接使用**
- 否则：从 prompt 文本中尝试识别比例（支持 `1:2` 或 `1：2` 等形式）
- 如果无法识别比例：默认为 `1:1 = 2048 x 2048`

> 💡 小提示：
> 比例文本会在送给 SD 模型前，从 prompt 中被清理掉，避免影响绘图语义。

---

#### 🌈 请求示例：默认 1:1

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" \
  -d '{
    "model": "Z-Image",
    "messages": [
      { "role": "user", "content": "一只可爱的小狗" }
    ]
  }'
```

→ 实际分辨率：`2048 x 2048`

#### 📱 请求示例：竖图 1:2

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" \
  -d '{
    "model": "Z-Image",
    "messages": [
      { "role": "user", "content": "一只可爱的小狗，1:2" }
    ]
  }'
```

→ 实际分辨率：`1024 x 2048`
→ 发送给 SD 的最终 prompt 会是去掉比例后的：`"一只可爱的小狗"` ✅

---

#### 📦 响应示例

返回的是标准 OpenAI 风格的 `chat.completion` 对象：

```json
{
  "id": "chatcmpl-xxxx",
  "object": "chat.completion",
  "created": 1730800000,
  "model": "Z-Image",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": {
        "role": "assistant",
        "content": "![一只可爱的小狗](https://.../image.webp)"
      }
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

- `choices[0].message.content` 是一个 **Markdown 图片字符串**：`![alt](image_url)` 🖼️
- 在支持 Markdown 渲染的客户端（如 Cherry Studio）中会直接显示图片。
- 如果你只想拿到图片 URL，可以在代码中从这段 Markdown 中解析链接。

---

## 🧰 与 OpenAI SDK 一起使用

以 `openai` 官方 JS SDK 为例（兼容 `baseURL + apiKey` 形式）：

```bash
npm install openai
```

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-worker.workers.dev',
  apiKey: 'YOUR_GATEWAY_API_KEY',
});

const res = await client.chat.completions.create({
  model: 'Z-Image',
  messages: [
    { role: 'user', content: '一只可爱的小狗，16:9' },
  ],
});

// Markdown 字符串
const markdown = res.choices[0].message.content;

// 如需提取 URL，可以简单用正则
const match = markdown.match(/\((https?:[^)]+)\)/);
const imageUrl = match ? match[1] : null;

console.log('Image URL:', imageUrl);
```

> ✅ 换成你熟悉的语言（Python / Go / Java 等）时，只要支持自定义 `baseURL` 和 `apiKey` 的 OpenAI SDK，使用方式基本相同。

---

## 🔄 上游 SD API 约定（当前实现）

Worker 会向你的 SD 上游服务发送类似如下的 JSON 请求：

```json
{
  "prompt": "处理后的提示词（已剔除比例）",
  "width": 2048,
  "height": 1152,
  "steps": 8,
  "cfg": 7.0,
  "model_index": 5,
  "seed": 123456789,
  "negative_prompt": "可选"
}
```

其中：

- `steps`：当前固定为 `8`
- `model_index`：当前固定为 `5`（指向 z-image，你可以按需调整）
- `seed`：
  - 如果客户端在 body 中传了 `seed`，则直接使用客户端给定值
  - 如果未传，Worker 会自动生成随机整数，保证同一 prompt 也能得到不同结果 🎲

---

## ⚠️ 限制与注意事项

- 当前只实现了两个接口：
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- 暂不支持：
  - 流式响应（`stream: true`）
  - `v1/images/*` 等其它 OpenAI 原生图像接口
- `usage` 字段目前全部为 `0`，仅为结构兼容，不做真实 Token 计费统计

**如需扩展，可以考虑：**

- 多模型支持：不同 `model` 名映射到不同 `model_index` 或不同模型权重
- 自定义“质量档位”：通过分辨率 + `steps` 控制画质和速度
- 添加更多参数：如 `sampler`、`style`、`tiling` 等，映射到上游 SD 实现

---

## 📜 License

MIT License
