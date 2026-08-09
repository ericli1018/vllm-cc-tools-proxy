const ROUTES = new Set(['TEXT', 'DIAGRAM', 'SCHEMATIC', 'DENSE_PAGE']);

const CLASSIFIER_PROMPT = `Classify this PDF page for routing only. Return exactly three plain-text lines:\nROUTE: TEXT|DIAGRAM|SCHEMATIC|DENSE_PAGE\nCONFIDENCE: 0.0-1.0\nREASON: short observable reason\n\nDefinitions:\nTEXT = predominantly prose/table/code that does not require visual connectivity.\nDIAGRAM = flow chart, block diagram, timing/power/clock diagram, pinout, chart, or other visual relationship that is readable as a whole page.\nSCHEMATIC = dense electronic schematic/wiring/connectivity drawing where small labels, pins, nets, or wires require systematic region coverage.\nDENSE_PAGE = mixed/uncertain/high-density technical content where dropping visual evidence would be unsafe.\nDo not answer the document task. Do not request crops.`;

export function parsePageClassification(markdown) {
  const text = String(markdown || '');
  const routeMatch = text.match(/^\s*ROUTE\s*:\s*([A-Z_]+)\s*$/im);
  const confidenceMatch = text.match(/^\s*CONFIDENCE\s*:\s*([0-9.]+)\s*$/im);
  const reasonMatch = text.match(/^\s*REASON\s*:\s*(.+?)\s*$/im);
  const route = routeMatch && ROUTES.has(routeMatch[1]) ? routeMatch[1] : 'DENSE_PAGE';
  const parsedConfidence = Number(confidenceMatch?.[1]);
  const confidence = Number.isFinite(parsedConfidence) ? Math.max(0, Math.min(1, parsedConfidence)) : 0;
  return {
    route,
    confidence,
    reason: String(reasonMatch?.[1] || (route === 'DENSE_PAGE' ? 'classification unavailable or unsupported' : '')).slice(0, 240),
  };
}

export async function classifyPdfPage(asset, {
  analyzeVisualAssets,
  ...visionOptions
} = {}) {
  if (typeof analyzeVisualAssets !== 'function') throw new TypeError('analyzeVisualAssets is required.');
  try {
    const result = await analyzeVisualAssets([asset], {
      ...visionOptions,
      allowCrops: false,
      prompt: CLASSIFIER_PROMPT,
    });
    return parsePageClassification(result?.markdown);
  } catch (error) {
    return { route: 'DENSE_PAGE', confidence: 0, reason: `classification_failed:${error?.code || error?.name || 'error'}` };
  }
}
