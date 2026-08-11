export const DEFAULT_RESPONSE_LANGUAGE = 'en-US';
export const SUPPORTED_RESPONSE_LANGUAGES = Object.freeze(['zh-TW', 'zh-CN', 'en-US', 'ja-JP', 'ko-KP']);

const CANONICAL_BY_LOWER = new Map(SUPPORTED_RESPONSE_LANGUAGES.map((locale) => [locale.toLowerCase(), locale]));

export function formatReceivedBytes(value) {
  const bytes = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const rendered = unit === 0 || Number.isInteger(amount)
    ? String(Math.round(amount))
    : amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `${rendered} ${units[unit]}`;
}

function hasReceivedBytes(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}


const MODEL_PHASE_LABELS = Object.freeze({
  'zh-TW': Object.freeze({ waiting: '等待', thinking: '思考', response: '回應', tool: '工具' }),
  'zh-CN': Object.freeze({ waiting: '等待', thinking: '思考', response: '响应', tool: '工具' }),
  'en-US': Object.freeze({ waiting: 'waiting', thinking: 'thinking', response: 'response', tool: 'tool' }),
  'ja-JP': Object.freeze({ waiting: '待機', thinking: '思考', response: '応答', tool: 'ツール' }),
  'ko-KP': Object.freeze({ waiting: '대기', thinking: '사고', response: '응답', tool: '도구' }),
});

function modelPhaseLabel(locale, phase) {
  const labels = MODEL_PHASE_LABELS[locale] || MODEL_PHASE_LABELS[DEFAULT_RESPONSE_LANGUAGE];
  return labels[phase] || labels.waiting;
}

const MODEL_TELEMETRY_LABELS = Object.freeze({
  'zh-TW': Object.freeze({ waiting: '主模型等待輸出', thinking: '主模型思考中', response: '主模型回應中', tool: '主模型建立工具動作', stalled: '主模型資料暫停', noData: '無新資料', total: '總計', startedThinking: '主模型開始思考', startedResponse: '主模型開始回應', startedTool: '主模型建立工具動作' }),
  'zh-CN': Object.freeze({ waiting: '主模型等待输出', thinking: '主模型思考中', response: '主模型响应中', tool: '主模型建立工具动作', stalled: '主模型数据暂停', noData: '无新数据', total: '总计', startedThinking: '主模型开始思考', startedResponse: '主模型开始响应', startedTool: '主模型建立工具动作' }),
  'en-US': Object.freeze({ waiting: 'Main model waiting', thinking: 'Main model thinking', response: 'Main model responding', tool: 'Main model building tool action', stalled: 'Main model stalled', noData: 'no upstream data for', total: 'total', startedThinking: 'Main model started thinking', startedResponse: 'Main model started responding', startedTool: 'Main model is building a tool action' }),
  'ja-JP': Object.freeze({ waiting: 'メインモデル待機中', thinking: 'メインモデル思考中', response: 'メインモデル応答中', tool: 'メインモデルがツール操作を生成中', stalled: 'メインモデルのデータ受信が停止', noData: '新規データなし', total: '合計', startedThinking: 'メインモデルが思考を開始', startedResponse: 'メインモデルが応答を開始', startedTool: 'メインモデルがツール操作を生成中' }),
  'ko-KP': Object.freeze({ waiting: '주 모델 출력 대기', thinking: '주 모델 사고 중', response: '주 모델 응답 중', tool: '주 모델 도구 동작 생성 중', stalled: '주 모델 데이터 정체', noData: '동안 새 데이터 없음', total: '총', startedThinking: '주 모델 사고 시작', startedResponse: '주 모델 응답 시작', startedTool: '주 모델 도구 동작 생성 중' }),
});

const THINKING_PULSE = Object.freeze(['◐', '◓', '◑', '◒']);

function modelTelemetryGlyph(phase, pulseIndex = 0) {
  if (phase === 'thinking') {
    const index = Math.abs(Math.trunc(Number(pulseIndex) || 0)) % THINKING_PULSE.length;
    return THINKING_PULSE[index];
  }
  if (phase === 'response') return '◆';
  if (phase === 'tool') return '◇';
  return '◌';
}

export function formatByteRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) return '';
  return `${formatReceivedBytes(rate)}/s`;
}

function formatModelTelemetry(locale, {
  seconds = 0,
  receivedBytes = 0,
  modelPhase = 'waiting',
  recentBytesPerSecond,
  stalled = false,
  idleSeconds = 0,
  pulseIndex = 0,
} = {}) {
  const resolved = resolveResponseLanguage(locale);
  const labels = MODEL_TELEMETRY_LABELS[resolved] || MODEL_TELEMETRY_LABELS[DEFAULT_RESPONSE_LANGUAGE];
  if (stalled) {
    if (resolved === 'en-US') return `⚠ ${labels.stalled} · ${labels.noData} ${Math.max(0, Math.floor(Number(idleSeconds) || 0))}s · ${labels.total} ${formatReceivedBytes(receivedBytes)}`;
    if (resolved === 'ko-KP') return `⚠ ${labels.stalled} · ${Math.max(0, Math.floor(Number(idleSeconds) || 0))}s ${labels.noData} · ${labels.total} ${formatReceivedBytes(receivedBytes)}`;
    return `⚠ ${labels.stalled} · ${Math.max(0, Math.floor(Number(idleSeconds) || 0))}s ${labels.noData} · ${labels.total} ${formatReceivedBytes(receivedBytes)}`;
  }
  const phase = ['waiting', 'thinking', 'response', 'tool'].includes(modelPhase) ? modelPhase : 'waiting';
  const rate = formatByteRate(recentBytesPerSecond);
  return `${modelTelemetryGlyph(phase, pulseIndex)} ${labels[phase]} · ${Math.max(0, Math.floor(Number(seconds) || 0))}s · ${formatReceivedBytes(receivedBytes)}${rate ? ` · ${rate}` : ''}`;
}

