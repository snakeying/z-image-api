// CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

// 从 OpenAI 风格 body 中抽取 prompt
function extractPrompt(body) {
  // 1) 兼容直接传 prompt 字段
  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return body.prompt.trim();
  }

  // 2) OpenAI Chat 格式：messages 数组中最后一个 user 消息
  if (Array.isArray(body.messages)) {
    const userMessages = body.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    if (lastUser) {
      const content = lastUser.content;

      // 旧版：content 是字符串
      if (typeof content === 'string') {
        return content;
      }

      // 新版：content 是数组 [{ type: 'text', text: '...' }, ...]
      if (Array.isArray(content)) {
        return content
          .map((part) => {
            if (typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
            return '';
          })
          .join(' ')
          .trim();
      }
    }
  }

  return null;
}

// 对外调用方鉴权（网关层 API key）
function authorize(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const prefix = 'Bearer ';

  if (!auth.startsWith(prefix)) {
    return jsonResponse({ error: 'Unauthorized: missing Bearer token' }, 401);
  }

  const token = auth.slice(prefix.length).trim();

  // 简单版：单一 key
  if (env.GATEWAY_API_KEY && token === env.GATEWAY_API_KEY) {
    return null; // 鉴权通过
  }

  // 如果需要多 key，可以改成 env.GATEWAY_API_KEYS 逗号分隔，这里先保持简单
  return jsonResponse({ error: 'Unauthorized: invalid API key' }, 401);
}

// /v1/models 响应：只暴露 Z-Image 这个模型
function modelsResponse() {
  const now = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: 'list',
    data: [
      {
        id: 'Z-Image',              // 自定义的模型名
        object: 'model',
        created: now,
        owned_by: 'sd-exacg-gateway',
      },
    ],
  });
}

// 核心：处理 /v1/chat/completions
async function handleChatCompletions(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // 模型名处理：默认 Z-Image，并且只允许 Z-Image
  const model = body.model || 'Z-Image';
  if (model !== 'Z-Image') {
    return jsonResponse(
      { error: `Model not found: ${model}. Use "Z-Image".` },
      404,
    );
  }

  const prompt = extractPrompt(body);
  if (!prompt) {
    return jsonResponse(
      { error: 'prompt is required (in prompt or messages)' },
      400,
    );
  }

  // 参数：宽高、cfg，可以从 body 读取，也可以让用户不传时使用默认
  const width = typeof body.width === 'number' ? body.width : 1024;
  const height = typeof body.height === 'number' ? body.height : 1024;
  const cfg = typeof body.cfg === 'number' ? body.cfg : 7.0;

  // 强制随机 seed（除非用户明确传了 seed）
  let seed;
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    const parsed = Number(body.seed);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      seed = Math.floor(parsed);
    }
  }
  if (typeof seed !== 'number') {
    seed = Math.floor(Math.random() * 2_147_483_647); // 31-bit 正整数随机 seed
  }

  // 可选：支持 negative_prompt
  const negativePrompt =
    typeof body.negative_prompt === 'string' ? body.negative_prompt : undefined;

  // 组装发往 sd.exacg.cc 的请求体
  const sdPayload = {
    prompt,
    width,
    height,
    steps: 8,       // Z-Image固定为 8
    cfg,
    model_index: 5, // Z-Image 对应的模型 index
    seed,
    ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
  };

  try {
    const sdRes = await fetch('https://sd.exacg.cc/api/v1/generate_image', {
      method: 'POST',
      headers: {
        // 对内使用真实的 SD API key（在 Worker 环境变量里配置）
        'Authorization': `Bearer ${env.SD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sdPayload),
    });

    const sdJson = await sdRes.json().catch(() => null);

    if (!sdRes.ok || !sdJson || sdJson.success !== true) {
      return jsonResponse(
        {
          error:
            (sdJson && (sdJson.error || sdJson.message)) ||
            `Image generation failed with status ${sdRes.status}`,
        },
        502,
      );
    }

    const imageUrl = sdJson.data?.image_url;
    const now = Math.floor(Date.now() / 1000);
    const altText = prompt.slice(0, 80) || 'Z-Image result';
    const markdownImage = `![${altText}](${imageUrl})`;

    const resp = {
      id:
        'chatcmpl-' +
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : String(now)),
      object: 'chat.completion',
      created: now,
      model, // Z-Image
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: markdownImage, // ★ 这里现在是 Markdown
          },
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };


    return jsonResponse(resp, 200);
  } catch (e) {
    return jsonResponse(
      { error: 'Internal error: ' + (e && e.message ? e.message : String(e)) },
      500,
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 预检，不做鉴权
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 所有正式请求先鉴权（对外网关 key）
    const authError = authorize(request, env);
    if (authError) return authError;

    // 列出模型
    if (url.pathname === '/v1/models' && request.method === 'GET') {
      return modelsResponse();
    }

    // OpenAI Chat Completions 兼容入口
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
