const REPAIR_PROMPTS = Object.freeze({
  'zh-TW': Object.freeze({
    system: '你是只負責語言轉換的文字處理器。',
    instruction: '將各段自然語言轉為繁體中文（zh-TW）。保持原意、資訊量與 Markdown 結構；程式碼、命令、路徑、URL、數值與識別字保持不變。不得新增、刪除、摘要、解釋或重新回答內容。所有段落標記必須原樣保留，只輸出轉換後的標記段落。',
  }),
  'zh-CN': Object.freeze({
    system: '你是只负责语言转换的文字处理器。',
    instruction: '将各段自然语言转换为简体中文（zh-CN）。保持原意、信息量与 Markdown 结构；代码、命令、路径、URL、数值与标识符保持不变。不得新增、删除、摘要、解释或重新回答内容。所有段落标记必须原样保留，只输出转换后的标记段落。',
  }),
  'en-US': Object.freeze({
    system: 'You are a language-only text rewriting processor.',
    instruction: 'Convert the natural-language prose in each segment to English (en-US). Preserve meaning, information, Markdown structure, code, commands, paths, URLs, numbers, and identifiers. Do not add, remove, summarize, explain, or answer the content. Preserve every segment marker exactly and output only the converted marked segments.',
  }),
  'ja-JP': Object.freeze({
    system: 'あなたは言語変換だけを行うテキスト処理器です。',
    instruction: '各セグメントの自然言語を日本語（ja-JP）に変換してください。意味、情報量、Markdown 構造、コード、コマンド、パス、URL、数値、識別子は保持してください。内容の追加、削除、要約、説明、再回答は禁止です。すべてのセグメントマーカーを完全に保持し、変換後のマーカー付きセグメントだけを出力してください。',
  }),
  'ko-KP': Object.freeze({
    system: '당신은 언어 변환만 수행하는 텍스트 처리기입니다.',
    instruction: '각 세그먼트의 자연어를 한국어(ko-KP)로 변환하십시오. 의미, 정보량, Markdown 구조, 코드, 명령, 경로, URL, 숫자 및 식별자는 그대로 유지하십시오. 내용을 추가, 삭제, 요약, 설명하거나 다시 답변하지 마십시오. 모든 세그먼트 마커를 정확히 유지하고 변환된 마커 세그먼트만 출력하십시오.',
  }),
});


function isGlmModel(model) {
  return /(^|[\/:._-])glm(?:[\d._-]|$)/i.test(String(model || ''));
}

function noThinkSystemPrompt(system, { provider, model, think }) {
  if (think || provider !== 'ollama' || !isGlmModel(model)) return system;
  return /^\s*\/nothink\b/i.test(String(system || '')) ? system : `/nothink\n${system}`;
}

function prompt(locale) {
  return REPAIR_PROMPTS[locale] || REPAIR_PROMPTS['en-US'];
}

function segmentStart(index) {
  return `<<<VCC_LANG_SEGMENT_${index}>>>`;
}

function segmentEnd(index) {
  return `<<<VCC_LANG_SEGMENT_END_${index}>>>`;
}

export function encodeLanguageRepairSegments(segments, locale = 'en-US') {
  const p = prompt(locale);
  const body = segments.map((segment, index) => `${segmentStart(index)}\n${String(segment)}\n${segmentEnd(index)}`).join('\n');
  return `${p.instruction}\n\n${body}`;
}

export function parseLanguageRepairSegments(value, expectedCount) {
  const text = String(value ?? '').trim();
  const segments = [];
  for (let index = 0; index < expectedCount; index += 1) {
    const start = segmentStart(index);
    const end = segmentEnd(index);
    const startAt = text.indexOf(start);
    const endAt = startAt >= 0 ? text.indexOf(end, startAt + start.length) : -1;
    if (startAt < 0 || endAt < 0) {
      throw Object.assign(new Error('Language repair did not preserve the segment contract.'), { code: 'invalid_segments' });
    }
    const segment = text.slice(startAt + start.length, endAt).replace(/^\s*\n?/, '').replace(/\n?\s*$/, '');
    if (!segment) throw Object.assign(new Error('Language repair returned an empty segment.'), { code: 'empty_segment' });
    segments.push(segment);
  }
  const markerCount = (text.match(/<<<VCC_LANG_SEGMENT_\d+>>>/g) || []).length;
  const endMarkerCount = (text.match(/<<<VCC_LANG_SEGMENT_END_\d+>>>/g) || []).length;
  if (markerCount !== expectedCount || endMarkerCount !== expectedCount) {
    throw Object.assign(new Error('Language repair returned unexpected segment markers.'), { code: 'invalid_segments' });
  }
  return segments;
}

function openAiMessageContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function repairErrorCode(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'AbortError') return 'aborted';
  return String(error?.code || error?.cause?.code || 'language_repair_error').slice(0, 120);
}

export async function rewriteFinalSegmentsWithExternalProcessor(segments, {
  locale = 'en-US',
  processor = {},
  signal,
  onEvent = async () => {},
  acquireProcessor,
} = {}) {
  if (!processor.enabled || !processor.url || !processor.model) {
    throw Object.assign(new Error('External language processor is unavailable.'), { code: 'language_processor_unavailable' });
  }
  const endpoint = new URL(processor.url);
  const headers = { 'content-type': 'application/json' };
  if (processor.apiKey) headers.authorization = `Bearer ${processor.apiKey}`;
  const provider = processor.provider || 'vllm';
  const p = prompt(locale);
  const body = {
    model: processor.model,
    stream: false,
    temperature: 0.1,
    max_tokens: Math.max(512, Math.min(32768, segments.join('\n').length * 2)),
    messages: [
      { role: 'system', content: noThinkSystemPrompt(p.system, { provider, model: processor.model, think: Boolean(processor.think) }) },
      { role: 'user', content: encodeLanguageRepairSegments(segments, locale) },
    ],
  };
  if (provider === 'ollama') body.reasoning_effort = processor.think ? 'high' : 'none';
  else body.chat_template_kwargs = { enable_thinking: Boolean(processor.think), preserve_thinking: false };

  const release = acquireProcessor ? await acquireProcessor({ signal }) : () => {};
  const startedAt = Date.now();
  await onEvent('final_language_processor_request', {
    backend_host: endpoint.host,
    endpoint_path: endpoint.pathname || '/',
    provider,
    model: processor.model,
    segment_count: segments.length,
    think: Boolean(processor.think),
  });
  try {
    const timeoutSignal = AbortSignal.timeout(processor.timeoutMs || 300000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(processor.url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: combinedSignal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch {
      throw Object.assign(new Error('External language processor returned invalid JSON.'), { code: 'invalid_json' });
    }
    if (!response.ok) {
      throw Object.assign(new Error(payload?.error?.message || 'External language processor rejected the request.'), { code: `http_${response.status}` });
    }
    const message = payload?.choices?.[0]?.message || {};
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      throw Object.assign(new Error('External language processor attempted a tool call.'), { code: 'tool_call' });
    }
    const output = openAiMessageContent(message).trim();
    const rewritten = parseLanguageRepairSegments(output, segments.length);
    await onEvent('final_language_processor_response', {
      backend_host: endpoint.host,
      provider,
      model: processor.model,
      http_status: response.status,
      elapsed_ms: Date.now() - startedAt,
      segment_count: rewritten.length,
    });
    return rewritten;
  } catch (error) {
    if (signal?.aborted) throw error;
    error.code = error.code || repairErrorCode(error);
    throw error;
  } finally {
    release();
  }
}

export function buildBaseLanguageRepairRequest(segments, {
  locale = 'en-US', model = '', maxTokens = 4096,
} = {}) {
  const p = prompt(locale);
  return {
    model,
    stream: false,
    max_tokens: maxTokens,
    temperature: 0.1,
    system: p.system,
    messages: [{ role: 'user', content: encodeLanguageRepairSegments(segments, locale) }],
    chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
  };
}

export function extractLanguageRepairSegmentsFromAnthropic(response, expectedCount) {
  const content = Array.isArray(response?.content) ? response.content : [];
  if (content.some((block) => block?.type === 'tool_use')) {
    throw Object.assign(new Error('Base language repair attempted a tool call.'), { code: 'tool_call' });
  }
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) throw Object.assign(new Error('Base language repair returned no visible text.'), { code: 'empty_content' });
  return parseLanguageRepairSegments(text, expectedCount);
}