function formatModelPhaseChanged(locale, { modelPhase = 'waiting', receivedBytes = 0 } = {}) {
  const resolved = resolveResponseLanguage(locale);
  const labels = MODEL_TELEMETRY_LABELS[resolved] || MODEL_TELEMETRY_LABELS[DEFAULT_RESPONSE_LANGUAGE];
  const text = modelPhase === 'thinking' ? labels.startedThinking
    : modelPhase === 'response' ? labels.startedResponse
      : modelPhase === 'tool' ? labels.startedTool
        : labels.waiting;
  return `${modelTelemetryGlyph(modelPhase, 0)} ${text} · ${formatReceivedBytes(receivedBytes)}`;
}

function formatCharacterCount(value) {
  const count = Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
  return count.toLocaleString('en-US');
}

const PROFILES = Object.freeze({
  'zh-TW': Object.freeze({
    processorInstruction: 'Write the result in Traditional Chinese (zh-TW).',
    progressHeader: '目前處理進度：',
    status: Object.freeze({
      genericProcessing: () => '正在處理…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `主模型仍在處理本輪請求，已執行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `主模型已開始回傳資料，已執行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelHeartbeat: (values = {}) => formatModelTelemetry('zh-TW', values),
      modelPhaseChanged: (values = {}) => formatModelPhaseChanged('zh-TW', values),
      searchStart: ({ query = '' }) => `正在搜尋：${query}…`,
      searchDone: ({ query = '' }) => `搜尋完成：${query}。`,
      fetchStart: ({ host = '網頁' }) => `正在讀取並整理 ${host}…`,
      fetchDone: ({ host = '網頁' }) => `${host} 內容已就緒。`,
      fetchError: ({ host = '網頁' }) => `${host} 讀取失敗；正在交由主模型改用其他來源。`,
      queueWait: ({ position = 0, seconds = 0 }) => `正在等待主模型執行資源，已排隊 ${seconds} 秒，目前前方有 ${position} 個任務…`,
      queueAdmitted: () => '任務已開始處理…',
      upstreamBusyWait: ({ seconds = 0 } = {}) => seconds > 0 ? `↻ 主模型目前忙碌，已等待 ${seconds} 秒；正在等待可用執行資源…` : '↻ 主模型目前忙碌，正在等待可用執行資源…',
      upstreamBusyRetry: ({ seconds = 0, attempt = 1 } = {}) => `↻ 主模型仍忙碌，已等待 ${seconds} 秒；正在重試第 ${attempt} 次請求…`,
      upstreamBusyAccepted: () => '主模型已取得執行資源，開始處理…',
      modelPlanning: () => '正在請主模型規劃下一步…',
      modelToolResults: () => '主模型正在整理工具結果…',
      finalChannelRecovery: () => '主模型答案通道異常；正在進行一次短格式修正…',
      continuationRecovery: ({ candidateChars = 0 } = {}) => candidateChars > 0
        ? `主模型尚未形成有效下一步；本輪產生 ${formatCharacterCount(candidateChars)} 字元工作狀態，正在整理並保留續接重點…`
        : '主模型尚未形成有效下一步；正在整理並保留本輪工作狀態以進行受控續接…',
      continuationStatePreserved: ({ candidateChars = 0, handoffChars = 0, compressed = false } = {}) => compressed
        ? `已將本輪 ${formatCharacterCount(candidateChars)} 字元工作狀態整理為 ${formatCharacterCount(handoffChars)} 字元續接狀態；正在基於剛才的工作內容接續完成下一步…`
        : `已保留本輪 ${formatCharacterCount(handoffChars)} 字元工作狀態；正在基於剛才的工作內容接續完成下一步…`,
      finalRoundReserved: () => '研究工具預算已停止擴張；保留時間給主模型完成下一步…',
      finalLanguageRepair: () => '◇ 主模型已完成回答；正在轉換為繁體中文…',
      finalLanguageRepairFallbackBase: () => '◇ 外部語言處理未達要求；正在改由主模型完成繁體中文轉換…',
      mediaCacheMiss: () => '正在處理新的文件與圖片內容…',
      mediaReady: () => '文件與圖片內容已就緒；正在交給主模型分析…',
      baseRequestStart: () => '正在將內容送往主模型…',
      baseHeadersReceived: () => '主模型已接受請求，正在準備輸出…',
      handoffSingle: ({ tool = '' }) => `主模型已產生下一步 ${tool}；正在交還 Claude Code 執行…`,
      handoffMultiple: () => '主模型已產生下一步工具；正在交還 Claude Code 執行…',
      finalVisible: () => '主模型已完成本輪回答；正在回傳結果…',
      finalOutput: () => '主模型已完成本輪輸出；正在回傳結果…',
      streamingTool: () => '主模型已開始回傳下一步工具…',
      streamingVisible: () => '主模型已開始回傳本輪回答…',
      streamingThinking: () => '主模型已開始回傳思考內容…',
      streamingOutput: () => '主模型已開始回傳本輪輸出…',
      pdfStart: () => '正在解析 PDF…',
      pdfMetadata: ({ total = 0 }) => `已確認 ${total} 頁；正在抽取原生文字…`,
      pdfVisualPrepare: ({ total = 0 }) => `正在準備 ${total} 頁視覺內容…`,
      pdfVisualPlan: ({ total = 0, batches = 0 }) => `已接收 ${total} 頁 PDF；將分成 ${batches} 批進行視覺分析…`,
      pdfVisualBatch: ({ batch = 0, batches = 0 }) => `正在使用視覺模型分析第 ${batch}/${batches} 批頁面…`,
      pdfVisualProgress: ({ completed = 0, total = 0 }) => `視覺模型已完成 ${completed}/${total} 頁…`,
      pdfComplete: () => 'PDF 內容已完成合併。',
      imageStart: () => '正在準備圖片…',
      imageVision: () => '◇ 正在使用視覺模型分析圖片…',
      imageComplete: () => '圖片分析已完成。',
      visionCropRejected: () => '視覺模型正在重新定位局部區域…',
      visionCrop: ({ count = 0 }) => `視覺模型要求檢視 ${count} 個局部區域…`,
      currentStepWaiting: ({ seconds = 0 }) => `目前處理步驟仍在進行，已等待 ${seconds} 秒…`,
    }),
    media: Object.freeze({
      imageFallback: ({ index }) => `圖片 #${index}`,
      fileSingle: ({ filename }) => `檔案：${filename}`,
      fileMultiple: ({ index, count, filename }) => `檔案 ${index}/${count}：${filename}`,
      segment: ({ index, count }) => `區段 ${index}/${count}`,
      imagePart: ({ index, count }) => `圖片 ${index}/${count}`,
      page: ({ done, total, percent }) => `頁面 ${done}/${total}${percent == null ? '' : `（${percent}%）`}`,
      batch: ({ index, count }) => `批次 ${index}/${count}`,
      status: ({ message }) => `狀態：${message}`,
      progress: ({ done, total }) => `處理進度 ${done}/${total}（100%）`,
      filesProgress: ({ done, total }) => `檔案處理進度：${done}/${total}（100%）`,
      currentTask: () => '目前任務',
      separator: '｜',
    }),
  }),
  'zh-CN': Object.freeze({
    processorInstruction: 'Write the result in Simplified Chinese (zh-CN).',
    progressHeader: '当前处理进度：',
    status: Object.freeze({
      genericProcessing: () => '正在处理…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `主模型仍在处理本轮请求，已执行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `主模型已开始返回数据，已执行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelHeartbeat: (values = {}) => formatModelTelemetry('zh-CN', values),
      modelPhaseChanged: (values = {}) => formatModelPhaseChanged('zh-CN', values),
      searchStart: ({ query = '' }) => `正在搜索：${query}…`,
      searchDone: ({ query = '' }) => `搜索完成：${query}。`,
      fetchStart: ({ host = '网页' }) => `正在读取并整理 ${host}…`,
      fetchDone: ({ host = '网页' }) => `${host} 内容已就绪。`,
      fetchError: ({ host = '网页' }) => `${host} 读取失败；正在交由主模型改用其他来源。`,
      queueWait: ({ position = 0, seconds = 0 }) => `正在等待主模型执行资源，已排队 ${seconds} 秒，目前前方有 ${position} 个任务…`,
      queueAdmitted: () => '任务已开始处理…',
      upstreamBusyWait: ({ seconds = 0 } = {}) => seconds > 0 ? `↻ 主模型目前忙碌，已等待 ${seconds} 秒；正在等待可用执行资源…` : '↻ 主模型目前忙碌，正在等待可用执行资源…',
      upstreamBusyRetry: ({ seconds = 0, attempt = 1 } = {}) => `↻ 主模型仍忙碌，已等待 ${seconds} 秒；正在重试第 ${attempt} 次请求…`,
      upstreamBusyAccepted: () => '主模型已取得执行资源，开始处理…',
      modelPlanning: () => '正在请主模型规划下一步…',
      modelToolResults: () => '主模型正在整理工具结果…',
      finalChannelRecovery: () => '主模型答案通道异常；正在进行一次短格式修正…',
      continuationRecovery: ({ candidateChars = 0 } = {}) => candidateChars > 0
        ? `主模型尚未形成有效下一步；本轮生成 ${formatCharacterCount(candidateChars)} 字符工作状态，正在整理并保持续接重点…`
        : '主模型尚未形成有效下一步；正在整理并保留本轮工作状态以进行受控续接…',
      continuationStatePreserved: ({ candidateChars = 0, handoffChars = 0, compressed = false } = {}) => compressed
        ? `已将本轮 ${formatCharacterCount(candidateChars)} 字符工作状态整理为 ${formatCharacterCount(handoffChars)} 字符续接状态；正在基于刚才的工作内容继续完成下一步…`
        : `已保留本轮 ${formatCharacterCount(handoffChars)} 字符工作状态；正在基于刚才的工作内容继续完成下一步…`,
      finalRoundReserved: () => '研究工具预算已停止扩张；保留时间给主模型完成下一步…',
      finalLanguageRepair: () => '◇ 主模型已完成回答；正在转换为简体中文…',
      finalLanguageRepairFallbackBase: () => '◇ 外部语言处理未达到要求；正在改由主模型完成简体中文转换…',
      mediaCacheMiss: () => '正在处理新的文档与图片内容…',
      mediaReady: () => '文档与图片内容已就绪；正在交给主模型分析…',
      baseRequestStart: () => '正在将内容发送给主模型…',
      baseHeadersReceived: () => '主模型已接受请求，正在准备输出…',
      handoffSingle: ({ tool = '' }) => `主模型已生成下一步 ${tool}；正在交还 Claude Code 执行…`,
      handoffMultiple: () => '主模型已生成下一步工具；正在交还 Claude Code 执行…',
      finalVisible: () => '主模型已完成本轮回答；正在返回结果…',
      finalOutput: () => '主模型已完成本轮输出；正在返回结果…',
      streamingTool: () => '主模型已开始返回下一步工具…',
      streamingVisible: () => '主模型已开始返回本轮回答…',
      streamingThinking: () => '主模型已开始返回思考内容…',
      streamingOutput: () => '主模型已开始返回本轮输出…',
      pdfStart: () => '正在解析 PDF…',
      pdfMetadata: ({ total = 0 }) => `已确认 ${total} 页；正在提取原生文本…`,
      pdfVisualPrepare: ({ total = 0 }) => `正在准备 ${total} 页视觉内容…`,
      pdfVisualPlan: ({ total = 0, batches = 0 }) => `已接收 ${total} 页 PDF；将分成 ${batches} 批进行视觉分析…`,
      pdfVisualBatch: ({ batch = 0, batches = 0 }) => `正在使用视觉模型分析第 ${batch}/${batches} 批页面…`,
      pdfVisualProgress: ({ completed = 0, total = 0 }) => `视觉模型已完成 ${completed}/${total} 页…`,
      pdfComplete: () => 'PDF 内容已完成合并。',
      imageStart: () => '正在准备图片…',
      imageVision: () => '◇ 正在使用视觉模型分析图片…',
      imageComplete: () => '图片分析已完成。',
      visionCropRejected: () => '视觉模型正在重新定位局部区域…',
      visionCrop: ({ count = 0 }) => `视觉模型要求查看 ${count} 个局部区域…`,
      currentStepWaiting: ({ seconds = 0 }) => `当前处理步骤仍在进行，已等待 ${seconds} 秒…`,
    }),
    media: Object.freeze({
      imageFallback: ({ index }) => `图片 #${index}`,
      fileSingle: ({ filename }) => `文件：${filename}`,
      fileMultiple: ({ index, count, filename }) => `文件 ${index}/${count}：${filename}`,
      segment: ({ index, count }) => `区段 ${index}/${count}`,
      imagePart: ({ index, count }) => `图片 ${index}/${count}`,
      page: ({ done, total, percent }) => `页面 ${done}/${total}${percent == null ? '' : `（${percent}%）`}`,
      batch: ({ index, count }) => `批次 ${index}/${count}`,
      status: ({ message }) => `状态：${message}`,
      progress: ({ done, total }) => `处理进度 ${done}/${total}（100%）`,
      filesProgress: ({ done, total }) => `文件处理进度：${done}/${total}（100%）`,
      currentTask: () => '当前任务',
      separator: '｜',
    }),
  }),
  'en-US': Object.freeze({
    processorInstruction: 'Write the result in English (en-US).',
    progressHeader: 'Current progress:',
    status: Object.freeze({
      genericProcessing: () => 'Processing…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `The main model is still processing this request. Running for ${seconds}s${hasReceivedBytes(receivedBytes) ? ` (received ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `The main model has started returning data. Running for ${seconds}s${hasReceivedBytes(receivedBytes) ? ` (received ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      modelHeartbeat: (values = {}) => formatModelTelemetry('en-US', values),
      modelPhaseChanged: (values = {}) => formatModelPhaseChanged('en-US', values),
      searchStart: ({ query = '' }) => `Searching: ${query}…`,
      searchDone: ({ query = '' }) => `Search completed: ${query}.`,
      fetchStart: ({ host = 'web page' }) => `Fetching and processing ${host}…`,
      fetchDone: ({ host = 'web page' }) => `${host} content is ready.`,
      fetchError: ({ host = 'web page' }) => `Failed to fetch ${host}; the main model will use another source.`,
      queueWait: ({ position = 0, seconds = 0 }) => `Waiting for main-model capacity; queued for ${seconds}s with ${position} task(s) ahead…`,
      queueAdmitted: () => 'Task processing started…',
      upstreamBusyWait: ({ seconds = 0 } = {}) => seconds > 0 ? `↻ Main model is busy; waited ${seconds}s for available execution capacity…` : '↻ Main model is busy; waiting for available execution capacity…',
      upstreamBusyRetry: ({ seconds = 0, attempt = 1 } = {}) => `↻ Main model is still busy after ${seconds}s; starting attempt ${attempt}…`,
      upstreamBusyAccepted: () => 'Main model accepted the request and is starting processing…',
      modelPlanning: () => 'The main model is planning the next step…',
      modelToolResults: () => 'The main model is processing tool results…',
      finalChannelRecovery: () => 'The main model response channel is malformed; applying one short format repair…',
      continuationRecovery: ({ candidateChars = 0 } = {}) => candidateChars > 0
        ? `The main model did not form a valid next step; organizing and preserving ${formatCharacterCount(candidateChars)} characters of this round’s model working state…`
        : 'The main model did not form a valid next step; preserving this round’s model working state for one controlled continuation…',
      continuationStatePreserved: ({ candidateChars = 0, handoffChars = 0, compressed = false } = {}) => compressed
        ? `Compacted ${formatCharacterCount(candidateChars)} characters of this round’s model working state into ${formatCharacterCount(handoffChars)} continuation-state characters; continuing from that work…`
        : `Preserved ${formatCharacterCount(handoffChars)} characters of this round’s model working state; continuing from that work…`,
      finalRoundReserved: () => 'Research tool expansion stopped; reserving time for the main model to finish the next step…',
      finalLanguageRepair: () => '◇ The main model finished the answer; converting it to English…',
      finalLanguageRepairFallbackBase: () => '◇ The external language processor did not meet the output contract; switching to the main model for English conversion…',
      mediaCacheMiss: () => 'Processing new document and image content…',
      mediaReady: () => 'Document and image content is ready; handing it to the main model for analysis…',
      baseRequestStart: () => 'Sending content to the main model…',
      baseHeadersReceived: () => 'The main model accepted the request and is preparing output…',
      handoffSingle: ({ tool = '' }) => `The main model produced the next ${tool} action; handing control back to Claude Code…`,
      handoffMultiple: () => 'The main model produced the next tool actions; handing control back to Claude Code…',
      finalVisible: () => 'The main model completed this response; returning the result…',
      finalOutput: () => 'The main model completed this output; returning the result…',
      streamingTool: () => 'The main model started returning the next tool action…',
      streamingVisible: () => 'The main model started returning this response…',
      streamingThinking: () => 'The main model started returning thinking content…',
      streamingOutput: () => 'The main model started returning this output…',
      pdfStart: () => 'Parsing PDF…',
      pdfMetadata: ({ total = 0 }) => `Confirmed ${total} page(s); extracting native text…`,
      pdfVisualPrepare: ({ total = 0 }) => `Preparing visual content for ${total} page(s)…`,
      pdfVisualPlan: ({ total = 0, batches = 0 }) => `Received ${total} PDF page(s); visual analysis will run in ${batches} batch(es)…`,
      pdfVisualBatch: ({ batch = 0, batches = 0 }) => `Analyzing visual batch ${batch}/${batches}…`,
      pdfVisualProgress: ({ completed = 0, total = 0 }) => `Visual model completed ${completed}/${total} page(s)…`,
      pdfComplete: () => 'PDF content merge completed.',
      imageStart: () => 'Preparing image…',
      imageVision: () => '◇ Analyzing image with the visual model…',
      imageComplete: () => 'Image analysis completed.',
      visionCropRejected: () => 'The visual model is repositioning the local region…',
      visionCrop: ({ count = 0 }) => `The visual model requested ${count} local crop(s)…`,
      currentStepWaiting: ({ seconds = 0 }) => `The current processing step is still running. Waiting for ${seconds}s…`,
    }),
    media: Object.freeze({
      imageFallback: ({ index }) => `Image #${index}`,
      fileSingle: ({ filename }) => `File: ${filename}`,
      fileMultiple: ({ index, count, filename }) => `File ${index}/${count}: ${filename}`,
      segment: ({ index, count }) => `Segment ${index}/${count}`,
      imagePart: ({ index, count }) => `Image ${index}/${count}`,
      page: ({ done, total, percent }) => `Page ${done}/${total}${percent == null ? '' : ` (${percent}%)`}`,
      batch: ({ index, count }) => `Batch ${index}/${count}`,
      status: ({ message }) => `Status: ${message}`,
      progress: ({ done, total }) => `Progress ${done}/${total} (100%)`,
      filesProgress: ({ done, total }) => `File progress: ${done}/${total} (100%)`,
      currentTask: () => 'Current task',
      separator: ' | ',
    }),
  }),
  'ja-JP': Object.freeze({
    processorInstruction: 'Write the result in Japanese (ja-JP).',
    progressHeader: '現在の処理状況：',
    status: Object.freeze({
      genericProcessing: () => '処理中…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `メインモデルがこのリクエストを処理中です。実行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（受信 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `メインモデルがデータを返し始めました。実行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（受信 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelHeartbeat: (values = {}) => formatModelTelemetry('ja-JP', values),
      modelPhaseChanged: (values = {}) => formatModelPhaseChanged('ja-JP', values),
      searchStart: ({ query = '' }) => `検索中：${query}…`,
      searchDone: ({ query = '' }) => `検索完了：${query}。`,
      fetchStart: ({ host = 'Webページ' }) => `${host} を取得して処理しています…`,
      fetchDone: ({ host = 'Webページ' }) => `${host} の内容を取得しました。`,
      fetchError: ({ host = 'Webページ' }) => `${host} の取得に失敗しました。メインモデルが別の情報源を使用します。`,
      queueWait: ({ position = 0, seconds = 0 }) => `メインモデルの実行枠を待機中です。${seconds} 秒待機、前に ${position} 件あります…`,
      queueAdmitted: () => 'タスクの処理を開始しました…',
      upstreamBusyWait: ({ seconds = 0 } = {}) => seconds > 0 ? `↻ メインモデルが混雑中です。${seconds} 秒待機し、実行枠を待っています…` : '↻ メインモデルが混雑中です。利用可能な実行枠を待っています…',
      upstreamBusyRetry: ({ seconds = 0, attempt = 1 } = {}) => `↻ メインモデルはまだ混雑中です。${seconds} 秒待機後、第 ${attempt} 回を再試行します…`,
      upstreamBusyAccepted: () => 'メインモデルが要求を受理し、処理を開始しました…',
      modelPlanning: () => 'メインモデルが次の手順を計画しています…',
      modelToolResults: () => 'メインモデルがツールの結果を処理しています…',
      finalChannelRecovery: () => 'メインモデルの応答チャネルに異常があります。短い形式修正を1回実行します…',
      continuationRecovery: ({ candidateChars = 0 } = {}) => candidateChars > 0
        ? `メインモデルが有効な次の手順を形成できませんでした。このラウンドの作業状態 ${formatCharacterCount(candidateChars)} 文字を整理・保持しています…`
        : 'メインモデルが有効な次の手順を形成できませんでした。このラウンドの作業状態を保持して継続処理を準備しています…',
      continuationStatePreserved: ({ candidateChars = 0, handoffChars = 0, compressed = false } = {}) => compressed
        ? `このラウンドの作業状態 ${formatCharacterCount(candidateChars)} 文字を ${formatCharacterCount(handoffChars)} 文字の継続状態に整理しました。直前の作業を引き継いで続行します…`
        : `このラウンドの作業状態 ${formatCharacterCount(handoffChars)} 文字を保持しました。直前の作業を引き継いで続行します…`,
      finalRoundReserved: () => '調査ツールの拡張を停止し、メインモデルが次の手順を完了する時間を確保します…',
      finalLanguageRepair: () => '◇ メインモデルの回答が完了しました。日本語に変換しています…',
      finalLanguageRepairFallbackBase: () => '◇ 外部言語処理が要件を満たさなかったため、メインモデルで日本語変換を続行しています…',
      mediaCacheMiss: () => '新しい文書と画像の内容を処理しています…',
      mediaReady: () => '文書と画像の内容を準備しました。メインモデルに渡して分析します…',
      baseRequestStart: () => '内容をメインモデルに送信しています…',
      baseHeadersReceived: () => 'メインモデルがリクエストを受け付け、出力を準備しています…',
      handoffSingle: ({ tool = '' }) => `メインモデルが次の操作として ${tool} を生成しました。Claude Code に制御を戻しています…`,
      handoffMultiple: () => 'メインモデルが次のツール操作を生成しました。Claude Code に制御を戻しています…',
      finalVisible: () => 'メインモデルの応答が完了しました。結果を返しています…',
      finalOutput: () => 'メインモデルの出力が完了しました。結果を返しています…',
      streamingTool: () => 'メインモデルが次のツール操作の返却を開始しました…',
      streamingVisible: () => 'メインモデルが応答の返却を開始しました…',
      streamingThinking: () => 'メインモデルが思考内容の返却を開始しました…',
      streamingOutput: () => 'メインモデルが出力の返却を開始しました…',
      pdfStart: () => 'PDF を解析しています…',
      pdfMetadata: ({ total = 0 }) => `${total} ページを確認しました。ネイティブテキストを抽出しています…`,
      pdfVisualPrepare: ({ total = 0 }) => `${total} ページの視覚内容を準備しています…`,
      pdfVisualPlan: ({ total = 0, batches = 0 }) => `${total} ページの PDF を受信しました。${batches} バッチで視覚分析します…`,
      pdfVisualBatch: ({ batch = 0, batches = 0 }) => `視覚モデルでバッチ ${batch}/${batches} を分析しています…`,
      pdfVisualProgress: ({ completed = 0, total = 0 }) => `視覚モデルが ${completed}/${total} ページを完了しました…`,
      pdfComplete: () => 'PDF 内容の統合が完了しました。',
      imageStart: () => '画像を準備しています…',
      imageVision: () => '◇ 視覚モデルで画像を分析しています…',
      imageComplete: () => '画像分析が完了しました。',
      visionCropRejected: () => '視覚モデルが局所領域を再調整しています…',
      visionCrop: ({ count = 0 }) => `視覚モデルが ${count} 個の局所領域の確認を要求しました…`,
      currentStepWaiting: ({ seconds = 0 }) => `現在の処理手順は継続中です。${seconds}秒経過しました…`,
    }),
    media: Object.freeze({
      imageFallback: ({ index }) => `画像 #${index}`,
      fileSingle: ({ filename }) => `ファイル：${filename}`,
      fileMultiple: ({ index, count, filename }) => `ファイル ${index}/${count}：${filename}`,
      segment: ({ index, count }) => `区間 ${index}/${count}`,
      imagePart: ({ index, count }) => `画像 ${index}/${count}`,
      page: ({ done, total, percent }) => `ページ ${done}/${total}${percent == null ? '' : `（${percent}%）`}`,
      batch: ({ index, count }) => `バッチ ${index}/${count}`,
      status: ({ message }) => `状態：${message}`,
      progress: ({ done, total }) => `処理進捗 ${done}/${total}（100%）`,
      filesProgress: ({ done, total }) => `ファイル処理進捗：${done}/${total}（100%）`,
      currentTask: () => '現在のタスク',
      separator: '｜',
    }),
  }),
  'ko-KP': Object.freeze({
    processorInstruction: 'Write the result in Korean (ko-KP).',
    progressHeader: '현재 처리 상태:',
    status: Object.freeze({
      genericProcessing: () => '처리 중…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `주 모델이 이 요청을 처리하고 있습니다. ${seconds}초 실행${hasReceivedBytes(receivedBytes) ? ` (수신 ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `주 모델이 데이터를 반환하기 시작했습니다. ${seconds}초 실행${hasReceivedBytes(receivedBytes) ? ` (수신 ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      modelHeartbeat: (values = {}) => formatModelTelemetry('ko-KP', values),
      modelPhaseChanged: (values = {}) => formatModelPhaseChanged('ko-KP', values),
      searchStart: ({ query = '' }) => `검색 중: ${query}…`,
      searchDone: ({ query = '' }) => `검색 완료: ${query}.`,
      fetchStart: ({ host = '웹 페이지' }) => `${host}의 내용을 가져와 처리하고 있습니다…`,
      fetchDone: ({ host = '웹 페이지' }) => `${host}의 내용이 준비되었습니다.`,
      fetchError: ({ host = '웹 페이지' }) => `${host} 가져오기에 실패했습니다. 주 모델이 다른 자료원을 사용합니다.`,
      queueWait: ({ position = 0, seconds = 0 }) => `주 모델 실행 자원을 기다리고 있습니다. ${seconds}초 대기, 앞에 ${position}개 작업이 있습니다…`,
      queueAdmitted: () => '작업 처리를 시작했습니다…',
      upstreamBusyWait: ({ seconds = 0 } = {}) => seconds > 0 ? `↻ 주 모델이 혼잡합니다. ${seconds}초 기다렸으며 실행 자원을 기다리는 중입니다…` : '↻ 주 모델이 혼잡합니다. 사용 가능한 실행 자원을 기다리는 중입니다…',
      upstreamBusyRetry: ({ seconds = 0, attempt = 1 } = {}) => `↻ 주 모델이 여전히 혼잡합니다. ${seconds}초 대기 후 ${attempt}번째 시도를 진행합니다…`,
      upstreamBusyAccepted: () => '주 모델이 요청을 수락하여 처리를 시작합니다…',
      modelPlanning: () => '주 모델이 다음 단계를 계획하고 있습니다…',
      modelToolResults: () => '주 모델이 도구 실행 결과를 처리하고 있습니다…',
      finalChannelRecovery: () => '주 모델 응답 채널에 이상이 있습니다. 짧은 형식 수정을 한 번 수행합니다…',
      continuationRecovery: ({ candidateChars = 0 } = {}) => candidateChars > 0
        ? `주 모델이 유효한 다음 단계를 만들지 못했습니다. 이번 라운드의 모델 작업 상태 ${formatCharacterCount(candidateChars)}자를 정리하고 보존하고 있습니다…`
        : '주 모델이 유효한 다음 단계를 만들지 못했습니다. 이번 라운드의 모델 작업 상태를 보존해 제한된 이어쓰기를 준비합니다…',
      continuationStatePreserved: ({ candidateChars = 0, handoffChars = 0, compressed = false } = {}) => compressed
        ? `이번 라운드의 모델 작업 상태 ${formatCharacterCount(candidateChars)}자를 ${formatCharacterCount(handoffChars)}자의 이어쓰기 상태로 정리했습니다. 방금 작업을 이어서 계속합니다…`
        : `이번 라운드의 모델 작업 상태 ${formatCharacterCount(handoffChars)}자를 보존했습니다. 방금 작업을 이어서 계속합니다…`,
      finalRoundReserved: () => '조사 도구 확장을 중단하고 주 모델이 다음 단계를 완료할 시간을 확보합니다…',
      finalLanguageRepair: () => '◇ 주 모델 답변이 완료되었습니다. 한국어로 변환하고 있습니다…',
      finalLanguageRepairFallbackBase: () => '◇ 외부 언어 처리 결과가 요구 사항을 충족하지 않아 주 모델로 한국어 변환을 계속합니다…',
      mediaCacheMiss: () => '새 문서와 그림 내용을 처리하고 있습니다…',
      mediaReady: () => '문서와 그림 내용이 준비되었습니다. 주 모델에 넘겨 분석합니다…',
      baseRequestStart: () => '내용을 주 모델에 보내고 있습니다…',
      baseHeadersReceived: () => '주 모델이 요청을 받았으며 출력을 준비하고 있습니다…',
      handoffSingle: ({ tool = '' }) => `주 모델이 다음 단계로 ${tool}을 선택했습니다. Claude Code에 실행을 넘깁니다…`,
      handoffMultiple: () => '주 모델이 다음 도구 단계를 생성했습니다. Claude Code에 실행을 넘깁니다…',
      finalVisible: () => '주 모델의 응답이 완료되었습니다. 결과를 반환합니다…',
      finalOutput: () => '주 모델의 출력이 완료되었습니다. 결과를 반환합니다…',
      streamingTool: () => '주 모델이 다음 도구 단계의 반환을 시작했습니다…',
      streamingVisible: () => '주 모델이 응답 반환을 시작했습니다…',
      streamingThinking: () => '주 모델이 사고 내용 반환을 시작했습니다…',
      streamingOutput: () => '주 모델이 출력 반환을 시작했습니다…',
      pdfStart: () => 'PDF를 해석하고 있습니다…',
      pdfMetadata: ({ total = 0 }) => `${total}쪽을 확인했습니다. 원문 글자를 추출하고 있습니다…`,
      pdfVisualPrepare: ({ total = 0 }) => `${total}쪽의 시각 내용을 준비하고 있습니다…`,
      pdfVisualPlan: ({ total = 0, batches = 0 }) => `${total}쪽 PDF를 받았습니다. ${batches}개 묶음으로 시각 분석합니다…`,
      pdfVisualBatch: ({ batch = 0, batches = 0 }) => `시각 모델로 ${batch}/${batches} 묶음을 분석하고 있습니다…`,
      pdfVisualProgress: ({ completed = 0, total = 0 }) => `시각 모델이 ${completed}/${total}쪽을 완료했습니다…`,
      pdfComplete: () => 'PDF 내용 병합이 완료되었습니다.',
      imageStart: () => '그림을 준비하고 있습니다…',
      imageVision: () => '◇ 시각 모델로 그림을 분석하고 있습니다…',
      imageComplete: () => '그림 분석이 완료되었습니다.',
      visionCropRejected: () => '시각 모델이 국부 영역을 다시 맞추고 있습니다…',
      visionCrop: ({ count = 0 }) => `시각 모델이 ${count}개 국부 영역 확인을 요청했습니다…`,
      currentStepWaiting: ({ seconds = 0 }) => `현재 처리 단계가 계속 진행 중입니다. ${seconds}초 경과…`,
    }),
    media: Object.freeze({
      imageFallback: ({ index }) => `그림 #${index}`,
      fileSingle: ({ filename }) => `파일: ${filename}`,
      fileMultiple: ({ index, count, filename }) => `파일 ${index}/${count}: ${filename}`,
      segment: ({ index, count }) => `구간 ${index}/${count}`,
      imagePart: ({ index, count }) => `그림 ${index}/${count}`,
      page: ({ done, total, percent }) => `쪽 ${done}/${total}${percent == null ? '' : ` (${percent}%)`}`,
      batch: ({ index, count }) => `묶음 ${index}/${count}`,
      status: ({ message }) => `상태: ${message}`,
      progress: ({ done, total }) => `처리 진척 ${done}/${total} (100%)`,
      filesProgress: ({ done, total }) => `파일 처리 진척: ${done}/${total} (100%)`,
      currentTask: () => '현재 작업',
      separator: ' | ',
    }),
  }),
});

