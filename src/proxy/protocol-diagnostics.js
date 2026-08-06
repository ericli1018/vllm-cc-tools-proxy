import crypto from 'node:crypto';
import { findControlTags } from './protocol-sanitizer.js';

const TAG_CONTEXT_CHARS = 240;
const EXCERPT_EDGE_CHARS = 600;
const BLOCK_PREVIEW_CHARS = 1200;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function redactDiagnosticText(value) {
  return String(value ?? '')
    .replace(/(https?:\/\/)([^\s/@]+(?::[^\s/@]*)?)@/gi, '$1[REDACTED]@')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*[:=]\s*)[^\s"',;\]}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|sk_|hf_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

function lineAndColumn(text, index) {
  const prefix = text.slice(0, index);
  const lastNewline = prefix.lastIndexOf('\n');
  return {
    line: prefix.split('\n').length,
    column: index - lastNewline,
  };
}

function contentIdentity(text) {
  return {
    content_chars: text.length,
    content_bytes: Buffer.byteLength(text),
    content_sha256: sha256(text),
  };
}

function controlSnippet(text, match, metadata) {
  const start = Math.max(0, match.index - TAG_CONTEXT_CHARS);
  const end = Math.min(text.length, match.index + match.raw.length + TAG_CONTEXT_CHARS);
  return {
    reason: 'control_tag_leak',
    ...metadata,
    tag_name: match.name,
    tag_raw: match.raw,
    char_index: match.index,
    ...lineAndColumn(text, match.index),
    context_start: start,
    context_end: end,
    context_before: redactDiagnosticText(text.slice(start, match.index)),
    context_after: redactDiagnosticText(text.slice(match.index + match.raw.length, end)),
    snippet: `${redactDiagnosticText(text.slice(start, match.index))}${match.raw}${redactDiagnosticText(text.slice(match.index + match.raw.length, end))}`,
    ...contentIdentity(text),
  };
}

function edgeExcerpt(text, metadata) {
  const short = text.length <= EXCERPT_EDGE_CHARS * 2;
  return {
    reason: 'final_answer_in_thinking',
    ...metadata,
    excerpt_head: redactDiagnosticText(short ? text : text.slice(0, EXCERPT_EDGE_CHARS)),
    excerpt_tail: redactDiagnosticText(short ? '' : text.slice(-EXCERPT_EDGE_CHARS)),
    omitted_chars: short ? 0 : text.length - (EXCERPT_EDGE_CHARS * 2),
    ...contentIdentity(text),
  };
}

function blockPreview(block, metadata) {
  const serialized = JSON.stringify(block ?? null);
  return {
    reason: 'missing_visible_text',
    ...metadata,
    block_preview: redactDiagnosticText(serialized.slice(0, BLOCK_PREVIEW_CHARS)),
    preview_truncated: serialized.length > BLOCK_PREVIEW_CHARS,
    ...contentIdentity(serialized),
  };
}

function responseMetadata(response) {
  return {
    response_id: typeof response?.id === 'string' ? response.id : null,
    response_model: typeof response?.model === 'string' ? response.model : null,
    stop_reason: response?.stop_reason ?? null,
  };
}

export function collectResponseAnomalySnippets(response, inspection = {}) {
  const reasons = new Set(Array.isArray(inspection?.reasons) ? inspection.reasons : []);
  const content = Array.isArray(response?.content) ? response.content : [];
  const common = responseMetadata(response);
  const output = [];

  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block = content[blockIndex] || {};
    const blockType = String(block?.type || 'unknown');
    if (reasons.has('control_tag_leak')) {
      visitStrings(block, `content[${blockIndex}]`, (text, path) => {
        const relativePath = path.replace(`content[${blockIndex}].`, '');
        const field = relativePath.split(/[.\[]/, 1)[0] || null;
        for (const match of findControlTags(text)) {
          output.push(controlSnippet(text, match, {
            ...common,
            block_index: blockIndex,
            block_type: blockType,
            field,
            path,
          }));
        }
      });
    }
    if (reasons.has('final_answer_in_thinking')
      && typeof block?.thinking === 'string'
      && block.thinking.trim()) {
      output.push(edgeExcerpt(block.thinking, {
        ...common,
        block_index: blockIndex,
        block_type: blockType,
        field: 'thinking',
        path: `content[${blockIndex}].thinking`,
      }));
    }
    if (reasons.has('missing_visible_text')) {
      output.push(blockPreview(block, {
        ...common,
        block_index: blockIndex,
        block_type: blockType,
        field: null,
      }));
    }
  }

  if (content.length === 0 && reasons.has('missing_visible_text')) {
    output.push(blockPreview(null, {
      ...common,
      block_index: null,
      block_type: 'missing',
      field: null,
    }));
  }
  return output;
}

function visitStrings(value, path, callback, seen = new WeakSet()) {
  if (typeof value === 'string') {
    callback(value, path);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitStrings(item, `${path}[${index}]`, callback, seen));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    visitStrings(item, next, callback, seen);
  }
}

function requestScopeEntries(request) {
  return [
    { scope: 'system', value: request?.system, path: 'system' },
    { scope: 'messages', value: request?.messages, path: 'messages' },
    { scope: 'tools', value: request?.tools, path: 'tools' },
  ];
}

function messageMetadata(request, path) {
  const match = /^messages\[(\d+)\]/.exec(path);
  if (!match) return { message_index: null, role: null };
  const messageIndex = Number.parseInt(match[1], 10);
  return {
    message_index: messageIndex,
    role: typeof request?.messages?.[messageIndex]?.role === 'string'
      ? request.messages[messageIndex].role
      : null,
  };
}

export function collectRequestProtocolSnippets(request) {
  const output = [];
  for (const entry of requestScopeEntries(request)) {
    visitStrings(entry.value, entry.path, (text, path) => {
      for (const match of findControlTags(text)) {
        output.push(controlSnippet(text, match, {
          reason: 'input_protocol_tag',
          scope: entry.scope,
          path,
          ...messageMetadata(request, path),
        }));
      }
    });
  }
  return output;
}
