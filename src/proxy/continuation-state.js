import { neutralizeControlTags } from './protocol-sanitizer.js';

export const CONTINUATION_SMALL_MAX_CHARS = 24_000;
export const CONTINUATION_LARGE_MIN_CHARS = 96_001;
export const CONTINUATION_WINDOW_CHARS = 24_000;
export const CONTINUATION_OVERLAP_CHARS = 4_000;
export const CONTINUATION_MEDIUM_HEAD_CHARS = 8_000;
export const CONTINUATION_MEDIUM_TAIL_CHARS = 16_000;
export const CONTINUATION_LARGE_RECENT_TAIL_CHARS = 12_000;
export const CONTINUATION_COMPRESSED_HISTORY_MAX_CHARS = 20_000;

const CATEGORY_ORDER = Object.freeze([
  ['working_assumptions', 'Working assumptions'],
  ['decisions_considered', 'Decisions considered'],
  ['rejected_options', 'Rejected options'],
  ['unresolved_items', 'Unresolved items'],
  ['intended_next_actions', 'Intended next actions'],
]);

function blockText(block) {
  if (block?.type === 'thinking' && typeof block.thinking === 'string') return block.thinking.trim();
  if (block?.type === 'text' && typeof block.text === 'string') return block.text.trim();
  return '';
}

export function extractModelWorkingState(response) {
  const content = Array.isArray(response?.content) ? response.content : [];
  return content.map(blockText).filter(Boolean).join('\n\n').trim();
}

export function sanitizeModelWorkingState(value) {
  return neutralizeControlTags(String(value ?? '')).trim();
}

function deterministicHeadTail(candidate) {
  if (candidate.length <= CONTINUATION_MEDIUM_HEAD_CHARS + CONTINUATION_MEDIUM_TAIL_CHARS) return candidate;
  const head = candidate.slice(0, CONTINUATION_MEDIUM_HEAD_CHARS);
  const tail = candidate.slice(-CONTINUATION_MEDIUM_TAIL_CHARS);
  return `${head}\n\n[earlier model working state omitted]\n\n${tail}`;
}

function largeWindows(candidate) {
  const windows = [];
  const stride = CONTINUATION_WINDOW_CHARS - CONTINUATION_OVERLAP_CHARS;
  for (let contextStart = 0, index = 1; contextStart < candidate.length; contextStart += stride, index += 1) {
    const contextEnd = Math.min(candidate.length, contextStart + CONTINUATION_WINDOW_CHARS);
    windows.push({
      index,
      contextStart,
      contextEnd,
      text: candidate.slice(contextStart, contextEnd),
    });
    if (contextEnd >= candidate.length) break;
  }
  return windows;
}

export function planContinuationState(value) {
  const candidate = sanitizeModelWorkingState(value);
  const candidateChars = candidate.length;
  if (candidateChars <= CONTINUATION_SMALL_MAX_CHARS) {
    return { mode: 'small', candidate, candidateChars, windows: [], fallbackText: candidate };
  }
  if (candidateChars < CONTINUATION_LARGE_MIN_CHARS) {
    return {
      mode: 'medium', candidate, candidateChars, windows: [], fallbackText: deterministicHeadTail(candidate),
    };
  }
  return {
    mode: 'large',
    candidate,
    candidateChars,
    windows: largeWindows(candidate),
    fallbackText: deterministicHeadTail(candidate),
    recentTail: candidate.slice(-CONTINUATION_LARGE_RECENT_TAIL_CHARS),
  };
}

