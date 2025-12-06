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
- ✅ **🆕 AI Prompt 增强**：自动将简单描述扩展为专业的图像生成提示词
- ✅ 自动从 `prompt` 中识别比例：`1:1 / 1:2 / 3:2 / 3:4 / 16:9 / 9:16`（需包含"比例"或"ratio"触发词）
- ✅ 每次请求默认使用随机 `seed`（除非客户端显式指定），避免重复画面
- ✅ 自动将结果封装为 **Markdown 图片**：客户端直接渲染 `![alt](url)` 即可
- ✅ **🆕 透明化展示**：返回内容包含原始输入、增强后的 prompt、比例和分辨率信息
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
        |  (可选) 调用 LLM 增强 prompt
        |
        |  POST https://sd.exacg.cc/api/v1/generate_image
        v
   梦羽 API 服务
```

- 对外：Worker 暴露 **OpenAI 兼容接口**，客户端只需识别模型名 `Z-Image` 🧠
- 对内：Worker 使用你的 **`SD_API_KEY`** 调用 `sd.exacg.cc` 的原始生成接口 🔑
- **🆕 可选增强**：通过 GPT-4o-mini 等 LLM 将简单描述自动扩展为专业 prompt 🎨

---

## 🔐 环境变量配置

在 Cloudflare Worker 的
**Environment / Settings → Variables → Secrets** 中配置以下变量：

### 必需配置

- `SD_API_KEY`
  你在 `https://sd.exacg.cc` 的 **真实 API Key**，用于调用上游梦羽绘图服务。

- `GATEWAY_API_KEY`
  暴露给客户端的 **网关层 API Key**，客户端访问 Worker 时需要带上：

  ```http
  Authorization: Bearer YOUR_GATEWAY_API_KEY
  ```

### 🆕 可选配置（Prompt 增强功能）

- `ENHANCE_OPENAI_API_KEY`
  用于调用 LLM API 进行 prompt 增强的 API Key（如 OpenAI API Key）

- `ENHANCE_OPENAI_BASE_URL`（可选）
  LLM API 的 Base URL，默认为 `https://api.openai.com/v1`
  如果使用其他兼容 OpenAI 格式的服务（如 Azure OpenAI、第三方代理等），可以修改此项

- `ENHANCE_OPENAI_MODEL`（可选）
  使用的模型名称，默认为 `gpt-4o-mini`
  推荐使用快速且成本低的模型，如 `gpt-4o-mini` 或 `claude-3-5-haiku`（需对应 base URL）

> 💡 建议：
> - 上游 `SD_API_KEY` **只存放在 Worker**，绝不要下发到前端/用户，统一通过网关来隔离
> - **Prompt 增强功能默认开启**，如未配置 `ENHANCE_OPENAI_API_KEY`，则静默降级为直接使用用户原始 prompt

---

## 🚀 部署方式（示例）

### 1. 复制代码为 `worker.js`

将本仓库的 `worker.js` 复制到你的 Cloudflare Worker 脚本中。

### 2. 使用 Cloudflare Dashboard 部署（最简单）🧩

1. 进入 Cloudflare Dashboard → **Workers & Pages → Create Worker**
2. 将编辑器中的默认代码替换为本项目的 `worker.js`
3. 在该 Worker 的 **Settings → Variables → Secrets** 中添加：
   - `SD_API_KEY`（必需）
   - `GATEWAY_API_KEY`（必需）
   - `ENHANCE_OPENAI_API_KEY`（可选，推荐）
   - `ENHANCE_OPENAI_BASE_URL`（可选，推荐）
   - `ENHANCE_OPENAI_MODEL`（可选，推荐）
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

- 🆕 **Prompt 增强控制**：
  - 在 prompt 末尾添加 `no-enhance` 可跳过 AI 增强，直接使用原始 prompt
  - 示例：`"一只猫在看书 no-enhance"`

- 通过在 **prompt 文本中写比例** 控制分辨率（**需包含"比例"或"ratio"触发词**）：
  - `比例 1:1` 或 `ratio 1:1` → `2048 x 2048`
  - `比例 1:2` 或 `ratio 1:2` → `1024 x 2048`
  - `比例 3:2` 或 `ratio 3:2` → `1920 x 1280`
  - `比例 3:4` 或 `ratio 3:4` → `1536 x 2048`
  - `比例 16:9` 或 `ratio 16:9` → `2048 x 1152`
  - `比例 9:16` 或 `ratio 9:16` → `1152 x 2048`

