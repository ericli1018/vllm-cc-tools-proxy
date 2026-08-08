const SIMPLIFIED_MARKERS = new Set([...('这们为说国会个门体发现经应该问题处理进行实际结果数据还没从对开关请让显认证转换输设备统线网页读写软硬码误简单双过与后里并务项达态类时种点标记历产测试').replace(/\s/g, '')]);
const TRADITIONAL_MARKERS = new Set([...('這們為說國會個門體發現經應該問題處理進行實際結果數據還沒從對開關請讓顯認證轉換輸設備統線網頁讀寫軟硬碼誤簡單雙過與後裡並務項達態類時種點標記歷產測試').replace(/\s/g, '')]);

function proseOnly(value) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:^|\s)(?:\.{0,2}\/|~\/|\/)[^\s]+/g, ' ')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

function counts(value) {
  const prose = proseOnly(value);
  const chars = [...prose];
  const han = chars.filter((char) => /\p{Script=Han}/u.test(char));
  const kana = chars.filter((char) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));
  const hangul = chars.filter((char) => /\p{Script=Hangul}/u.test(char));
  const latin = chars.filter((char) => /\p{Script=Latin}/u.test(char));
  const latinWords = prose.match(/\b[A-Za-z]{2,}\b/g) || [];
  const simplified = han.filter((char) => SIMPLIFIED_MARKERS.has(char)).length;
  const traditional = han.filter((char) => TRADITIONAL_MARKERS.has(char)).length;
  return {
    prose,
    han: han.length,
    kana: kana.length,
    hangul: hangul.length,
    latin: latin.length,
    latinWords: latinWords.length,
    simplified,
    traditional,
  };
}

function strongLatin(c) {
  return c.latin >= 12 && c.latinWords >= 3 && c.latin > (c.han + c.kana + c.hangul) * 2;
}

function strongHan(c) {
  return c.han >= 8 && c.han >= c.latin * 0.15;
}

function variantDominates(c, variantCount, otherCount) {
  return c.han >= 4
    && variantCount >= 2
    && variantCount > otherCount * 1.5;
}

export function classifyFinalLanguage(text, locale = 'en-US') {
  const c = counts(text);
  if (!c.prose || (c.han + c.kana + c.hangul + c.latin) < 4) {
    return { decision: 'uncertain', detected: 'unknown', ...c };
  }

  if (locale === 'zh-TW') {
    if (c.hangul >= 6) return { decision: 'repair', detected: 'ko', ...c };
    if (c.kana >= 6) return { decision: 'repair', detected: 'ja', ...c };
    if (variantDominates(c, c.simplified, c.traditional)) {
      return { decision: 'repair', detected: 'zh-CN', ...c };
    }
    if (strongHan(c)) return { decision: 'compliant', detected: 'zh', ...c };
    if (strongLatin(c)) return { decision: 'repair', detected: 'en', ...c };
    return { decision: 'uncertain', detected: 'mixed', ...c };
  }

  if (locale === 'zh-CN') {
    if (c.hangul >= 6) return { decision: 'repair', detected: 'ko', ...c };
    if (c.kana >= 6) return { decision: 'repair', detected: 'ja', ...c };
    if (variantDominates(c, c.traditional, c.simplified)) {
      return { decision: 'repair', detected: 'zh-TW', ...c };
    }
    if (strongHan(c)) return { decision: 'compliant', detected: 'zh', ...c };
    if (strongLatin(c)) return { decision: 'repair', detected: 'en', ...c };
    return { decision: 'uncertain', detected: 'mixed', ...c };
  }

  if (locale === 'ja-JP') {
    if (c.kana >= 3 && (c.kana + c.han) >= 8) return { decision: 'compliant', detected: 'ja', ...c };
    if (c.hangul >= 6 || strongLatin(c) || (c.han >= 12 && c.kana === 0)) {
      return { decision: 'repair', detected: c.hangul >= 6 ? 'ko' : strongLatin(c) ? 'en' : 'zh', ...c };
    }
    return { decision: 'uncertain', detected: 'mixed', ...c };
  }

  if (locale === 'ko-KP') {
    if (c.hangul >= 4) return { decision: 'compliant', detected: 'ko', ...c };
    if (c.kana >= 4 || c.han >= 10 || strongLatin(c)) {
      return { decision: 'repair', detected: c.kana >= 4 ? 'ja' : c.han >= 10 ? 'zh' : 'en', ...c };
    }
    return { decision: 'uncertain', detected: 'mixed', ...c };
  }

  if (strongLatin(c)) return { decision: 'compliant', detected: 'en', ...c };
  if (c.hangul >= 6 || c.kana >= 6 || c.han >= 10) {
    return { decision: 'repair', detected: c.hangul >= 6 ? 'ko' : c.kana >= 6 ? 'ja' : 'zh', ...c };
  }
  return { decision: 'uncertain', detected: 'mixed', ...c };
}

function responseTextEntries(response) {
  if (!Array.isArray(response?.content)) return [];
  return response.content
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim());
}

function validSegments(value, expectedLength) {
  return Array.isArray(value)
    && value.length === expectedLength
    && value.every((segment) => typeof segment === 'string' && segment.trim().length > 0);
}

function errorCode(error) {
  return String(error?.code || error?.cause?.code || error?.name || 'repair_error').slice(0, 120);
}

export async function applyFinalLanguageGate(response, {
  locale = 'en-US',
  rewriteExternal,
  rewriteBase,
  onEvent = async () => {},
} = {}) {
  const content = Array.isArray(response?.content) ? response.content : [];
  if (content.some((block) => block?.type === 'tool_use') || response?.stop_reason === 'tool_use') {
    return { response, action: 'bypass_non_final' };
  }

  const entries = responseTextEntries(response);
  if (entries.length === 0) return { response, action: 'bypass_no_text' };
  const segments = entries.map(({ block }) => block.text);
  const classification = classifyFinalLanguage(segments.join('\n\n'), locale);
  await onEvent('final_language_gate', {
    target: locale,
    detected: classification.detected,
    decision: classification.decision,
  });
  if (classification.decision !== 'repair') {
    return { response, action: classification.decision === 'compliant' ? 'pass' : 'pass_uncertain', classification };
  }

  const attempt = async (backend, rewrite) => {
    if (typeof rewrite !== 'function') return null;
    await onEvent('final_language_repair_started', { backend, target: locale, segment_count: segments.length });
    const startedAt = Date.now();
    try {
      const rewritten = await rewrite(segments, locale);
      if (!validSegments(rewritten, segments.length)) {
        throw Object.assign(new Error('Language repair returned invalid segments.'), { code: 'invalid_segments' });
      }
      const clone = structuredClone(response);
      entries.forEach(({ index }, segmentIndex) => { clone.content[index].text = rewritten[segmentIndex]; });
      await onEvent('final_language_repair_completed', {
        backend, target: locale, segment_count: segments.length, elapsed_ms: Date.now() - startedAt,
      });
      return { response: clone, action: 'rewritten', backend, classification };
    } catch (error) {
      await onEvent('final_language_repair_failed', {
        backend,
        target: locale,
        code: errorCode(error),
        fallback: backend === 'external' && typeof rewriteBase === 'function' ? 'base' : 'original',
        elapsed_ms: Date.now() - startedAt,
      });
      return null;
    }
  };

  const external = await attempt('external', rewriteExternal);
  if (external) return external;
  const base = await attempt('base', rewriteBase);
  if (base) return base;
  await onEvent('final_language_repair_bypassed', {
    target: locale,
    reason: 'all_repair_backends_failed',
    delivery: 'original_response',
  });
  return { response, action: 'fallback_original', classification };
}
