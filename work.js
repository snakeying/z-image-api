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

  // 只有包含触发词时才检测比例（严格模式）
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
  // 移除比例相关的文本（包括触发词）
  const pattern = new RegExp(`\\s*[，,。]?\\s*(?:比例|ratio)?\\s*${ratio}\\s*`, 'gi');
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

// 构建 System Prompt（动态生成）
function buildSystemPrompt(userHasRatio, userSpecifiedRatio) {
  const aspectRatioGuidelines = userHasRatio
    ? `- The user explicitly specified aspect ratio: ${userSpecifiedRatio}. Return "aspect_ratio": null in your response.`
    : `- Suggest the optimal aspect_ratio based on content:
  • 1:1 (square, general purpose)
  • 16:9 (landscape, wide scenes)
  • 9:16 (portrait, vertical subjects)
  • 3:2 (photography, balanced)
  • 3:4 (portrait orientation)
  • 1:2 (tall vertical composition)`;

  const exampleAspectRatio = userHasRatio ? 'null' : '"3:2"';

  return `You are an expert Stable Diffusion prompt engineer. Transform simple user ideas into rich, detailed English prompts optimized for text-to-image generation.

**Your Task:**
1. Analyze the user's core intent, theme, mood, and atmosphere
2. Expand creatively with these elements:
   - Artistic style/medium (photography, oil painting, anime, cinematic, etc.)
   - Subject details and actions
   - Scene and environment
   - Lighting and color palette
   - Composition and perspective
   - Atmosphere and emotional tone
   - Key visual details

3. Generate a vivid, specific English prompt (30-50 words)

**Aspect Ratio Guidelines:**
${aspectRatioGuidelines}

**Output Format (JSON only, no extra text):**
{
  "prompt": "<enhanced English prompt>",
  "aspect_ratio": ${userHasRatio ? 'null' : '"<one of: 1:1, 16:9, 9:16, 3:2, 3:4, 1:2>"'}
}

**Example:**
Input: "一只猫在看书"
Output:
{
  "prompt": "A fluffy ginger cat wearing tiny round spectacles, intently reading a large ancient leather-bound book in a cozy sunlit library, warm golden hour lighting, soft shadows, studious and peaceful atmosphere",
  "aspect_ratio": ${exampleAspectRatio}
}

**Critical Rules:**
- Always output in English, regardless of input language
- Focus on visual details, not abstract concepts
- Keep prompts concise but information-dense (30-50 words)
- Respond ONLY with valid JSON, no markdown code blocks, no extra text
- Do NOT include ratio keywords (16:9, 1:1, etc.) in the prompt field
- Do NOT include dimension-related words (比例, ratio, aspect) in the prompt field
- **IMPORTANT: If the input contains text that should appear on objects (signs, clothing, banners, etc.), preserve the EXACT original text in quotes. Do NOT translate text content on physical objects.**`;
}

// 调用 LLM 增强 prompt
async function enhancePromptWithLLM(prompt, userHasRatio, userSpecifiedRatio, env) {
  const apiKey = env.ENHANCE_OPENAI_API_KEY;
  const baseURL = env.ENHANCE_OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = env.ENHANCE_OPENAI_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    return {
      success: false,
      error: 'ENHANCE_OPENAI_API_KEY not configured',
    };
  }

  const systemPrompt = buildSystemPrompt(userHasRatio, userSpecifiedRatio);

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(10000), // 10s 超时
    });

    if (!response.ok) {
      return {
        success: false,
        error: `LLM API returned ${response.status}`,
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return {
        success: false,
        error: 'No content in LLM response',
      };
    }

    // 清理可能的 markdown 代码块
    const cleaned = content.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.prompt || typeof parsed.prompt !== 'string') {
      return {
        success: false,
        error: 'Invalid JSON structure from LLM',
      };
    }

    return {
      success: true,
      prompt: parsed.prompt,
      aspect_ratio: parsed.aspect_ratio || null,
    };
  } catch (e) {
    return {
      success: false,
      error: e.message || 'LLM enhancement failed',
    };
  }
}