- 或者直接在 body 里显式传数值字段（优先级最高）：
  - `width`
  - `height`

- 其他参数：
  - `cfg`: 浮点数，不传时默认 `7.0`
  - `seed`: 数值，传了则固定，不传则自动随机
  - `negative_prompt`: 负面提示词（字符串）

#### 📐 分辨率逻辑

Worker 内部对分辨率的处理逻辑为：

1. 如果 body 中显式传了 `width` 和 `height`：**优先直接使用**
2. 否则：从 prompt 文本中尝试识别比例（**严格模式：必须包含"比例"或"ratio"触发词**）
3. 🆕 如果未识别到用户指定比例：让 LLM 根据内容建议最佳比例
4. 如果 LLM 也未建议比例：默认为 `1:1 = 2048 x 2048`

> 💡 小提示：
> - 比例文本会在送给 SD 模型前，从 prompt 中被清理掉，避免影响绘图语义
> - **严格模式示例**：
>   - ✅ `"一只猫，比例 16:9"` → 识别为 16:9
>   - ✅ `"一只猫，ratio 16:9"` → 识别为 16:9
>   - ❌ `"一只猫，16:9"` → 不识别（缺少触发词），交由 LLM 建议
>   - ❌ `"下午16:30的洛杉矶"` → 不会误判为比例 ✅

---

#### 🆕 AI Prompt 增强工作流程

当你发送简单描述时（如"一只猫在看书"），Worker 会：

1. **检测是否跳过增强**：如果 prompt 包含 `no-enhance`，则跳过增强
2. **检测用户指定比例**：如果用户使用了"比例"或"ratio"触发词，则锁定该比例
3. **调用 LLM 增强**：
   - 将简单描述扩展为专业的 Stable Diffusion prompt（30-50 词，英文）
   - 如果用户未指定比例，LLM 会根据内容建议最佳比例
   - 如果用户已指定比例，LLM 不会覆盖
4. **静默降级**：如果 LLM 调用失败，自动使用原始 prompt，不影响生成
5. **保留引号内文本**：如果 prompt 包含引号内的文字（如牌子上的标语），LLM 会保留原语言，不翻译

**增强示例：**

| 原始输入 | 增强后 Prompt | 比例 |
|---------|--------------|------|
| `"一只猫在看书"` | `A fluffy ginger cat wearing tiny round spectacles, intently reading a large ancient leather-bound book in a cozy sunlit library, warm golden hour lighting, soft shadows, studious and peaceful atmosphere` | LLM 建议：`3:2` |
| `"一只猫在看书 no-enhance"` | `一只猫在看书`（不增强） | 默认：`1:1` |
| `"一只猫在看书，比例 16:9"` | `A fluffy orange cat...`（增强，但比例锁定） | 用户指定：`16:9` |
| `"举着'欢迎来到冲绳'的牌子"` | `...holding a welcome sign reading '欢迎来到冲绳'...`（中文保留） | LLM 建议 |

---

#### 🌈 请求示例：默认增强 + LLM 建议比例

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

→ Worker 会调用 LLM 增强 prompt
→ LLM 可能建议比例为 `3:2` 或其他适合的比例
→ 返回内容包含原始输入和增强后的 prompt ✨

#### 📱 请求示例：跳过增强

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" \
  -d '{
    "model": "Z-Image",
    "messages": [
      { "role": "user", "content": "一只可爱的小狗 no-enhance" }
    ]
  }'
```

→ 直接使用原始 prompt：`"一只可爱的小狗"`
→ 默认分辨率：`2048 x 2048`

#### 🎯 请求示例：用户指定比例

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" \
  -d '{
    "model": "Z-Image",
    "messages": [
      { "role": "user", "content": "一只可爱的小狗，比例 9:16" }
    ]
  }'
```

→ Worker 会增强 prompt，但**锁定比例为 9:16**
→ LLM 不会覆盖用户指定的比例
→ 实际分辨率：`1152 x 2048`

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
        "content": "![A fluffy adorable puppy](https://.../image.webp)\n\n---\n**✨ Enhanced Prompt:**\nA fluffy adorable golden retriever puppy with bright eyes, sitting on green grass, soft natural lighting, warm afternoon sun, cheerful and playful expression, shallow depth of field, professional pet photography\n\n**📝 Original Input:**\n一只可爱的小狗\n\n**🎨 Aspect Ratio:** 3:2\n**📐 Resolution:** 1920×1280"
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