function normalizeIdentity(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function cleanDisplay(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function mergeCompressedContinuationState(outputs, recentTail = '') {
  const seen = new Set();
  let deduplicatedItems = 0;
  const sections = [];

  for (const [key, label] of CATEGORY_ORDER) {
    const values = [];
    for (const output of Array.isArray(outputs) ? outputs : []) {
      for (const raw of Array.isArray(output?.[key]) ? output[key] : []) {
        const display = cleanDisplay(raw);
        const identity = normalizeIdentity(raw);
        if (!display || !identity) continue;
        if (seen.has(identity)) {
          deduplicatedItems += 1;
          continue;
        }
        seen.add(identity);
        values.push(display);
      }
    }
    if (values.length > 0) sections.push(`${label}:\n${values.map((item) => `- ${item}`).join('\n')}`);
  }

  let compressed = sections.join('\n\n');
  if (compressed.length > CONTINUATION_COMPRESSED_HISTORY_MAX_CHARS) {
    compressed = `${compressed.slice(0, CONTINUATION_COMPRESSED_HISTORY_MAX_CHARS)}\n[compressed working state truncated]`;
  }
  const tail = sanitizeModelWorkingState(recentTail).slice(-CONTINUATION_LARGE_RECENT_TAIL_CHARS);
  const text = [
    compressed ? `Compressed historical model working state:\n${compressed}` : '(no structured historical state retained)',
    tail ? `Recent raw model working state:\n${tail}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    text,
    deduplicatedItems,
    compressedChars: compressed.length,
    recentTailChars: tail.length,
    handoffChars: text.length,
  };
}

export async function prepareContinuationState(response, {
  compressWindow,
  signal,
  onEvent = async () => {},
} = {}) {
  const raw = extractModelWorkingState(response);
  const plan = planContinuationState(raw);
  await onEvent('managed_continuation_state_preparation_started', {
    candidate_chars: plan.candidateChars,
    mode: plan.mode,
    chunk_count: plan.windows.length,
  });

  if (plan.mode !== 'large' || typeof compressWindow !== 'function') {
    const fallbackReason = plan.mode === 'large' ? 'processor_unavailable' : null;
    const result = {
      text: plan.fallbackText,
      mode: plan.mode,
      candidateChars: plan.candidateChars,
      handoffChars: plan.fallbackText.length,
      compressed: false,
      chunkCount: plan.windows.length,
      recentTailChars: plan.mode === 'large' ? plan.recentTail.length : 0,
      fallbackReason,
    };
    await onEvent('managed_continuation_state_preserved', {
      candidate_chars: result.candidateChars,
      mode: result.mode,
      handoff_chars: result.handoffChars,
      compressed: false,
      chunk_count: result.chunkCount,
      recent_tail_chars: result.recentTailChars,
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
    });
    return result;
  }

  const outputs = [];
  for (const window of plan.windows) {
    await onEvent('managed_continuation_compression_chunk_started', {
      chunk: window.index,
      chunk_count: plan.windows.length,
      context_start: window.contextStart,
      context_end: window.contextEnd,
    });
    try {
      const output = await compressWindow(window, { signal });
      outputs.push(output);
      await onEvent('managed_continuation_compression_chunk_completed', {
        chunk: window.index,
        chunk_count: plan.windows.length,
        context_start: window.contextStart,
        context_end: window.contextEnd,
      });
    } catch (error) {
      const code = String(error?.code || error?.cause?.code || 'continuation_compression_error').slice(0, 120);
      await onEvent('managed_continuation_compression_failed', {
        chunk: window.index,
        chunk_count: plan.windows.length,
        code,
        fallback: 'deterministic_head_tail',
      });
      const fallback = {
        text: plan.fallbackText,
        mode: 'large',
        candidateChars: plan.candidateChars,
        handoffChars: plan.fallbackText.length,
        compressed: false,
        chunkCount: plan.windows.length,
        recentTailChars: plan.recentTail.length,
        fallbackReason: code,
      };
      await onEvent('managed_continuation_state_preserved', {
        candidate_chars: fallback.candidateChars,
        mode: fallback.mode,
        handoff_chars: fallback.handoffChars,
        compressed: false,
        chunk_count: fallback.chunkCount,
        recent_tail_chars: fallback.recentTailChars,
        fallback_reason: code,
      });
      return fallback;
    }
  }

  const merged = mergeCompressedContinuationState(outputs, plan.recentTail);
  const result = {
    text: merged.text,
    mode: 'large',
    candidateChars: plan.candidateChars,
    handoffChars: merged.handoffChars,
    compressed: true,
    chunkCount: plan.windows.length,
    recentTailChars: merged.recentTailChars,
    compressedChars: merged.compressedChars,
    deduplicatedItems: merged.deduplicatedItems,
    fallbackReason: null,
  };
  await onEvent('managed_continuation_state_preserved', {
    candidate_chars: result.candidateChars,
    mode: result.mode,
    handoff_chars: result.handoffChars,
    compressed: true,
    chunk_count: result.chunkCount,
    compressed_chars: result.compressedChars,
    recent_tail_chars: result.recentTailChars,
    deduplicated_items: result.deduplicatedItems,
  });
  return result;
}