// 构建响应内容（Markdown 格式）
function buildResponseContent(
  imageUrl,
  enhancementUsed,
  enhancementFailed,
  originalPrompt,
  finalPrompt,
  ratio,
  width,
  height
) {
  const altText = finalPrompt.slice(0, 80) || 'Generated image';
  let content = `![${altText}](${imageUrl})\n\n---\n`;

  if (enhancementUsed) {
    content += `**✨ Enhanced Prompt:**\n${finalPrompt}\n\n`;
    content += `**📝 Original Input:**\n${originalPrompt}\n\n`;
  } else if (enhancementFailed) {
    content += `**⚠️ Enhancement failed, using original prompt**\n\n`;
    content += `**📝 Prompt:**\n${originalPrompt}\n\n`;
  } else {
    content += `**📝 Prompt:**\n${originalPrompt}\n\n`;
  }

  content += `**🎨 Aspect Ratio:** ${ratio || 'Custom'}\n`;
  content += `**📐 Resolution:** ${width}×${height}`;

  return content;
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

  // 1. 检查是否跳过增强
  const shouldEnhance = !/no-enhance/i.test(rawPrompt);
  const cleanedPrompt = rawPrompt.replace(/\s*no-enhance\s*/gi, '').trim();

  // 2. 检查用户是否明确指定比例（严格模式：需要触发词）
  const userSpecifiedRatio = detectAspectFromPrompt(cleanedPrompt);

  let finalPrompt = cleanedPrompt;
  let llmSuggestedRatio = null;
  let enhancementUsed = false;
  let enhancementFailed = false;

  // 3. 如果需要增强，调用 LLM
  if (shouldEnhance) {
    const llmResult = await enhancePromptWithLLM(
      cleanedPrompt,
      userSpecifiedRatio !== null,
      userSpecifiedRatio,
      env
    );

    if (llmResult.success) {
      finalPrompt = llmResult.prompt;
      llmSuggestedRatio = llmResult.aspect_ratio;
      enhancementUsed = true;
    } else {
      // 静默降级：使用原始 prompt
      enhancementFailed = true;
      console.error('LLM enhancement failed:', llmResult.error);
    }
  }

  // 4. 决定最终比例（优先级）
  let finalRatio;
  if (userSpecifiedRatio) {
    // 优先级 1: 用户明确指定（有触发词）
    finalRatio = userSpecifiedRatio;
    finalPrompt = stripAspectFromPrompt(finalPrompt, userSpecifiedRatio);
  } else if (body.width && body.height) {
    // 优先级 2: API 参数
    finalRatio = null;
  } else if (llmSuggestedRatio && ASPECT_RATIO_MAP[llmSuggestedRatio]) {
    // 优先级 3: LLM 建议（验证有效性）
    finalRatio = llmSuggestedRatio;
  } else {
    // 优先级 4: 默认
    finalRatio = '1:1';
  }

  // 5. 计算最终尺寸
  const { width, height } = resolveSize(body, finalRatio);

  const cfg =
    typeof body.cfg === 'number' && Number.isFinite(body.cfg)
      ? body.cfg
      : 7.0;

  const seed =
    body.seed != null && Number.isFinite(Number(body.seed))
      ? Math.floor(Number(body.seed))
      : Math.floor(Math.random() * 2_147_483_647);

  const negativePrompt =
    typeof body.negative_prompt === 'string' ? body.negative_prompt : undefined;

  const sdPayload = {
    prompt: finalPrompt,
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
        Authorization: `Bearer ${env.SD_API_KEY}`,
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

    // 6. 构建响应内容（包含增强信息）
    const responseContent = buildResponseContent(
      imageUrl,
      enhancementUsed,
      enhancementFailed,
      cleanedPrompt,
      finalPrompt,
      finalRatio,
      width,
      height
    );

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
            content: responseContent,
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
