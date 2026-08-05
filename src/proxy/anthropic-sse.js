import { writeChunk } from '../lib/http.js';
import { formatSseEvent } from './progress.js';

async function emitTextBlock(res, index, block) {
  await writeChunk(res, formatSseEvent('content_block_start', {
    type: 'content_block_start', index, content_block: { type: 'text', text: '' },
  }));
  if (block.text) {
    await writeChunk(res, formatSseEvent('content_block_delta', {
      type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text },
    }));
  }
  await writeChunk(res, formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}

async function emitThinkingBlock(res, index, block) {
  await writeChunk(res, formatSseEvent('content_block_start', {
    type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: block.signature || '' },
  }));
  if (block.thinking) {
    await writeChunk(res, formatSseEvent('content_block_delta', {
      type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking },
    }));
  }
  await writeChunk(res, formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}

async function emitToolUseBlock(res, index, block) {
  await writeChunk(res, formatSseEvent('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
  }));
  const input = JSON.stringify(block.input ?? {});
  await writeChunk(res, formatSseEvent('content_block_delta', {
    type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: input },
  }));
  await writeChunk(res, formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
}

export async function emitFinalAnthropicResponse(progress, response) {
  await progress.closeProgress('處理完成；正在回傳模型結果…');
  let index = progress.visible ? 1 : 0;
  for (const block of response.content || []) {
    if (block.type === 'text') await emitTextBlock(progress.res, index, block);
    else if (block.type === 'thinking') await emitThinkingBlock(progress.res, index, block);
    else if (block.type === 'tool_use') await emitToolUseBlock(progress.res, index, block);
    else {
      await writeChunk(progress.res, formatSseEvent('content_block_start', {
        type: 'content_block_start', index, content_block: block,
      }));
      await writeChunk(progress.res, formatSseEvent('content_block_stop', { type: 'content_block_stop', index }));
    }
    index += 1;
  }
  await writeChunk(progress.res, formatSseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: response.stop_reason ?? 'end_turn',
      stop_sequence: response.stop_sequence ?? null,
    },
    usage: {
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  }));
  await writeChunk(progress.res, formatSseEvent('message_stop', { type: 'message_stop' }));
  progress.res.end();
  await progress.stop();
}

export async function emitSseError(progress, error) {
  try {
    await progress.closeProgress();
    await writeChunk(progress.res, formatSseEvent('error', {
      type: 'error',
      error: {
        type: error.code || 'internal_error',
        message: error.message || 'Internal proxy error.',
        retryable: Boolean(error.retryable),
      },
    }));
    progress.res.end();
  } finally {
    await progress.stop();
  }
}

function parseSseBlock(block) {
  let name = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { name, data: data.join('\n') };
}

function shiftEventIndex(payload, offset) {
  if (!offset || !payload || typeof payload !== 'object') return payload;
  if (['content_block_start', 'content_block_delta', 'content_block_stop'].includes(payload.type)
      && Number.isInteger(payload.index)) {
    return { ...payload, index: payload.index + offset };
  }
  return payload;
}

export async function pipeAnthropicUpstreamStream(progress, upstream) {
  await progress.closeProgress('文件與圖片處理完成；正在串流主模型結果…');
  const offset = progress.visible ? 1 : 0;
  await progress.stop();
  if (!upstream.body) {
    progress.res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const processBlock = async (block) => {
    if (!block.trim()) return;
    const parsed = parseSseBlock(block);
    if (parsed.name === 'message_start') return;
    let data = parsed.data;
    if (data) {
      try { data = JSON.stringify(shiftEventIndex(JSON.parse(data), offset)); } catch {}
    }
    await writeChunk(progress.res, `${parsed.name ? `event: ${parsed.name}\n` : ''}${data ? `data: ${data}\n` : ''}\n`);
  };

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      await processBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await processBlock(buffer);
  progress.res.end();
}