export function resolveResponseLanguage(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) return DEFAULT_RESPONSE_LANGUAGE;
  return CANONICAL_BY_LOWER.get(candidate.toLowerCase()) || DEFAULT_RESPONSE_LANGUAGE;
}

export function languageProfile(locale) {
  return PROFILES[resolveResponseLanguage(locale)];
}

export function statusText(locale, key, values = {}) {
  const profile = languageProfile(locale);
  const renderer = profile.status[key];
  return typeof renderer === 'function' ? renderer(values) : profile.status.genericProcessing(values);
}

export function mediaText(locale, key, values = {}) {
  const profile = languageProfile(locale);
  const renderer = profile.media[key];
  if (typeof renderer === 'function') return renderer(values);
  if (typeof renderer === 'string') return renderer;
  return '';
}

export function progressBlockHeader(locale) {
  return languageProfile(resolveResponseLanguage(locale)).progressHeader;
}

export function allProgressBlockHeaders() {
  return SUPPORTED_RESPONSE_LANGUAGES.map((locale) => PROFILES[locale].progressHeader);
}

export function localizeProgressMessage(locale, fallbackMessage, details = {}) {
  const phase = String(details.phase || '');
  const values = {
    seconds: details.seconds,
    position: details.position,
    total: details.total ?? details.received_pdf_pages,
    completed: details.completed ?? details.processed_pdf_pages,
    batches: details.batches ?? details.visual_batch_count,
    batch: details.batch,
    count: details.count,
    attempt: details.attempt,
  };
  const phaseToKey = {
    media_cache_miss: 'mediaCacheMiss',
    queue_admitted: 'queueAdmitted',
    upstream_busy_wait: 'upstreamBusyWait',
    upstream_busy_retry: 'upstreamBusyRetry',
    upstream_busy_accepted: 'upstreamBusyAccepted',
    media_ready: 'mediaReady',
    base_request_start: 'baseRequestStart',
    base_headers_received: 'baseHeadersReceived',
    pdf_start: 'pdfStart',
    pdf_metadata: 'pdfMetadata',
    pdf_visual_prepare: 'pdfVisualPrepare',
    pdf_visual_plan: 'pdfVisualPlan',
    pdf_visual_batch: 'pdfVisualBatch',
    pdf_visual_progress: 'pdfVisualProgress',
    pdf_complete: 'pdfComplete',
    image_start: 'imageStart',
    image_vision: 'imageVision',
    image_complete: 'imageComplete',
    vision_crop_rejected: 'visionCropRejected',
    vision_crop: 'visionCrop',
  };
  if (phase === 'queue_wait') return statusText(locale, 'queueWait', { position: details.position ?? 0 });
  const key = phaseToKey[phase];
  if (key) return statusText(locale, key, values);
  return String(fallbackMessage || '') || statusText(locale, 'genericProcessing');
}
