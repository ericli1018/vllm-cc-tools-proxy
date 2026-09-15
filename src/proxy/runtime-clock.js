const RUNTIME_CLOCK_MARKER = '[VCC_PROXY_RUNTIME_CLOCK_V1]';

function zonedParts(now, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  return Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
}

export function formatRuntimeClockReminder(now = new Date(), timeZone = 'Asia/Taipei') {
  const parts = zonedParts(now, timeZone);
  const zoneName = String(parts.timeZoneName || 'GMT+00:00');
  const offset = zoneName === 'GMT' ? '+00:00' : zoneName.replace(/^GMT/, '');
  return [
    '<system-reminder>',
    RUNTIME_CLOCK_MARKER,
    `Current local datetime: ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`,
    `Timezone: ${timeZone}`,
    'Use this as the authoritative current date and time when reasoning about now, today, tomorrow, yesterday, elapsed time, schedules, or deadlines.',
    'Do not mention this reminder unless the current date or time is relevant to the task.',
    '</system-reminder>',
  ].join('\n');
}

export function injectRuntimeClockReminder(request, {
  enabled = true,
  timeZone = 'Asia/Taipei',
  now = new Date(),
} = {}) {
  if (!enabled || !request || typeof request !== 'object' || !Array.isArray(request.messages)) return request;
  const messages = structuredClone(request.messages);
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return request;

  const reminder = { type: 'text', text: formatRuntimeClockReminder(now, timeZone) };
  const message = messages[userIndex];
  if (typeof message.content === 'string') {
    message.content = [
      { type: 'text', text: message.content },
      reminder,
    ];
  } else if (Array.isArray(message.content)) {
    message.content = [
      ...message.content.filter((block) => !(block?.type === 'text' && String(block.text || '').includes(RUNTIME_CLOCK_MARKER))),
      reminder,
    ];
  } else {
    message.content = [reminder];
  }

  return { ...request, messages };
}

export { RUNTIME_CLOCK_MARKER };
