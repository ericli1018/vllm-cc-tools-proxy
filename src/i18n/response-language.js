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

const PROFILES = Object.freeze({
  'zh-TW': Object.freeze({
    modelInstruction: '在 think 思考區塊之外，所有使用者可見的自然語言內容都必須使用繁體中文（zh-TW）。\n除非使用者明確要求，否則不得切換為其他語言。',
    processorInstruction: 'Write the result in Traditional Chinese (zh-TW).',
    progressHeader: '目前處理進度：',
    status: Object.freeze({
      genericProcessing: () => '正在處理…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `主模型仍在處理本輪請求，已執行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `主模型已開始回傳資料，已執行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      searchStart: ({ query = '' }) => `正在搜尋：${query}…`,
      searchDone: ({ query = '' }) => `搜尋完成：${query}。`,
      fetchStart: ({ host = '網頁' }) => `正在讀取並整理 ${host}…`,
      fetchDone: ({ host = '網頁' }) => `${host} 內容已就緒。`,
      fetchError: ({ host = '網頁' }) => `${host} 讀取失敗；正在交由主模型改用其他來源。`,
      queueWait: ({ position = 0, seconds = 0 }) => `正在等待主模型執行資源，已排隊 ${seconds} 秒，目前前方有 ${position} 個任務…`,
      queueAdmitted: () => '任務已開始處理…',
      modelPlanning: () => '正在請主模型規劃下一步…',
      modelToolResults: () => '主模型正在整理工具結果…',
      finalChannelRecovery: () => '主模型答案通道異常；正在進行一次短格式修正…',
      continuationRecovery: () => '主模型未產生有效下一步；正在進行一次受控續接…',
      finalRoundReserved: () => '研究工具預算已停止擴張；保留時間給主模型完成下一步…',
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
      imageVision: () => '正在使用視覺模型分析圖片…',
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
    modelInstruction: '在 think 思考区块之外，所有用户可见的自然语言内容都必须使用简体中文（zh-CN）。\n除非用户明确要求，否则不得切换为其他语言。',
    processorInstruction: 'Write the result in Simplified Chinese (zh-CN).',
    progressHeader: '当前处理进度：',
    status: Object.freeze({
      genericProcessing: () => '正在处理…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `主模型仍在处理本轮请求，已执行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `主模型已开始返回数据，已执行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（已收到 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      searchStart: ({ query = '' }) => `正在搜索：${query}…`,
      searchDone: ({ query = '' }) => `搜索完成：${query}。`,
      fetchStart: ({ host = '网页' }) => `正在读取并整理 ${host}…`,
      fetchDone: ({ host = '网页' }) => `${host} 内容已就绪。`,
      fetchError: ({ host = '网页' }) => `${host} 读取失败；正在交由主模型改用其他来源。`,
      queueWait: ({ position = 0, seconds = 0 }) => `正在等待主模型执行资源，已排队 ${seconds} 秒，目前前方有 ${position} 个任务…`,
      queueAdmitted: () => '任务已开始处理…',
      modelPlanning: () => '正在请主模型规划下一步…',
      modelToolResults: () => '主模型正在整理工具结果…',
      finalChannelRecovery: () => '主模型答案通道异常；正在进行一次短格式修正…',
      continuationRecovery: () => '主模型未生成有效下一步；正在进行一次受控续接…',
      finalRoundReserved: () => '研究工具预算已停止扩张；保留时间给主模型完成下一步…',
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
      imageVision: () => '正在使用视觉模型分析图片…',
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
    modelInstruction: 'Outside the think reasoning block, all user-visible natural-language content MUST be written in English (en-US).\nDo not switch to another language unless the user explicitly requests it.',
    processorInstruction: 'Write the result in English (en-US).',
    progressHeader: 'Current progress:',
    status: Object.freeze({
      genericProcessing: () => 'Processing…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `The main model is still processing this request. Running for ${seconds}s${hasReceivedBytes(receivedBytes) ? ` (received ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `The main model has started returning data. Running for ${seconds}s${hasReceivedBytes(receivedBytes) ? ` (received ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      searchStart: ({ query = '' }) => `Searching: ${query}…`,
      searchDone: ({ query = '' }) => `Search completed: ${query}.`,
      fetchStart: ({ host = 'web page' }) => `Fetching and processing ${host}…`,
      fetchDone: ({ host = 'web page' }) => `${host} content is ready.`,
      fetchError: ({ host = 'web page' }) => `Failed to fetch ${host}; the main model will use another source.`,
      queueWait: ({ position = 0, seconds = 0 }) => `Waiting for main-model capacity; queued for ${seconds}s with ${position} task(s) ahead…`,
      queueAdmitted: () => 'Task processing started…',
      modelPlanning: () => 'The main model is planning the next step…',
      modelToolResults: () => 'The main model is processing tool results…',
      finalChannelRecovery: () => 'The main model response channel is malformed; applying one short format repair…',
      continuationRecovery: () => 'The main model produced no valid next step; applying one bounded continuation…',
      finalRoundReserved: () => 'Research tool expansion stopped; reserving time for the main model to finish the next step…',
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
      imageVision: () => 'Analyzing image with the visual model…',
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
    modelInstruction: 'think 推論ブロックの外では、ユーザーに表示されるすべての自然言語の内容を日本語（ja-JP）で記述しなければなりません。\nユーザーが明示的に要求しない限り、他の言語に切り替えないでください。',
    processorInstruction: 'Write the result in Japanese (ja-JP).',
    progressHeader: '現在の処理状況：',
    status: Object.freeze({
      genericProcessing: () => '処理中…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `メインモデルがこのリクエストを処理中です。実行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（受信 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `メインモデルがデータを返し始めました。実行 ${seconds} 秒${hasReceivedBytes(receivedBytes) ? `（受信 ${formatReceivedBytes(receivedBytes)}）` : ''}…`,
      searchStart: ({ query = '' }) => `検索中：${query}…`,
      searchDone: ({ query = '' }) => `検索完了：${query}。`,
      fetchStart: ({ host = 'Webページ' }) => `${host} を取得して処理しています…`,
      fetchDone: ({ host = 'Webページ' }) => `${host} の内容を取得しました。`,
      fetchError: ({ host = 'Webページ' }) => `${host} の取得に失敗しました。メインモデルが別の情報源を使用します。`,
      queueWait: ({ position = 0, seconds = 0 }) => `メインモデルの実行枠を待機中です。${seconds} 秒待機、前に ${position} 件あります…`,
      queueAdmitted: () => 'タスクの処理を開始しました…',
      modelPlanning: () => 'メインモデルが次の手順を計画しています…',
      modelToolResults: () => 'メインモデルがツールの結果を処理しています…',
      finalChannelRecovery: () => 'メインモデルの応答チャネルに異常があります。短い形式修正を1回実行します…',
      continuationRecovery: () => 'メインモデルが有効な次の手順を生成しませんでした。制限付きの継続処理を1回実行します…',
      finalRoundReserved: () => '調査ツールの拡張を停止し、メインモデルが次の手順を完了する時間を確保します…',
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
      imageVision: () => '視覚モデルで画像を分析しています…',
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
    modelInstruction: 'think 추론 블록 밖에서는 사용자에게 표시되는 모든 자연어 내용을 한국어(ko-KP)로 작성해야 합니다.\n사용자가 명시적으로 요청하지 않는 한 다른 언어로 전환하지 마십시오.',
    processorInstruction: 'Write the result in Korean (ko-KP).',
    progressHeader: '현재 처리 상태:',
    status: Object.freeze({
      genericProcessing: () => '처리 중…',
      modelWaiting: ({ seconds = 0, receivedBytes } = {}) => `주 모델이 이 요청을 처리하고 있습니다. ${seconds}초 실행${hasReceivedBytes(receivedBytes) ? ` (수신 ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      modelFirstByte: ({ seconds = 0, receivedBytes } = {}) => `주 모델이 데이터를 반환하기 시작했습니다. ${seconds}초 실행${hasReceivedBytes(receivedBytes) ? ` (수신 ${formatReceivedBytes(receivedBytes)})` : ''}…`,
      searchStart: ({ query = '' }) => `검색 중: ${query}…`,
      searchDone: ({ query = '' }) => `검색 완료: ${query}.`,
      fetchStart: ({ host = '웹 페이지' }) => `${host}의 내용을 가져와 처리하고 있습니다…`,
      fetchDone: ({ host = '웹 페이지' }) => `${host}의 내용이 준비되었습니다.`,
      fetchError: ({ host = '웹 페이지' }) => `${host} 가져오기에 실패했습니다. 주 모델이 다른 자료원을 사용합니다.`,
      queueWait: ({ position = 0, seconds = 0 }) => `주 모델 실행 자원을 기다리고 있습니다. ${seconds}초 대기, 앞에 ${position}개 작업이 있습니다…`,
      queueAdmitted: () => '작업 처리를 시작했습니다…',
      modelPlanning: () => '주 모델이 다음 단계를 계획하고 있습니다…',
      modelToolResults: () => '주 모델이 도구 실행 결과를 처리하고 있습니다…',
      finalChannelRecovery: () => '주 모델 응답 채널에 이상이 있습니다. 짧은 형식 수정을 한 번 수행합니다…',
      continuationRecovery: () => '주 모델이 유효한 다음 단계를 생성하지 못했습니다. 제한된 이어쓰기를 한 번 수행합니다…',
      finalRoundReserved: () => '조사 도구 확장을 중단하고 주 모델이 다음 단계를 완료할 시간을 확보합니다…',
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
      imageVision: () => '시각 모델로 그림을 분석하고 있습니다…',
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

export function progressBlockHeader(locale, { receivedBytes } = {}) {
  const resolved = resolveResponseLanguage(locale);
  const base = languageProfile(resolved).progressHeader;
  if (!hasReceivedBytes(receivedBytes)) return base;
  const amount = formatReceivedBytes(receivedBytes);
  const stem = base.replace(/[：:]$/, '');
  if (resolved === 'zh-TW') return `${stem}（已收到 ${amount}）：`;
  if (resolved === 'zh-CN') return `${stem}（已收到 ${amount}）：`;
  if (resolved === 'ja-JP') return `${stem}（受信 ${amount}）：`;
  if (resolved === 'ko-KP') return `${stem} (수신 ${amount}):`;
  return `${stem} (received ${amount}):`;
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
  };
  const phaseToKey = {
    media_cache_miss: 'mediaCacheMiss',
    queue_admitted: 'queueAdmitted',
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
