import { languageProfile } from '../i18n/response-language.js';

function systemContainsInstruction(system, instruction) {
  if (typeof system === 'string') return system.includes(instruction);
  if (!Array.isArray(system)) return false;
  return system.some((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.includes(instruction));
}

function stripTailFromString(content, tail) {
  if (typeof content !== 'string' || !tail) return content;
  if (content === tail) return '';
  const suffix = `\n\n${tail}`;
  return content.endsWith(suffix) ? content.slice(0, -suffix.length) : content;
}

function stripTailFromContent(content, tail) {
  if (typeof content === 'string') return stripTailFromString(content, tail);
  if (!Array.isArray(content)) return content;
  return content.filter((block) => !(
    block?.type === 'text'
    && typeof block.text === 'string'
    && (block.text === tail || block.text === `\n\n${tail}`)
  ));
}

export function injectResponseLanguageTail(request, locale) {
  const clone = structuredClone(request || {});
  const tail = languageProfile(locale).modelTailInstruction;
  if (!tail || !Array.isArray(clone.messages)) return { request: clone, changed: false };

  let changed = false;
  let lastUserIndex = -1;
  for (let index = 0; index < clone.messages.length; index += 1) {
    const message = clone.messages[index];
    if (message?.role !== 'user') continue;
    lastUserIndex = index;
    const stripped = stripTailFromContent(message.content, tail);
    if (JSON.stringify(stripped) !== JSON.stringify(message.content)) {
      message.content = stripped;
      changed = true;
    }
  }

  if (lastUserIndex < 0) return { request: clone, changed };
  const target = clone.messages[lastUserIndex];
  if (typeof target.content === 'string') {
    target.content = target.content.length > 0 ? `${target.content}\n\n${tail}` : tail;
  } else if (Array.isArray(target.content)) {
    target.content = [...target.content, { type: 'text', text: tail }];
  } else {
    target.content = [{ type: 'text', text: tail }];
  }
  return { request: clone, changed: true };
}

export function injectResponseLanguagePolicy(request, locale) {
  let clone = structuredClone(request || {});
  const instruction = languageProfile(locale).modelInstruction;
  let changed = false;

  if (!systemContainsInstruction(clone.system, instruction)) {
    if (Array.isArray(clone.system)) {
      clone.system = [...clone.system, { type: 'text', text: `\n\n${instruction}` }];
    } else if (typeof clone.system === 'string' && clone.system.length > 0) {
      clone.system = `${clone.system}\n\n${instruction}`;
    } else {
      clone.system = instruction;
    }
    changed = true;
  }

  const tailed = injectResponseLanguageTail(clone, locale);
  clone = tailed.request;
  return { request: clone, changed: changed || tailed.changed };
}
