import { countAdaptableMedia } from './content-blocks.js';
import { isManagedToolName } from './web-tools.js';
import { isNativeWebToolDefinition } from './native-web-tools.js';

export function classifyMessagesRequest(request) {
  const mediaCount = countAdaptableMedia(request?.messages);
  const reasons = [];
  if (mediaCount.documents > 0) reasons.push('document_block');
  if (mediaCount.images > 0) reasons.push('image_block');
  if (Array.isArray(request?.tools) && request.tools.some((tool) => isManagedToolName(tool?.name))) {
    reasons.push('managed_web_tool');
  }
  if (Array.isArray(request?.tools) && request.tools.some(isNativeWebToolDefinition)) {
    reasons.push('native_web_tool');
  }
  return { managed: reasons.length > 0, reasons, mediaCount };
}
