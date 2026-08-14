export function selectBaseModel(clientModel, baseModel) {
  const configured = String(baseModel || '').trim();
  if (configured) return { model: configured, source: 'vllm_base_model' };
  return { model: String(clientModel || ''), source: 'client_model' };
}

export function rewriteBaseRequest(request, baseModel) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const selected = selectBaseModel(request.model, baseModel);
  if (!String(baseModel || '').trim()) return request;
  return { ...request, model: selected.model };
}

export function rewriteBaseJsonBody(rawBody, baseModel) {
  if (!String(baseModel || '').trim() || !rawBody?.length) return rawBody;
  let parsed;
  try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { return rawBody; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rawBody;
  return Buffer.from(JSON.stringify(rewriteBaseRequest(parsed, baseModel)));
}
