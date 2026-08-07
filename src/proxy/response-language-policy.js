import { languageProfile } from '../i18n/response-language.js';

function systemContainsInstruction(system, instruction) {
  if (typeof system === 'string') return system.includes(instruction);
  if (!Array.isArray(system)) return false;
  return system.some((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.includes(instruction));
}

export function injectResponseLanguagePolicy(request, locale) {
  const clone = structuredClone(request || {});
  const instruction = languageProfile(locale).modelInstruction;
  if (systemContainsInstruction(clone.system, instruction)) return { request: clone, changed: false };

  if (Array.isArray(clone.system)) {
    clone.system = [...clone.system, { type: 'text', text: instruction }];
  } else if (typeof clone.system === 'string' && clone.system.length > 0) {
    clone.system = `${clone.system}\n\n${instruction}`;
  } else {
    clone.system = instruction;
  }
  return { request: clone, changed: true };
}