- `choices[0].message.content` 包含：
  - 📷 **Markdown 图片**：`![alt](image_url)`
  - ✨ **增强后的 Prompt**：展示 LLM 生成的专业描述
  - 📝 **原始输入**：你发送的原始 prompt
  - 🎨 **使用的比例**
  - 📐 **实际分辨率**

- 在支持 Markdown 渲染的客户端（如 Cherry Studio）中会直接显示图片和详细信息 🖼️
- 用户可以通过查看增强后的 prompt **学习如何写出更好的提示词** 🎓

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
    { role: 'user', content: '一只可爱的小狗' },
  ],
});

// 完整的 Markdown 内容（包含图片和元数据）
const fullContent = res.choices[0].message.content;
console.log(fullContent);

// 如需提取图片 URL
const match = fullContent.match(/!\[.*?\]\((https?:[^)]+)\)/);
const imageUrl = match ? match[1] : null;
console.log('Image URL:', imageUrl);

// 如需提取增强后的 prompt
const enhancedMatch = fullContent.match(/\*\*✨ Enhanced Prompt:\*\*\n(.+?)\n\n/s);
const enhancedPrompt = enhancedMatch ? enhancedMatch[1] : null;
console.log('Enhanced Prompt:', enhancedPrompt);
```

> ✅ 换成你熟悉的语言（Python / Go / Java 等）时，只要支持自定义 `baseURL` 和 `apiKey` 的 OpenAI SDK，使用方式基本相同。

---

## 🎨 Prompt 增强最佳实践

### ✅ 推荐做法

1. **简单描述**：直接写你想要的内容，让 AI 帮你扩展细节
   ```
   "一只猫在看书"
   "日落时的海滩"
   "未来城市"
   ```

2. **指定比例**：使用"比例"或"ratio"关键词
   ```
   "一只猫在看书，比例 16:9"
   "日落时的海滩，ratio 9:16"
   ```

3. **保留文字内容**：用引号包裹需要显示的文字
   ```
   "举着'欢迎来到冲绳'的牌子"
   "T恤上印着'TOKYO 2024'"
   ```

4. **专业用户**：如果你已经有完整的 prompt，使用 `no-enhance` 跳过增强
   ```
   "A stunning portrait of a woman in traditional Japanese kimono... no-enhance"
   ```

### ⚠️ 注意事项

- **比例触发词**：必须包含"比例"或"ratio"才能识别用户指定的比例
  - ✅ `"一只猫，比例 16:9"` → 识别
  - ❌ `"一只猫，16:9"` → 不识别（可能与时间等混淆）

- **引号内文字**：如果需要在图片中显示特定文字，用引号包裹
  - LLM 会保留原语言，不会翻译

- **增强失败**：如果 LLM 服务不可用，会自动降级使用原始 prompt
  - 不影响图片生成，但不会有增强效果

- **成本控制**：每次增强会调用一次 LLM API
  - GPT-4o-mini 成本很低（约 $0.00015/次）
  - 如需节省成本，专业用户可使用 `no-enhance`

---

## 🔄 上游 SD API 约定（当前实现）

Worker 会向你的 SD 上游服务发送类似如下的 JSON 请求：

```json
{
  "prompt": "增强后的英文提示词（或原始 prompt）",
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

- `prompt`：
  - 如果启用增强：LLM 生成的专业英文 prompt
  - 如果跳过增强：用户的原始 prompt
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
- 🆕 **Prompt 增强功能**：
  - 需要配置 `ENHANCE_OPENAI_API_KEY` 才能启用
  - 未配置时会静默降级，直接使用原始 prompt
  - LLM 调用超时设置为 10 秒，超时会自动降级
  - 增强会增加约 0.5-2 秒的延迟（取决于 LLM 响应速度）

**如需扩展，可以考虑：**

- 多模型支持：不同 `model` 名映射到不同 `model_index` 或不同模型权重
- 自定义"质量档位"：通过分辨率 + `steps` 控制画质和速度
- 添加更多参数：如 `sampler`、`style`、`tiling` 等，映射到上游 SD 实现
- 🆕 自定义 System Prompt：调整 LLM 的增强风格和输出格式

---

## 📜 License

MIT License
