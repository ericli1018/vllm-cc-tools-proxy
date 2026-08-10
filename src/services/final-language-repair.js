const REPAIR_PROMPTS = Object.freeze({
  'zh-TW': Object.freeze({
    system: '你是只負責語言轉換的文字處理器。',
    instruction: '將下方自然語言內容轉為繁體中文（zh-TW）。保持原意、資訊量與 Markdown 結構；程式碼、命令、路徑、URL、數值與識別字保持不變。不得新增、刪除、摘要、解釋或重新回答內容。只輸出轉換後的內容，不要加入前言、標籤或說明。',
  }),
  'zh-CN': Object.freeze({
    system: '你是只负责语言转换的文字处理器。',
    instruction: '将下方自然语言内容转换为简体中文（zh-CN）。保持原意、信息量与 Markdown 结构；代码、命令、路径、URL、数值与标识符保持不变。不得新增、删除、摘要、解释或重新回答内容。只输出转换后的内容，不要加入前言、标签或说明。',
  }),
  'en-US': Object.freeze({
    system: 'You are a language-only text rewriting processor.',
    instruction: 'Convert the natural-language content below to English (en-US). Preserve meaning, information, Markdown structure, code, commands, paths, URLs, numbers, and identifiers. Do not add, remove, summarize, explain, or answer the content. Output only the converted content with no preface, label, or commentary.',
  }),
  'ja-JP': Object.freeze({
    system: 'あなたは言語変換だけを行うテキスト処理器です。',
    instruction: '下記の自然言語内容を日本語（ja-JP）に変換してください。意味、情報量、Markdown 構造、コード、コマンド、パス、URL、数値、識別子は保持してください。内容の追加、削除、要約、説明、再回答は禁止です。前置き、ラベル、説明を付けず、変換後の内容だけを出力してください。',
  }),
  'ko-KP': Object.freeze({
    system: '당신은 언어 변환만 수행하는 텍스트 처리기입니다.',
    instruction: '아래 자연어 내용을 한국어(ko-KP)로 변환하십시오. 의미, 정보량, Markdown 구조, 코드, 명령, 경로, URL, 숫자 및 식별자는 그대로 유지하십시오. 내용을 추가, 삭제, 요약, 설명하거나 다시 답변하지 마십시오. 서문, 레이블 또는 설명 없이 변환된 내용만 출력하십시오.',
  }),
});

function prompt(locale) {
  return REPAIR_PROMPTS[locale] || REPAIR_PROMPTS['en-US'];
}

function directRepairInput(segment, locale) {
  const p = prompt(locale);
  return `${p.instruction}\n\n${String(segment ?? '')}`;
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

async function rewriteExternalSegment(segment, {
  locale,
  processor,
  signal,
  onEvent,
  segmentIndex,
  segmentCount,
} = {}) {
  const endpoint = new URL(processor.url);
  const headers = { 'content-type': 'application/json' };
  if (processor.apiKey) headers.authorization = `Bearer ${processor.apiKey}`;
  const provider = processor.provider || 'vllm';
  const p = prompt(locale);
  const source = String(segment ?? '');
  const body = {
    model: processor.model,
    stream: false,
    temperature: 0.1,
    max_tokens: Math.max(512, Math.min(32768, source.length * 2)),
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: directRepairInput(source, locale) },
    ],
  };
  if (provider === 'ollama') body.reasoning_effort = processor.think ? 'high' : 'none';
  else body.chat_template_kwargs = { enable_thinking: Boolean(processor.think), preserve_thinking: false };

  const startedAt = Date.now();
  await onEvent('final_language_processor_request', {
    backend_host: endpoint.host,
    endpoint_path: endpoint.pathname || '/',
    provider,
    model: processor.model,
    segment_index: segmentIndex,
    segment_count: segmentCount,
    input_chars: source.length,
    think: Boolean(processor.think),
  });

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
  if (!output) {
    throw Object.assign(new Error('External language processor returned no visible text.'), { code: 'empty_content' });
  }
  await onEvent('final_language_processor_response', {
    backend_host: endpoint.host,
    provider,
    model: processor.model,
    http_status: response.status,
    elapsed_ms: Date.now() - startedAt,
    segment_index: segmentIndex,
    segment_count: segmentCount,
    output_chars: output.length,
  });
  return output;
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
  const sourceSegments = Array.isArray(segments) ? segments.map((segment) => String(segment ?? '')) : [];
  const release = acquireProcessor ? await acquireProcessor({ signal }) : () => {};
  try {
    const rewritten = [];
    for (let index = 0; index < sourceSegments.length; index += 1) {
      rewritten.push(await rewriteExternalSegment(sourceSegments[index], {
        locale,
        processor,
        signal,
        onEvent,
        segmentIndex: index,
        segmentCount: sourceSegments.length,
      }));
    }
    return rewritten;
  } catch (error) {
    if (signal?.aborted) throw error;
    error.code = error.code || repairErrorCode(error);
    throw error;
  } finally {
    release();
  }
}

export function buildBaseLanguageRepairRequest(segment, {
  locale = 'en-US', model = '', maxTokens = 4096,
} = {}) {
  const p = prompt(locale);
  const source = String(segment ?? '');
  return {
    model,
    stream: false,
    max_tokens: maxTokens,
    temperature: 0.1,
    system: p.system,
    messages: [{ role: 'user', content: directRepairInput(source, locale) }],
    chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
  };
}

export function extractLanguageRepairSegmentFromAnthropic(response) {
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
  return text;
}
