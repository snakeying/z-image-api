// worker.js

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

// 提取 OpenAI 风格 body 中的 prompt
function extractPrompt(body) {
  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return body.prompt.trim();
  }

  if (Array.isArray(body.messages)) {
    const userMessages = body.messages.filter((m) => m.role === 'user');
    const lastUser = userMessages[userMessages.length - 1];
    if (lastUser) {
      const content = lastUser.content;

      if (typeof content === 'string') {
        return content;
      }

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

// 对外调用方鉴权（使用 GATEWAY_API_KEY）
function authorize(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const prefix = 'Bearer ';

  if (!auth.startsWith(prefix)) {
    return jsonResponse({ error: 'Unauthorized: missing Bearer token' }, 401);
  }

  const token = auth.slice(prefix.length).trim();

  if (env.GATEWAY_API_KEY && token === env.GATEWAY_API_KEY) {
    return null;
  }

  return jsonResponse({ error: 'Unauthorized: invalid API key' }, 401);
}

// /v1/models 返回 Z-Image 模型
function modelsResponse() {
  const now = Math.floor(Date.now() / 1000);
  return jsonResponse({
    object: 'list',
    data: [
      {
        id: 'Z-Image',
        object: 'model',
        created: now,
        owned_by: 'sd-exacg-gateway',
      },
    ],
  });
}

// 比例 -> 分辨率映射（最长边 2048，64 的倍数）
const ASPECT_RATIO_MAP = {
  '1:1': { width: 2048, height: 2048 },
  '1:2': { width: 1024, height: 2048 },
  '3:2': { width: 1920, height: 1280 },
  '3:4': { width: 1536, height: 2048 },
  '16:9': { width: 2048, height: 1152 },
  '9:16': { width: 1152, height: 2048 },
};

function detectAspectFromPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  
  // 只有包含触发词时才检测比例
  if (!/(?:比例|ratio)/i.test(prompt)) return null;
  
  const normalized = prompt.replace(/：/g, ':');
  const ratios = Object.keys(ASPECT_RATIO_MAP);

  for (const r of ratios) {
    if (normalized.includes(r)) {
      return r;
    }
  }
  return null;
}

// 从 prompt 中去掉比例文本
function stripAspectFromPrompt(prompt, ratio) {
  if (!prompt || !ratio) return prompt;
  const normalized = prompt.replace(/：/g, ':');
  const pattern = new RegExp(`\\s*[，,。]?\\s*${ratio}\\s*`);
  return normalized.replace(pattern, ' ').replace(/\s+/g, ' ').trim();
}

// 决定最终 width/height
function resolveSize(body, ratio) {
  if (typeof body.width === 'number' && typeof body.height === 'number') {
    // 对齐到 8 的倍数
    const w = Math.min(2048, Math.max(64, Math.round(body.width / 8) * 8));
    const h = Math.min(2048, Math.max(64, Math.round(body.height / 8) * 8));
    return { width: w, height: h };
  }

  if (ratio && ASPECT_RATIO_MAP[ratio]) {
    return ASPECT_RATIO_MAP[ratio];
  }

  return ASPECT_RATIO_MAP['1:1']; // 默认 1:1 = 2048x2048
}

async function handleChatCompletions(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const model = body.model || 'Z-Image';
  if (model !== 'Z-Image') {
    return jsonResponse(
      { error: `Model not found: ${model}. Use "Z-Image".` },
      404,
    );
  }

  const rawPrompt = extractPrompt(body);
  if (!rawPrompt) {
    return jsonResponse(
      { error: 'prompt is required (in prompt or messages)' },
      400,
    );
  }

  const ratio = detectAspectFromPrompt(rawPrompt);
  const prompt = stripAspectFromPrompt(rawPrompt, ratio);
  const { width, height } = resolveSize(body, ratio);

  const cfg =
    typeof body.cfg === 'number' && Number.isFinite(body.cfg)
      ? body.cfg
      : 7.0;

  const seed = (body.seed != null && Number.isFinite(Number(body.seed)))
    ? Math.floor(Number(body.seed))
    : Math.floor(Math.random() * 2_147_483_647);

  const negativePrompt =
    typeof body.negative_prompt === 'string' ? body.negative_prompt : undefined;

  const sdPayload = {
    prompt,
    width,
    height,
    steps: 8,
    cfg,
    model_index: 5,
    seed,
    ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
  };

  try {
    const sdRes = await fetch('https://sd.exacg.cc/api/v1/generate_image', {
      method: 'POST',
      headers: {
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
      model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: markdownImage,
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

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const authError = authorize(request, env);
    if (authError) return authError;

    if (url.pathname === '/v1/models' && request.method === 'GET') {
      return modelsResponse();
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
};
