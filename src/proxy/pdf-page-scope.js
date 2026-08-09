export class PdfPageScopeError extends Error {
  constructor(message, code = 'invalid_pdf_page_scope') {
    super(message);
    this.name = 'PdfPageScopeError';
    this.code = code;
  }
}

function canonicalizePages(pages) {
  const parts = [];
  let start = pages[0];
  let previous = pages[0];
  const flush = () => {
    if (start === previous) parts.push(String(start));
    else parts.push(`${start}-${previous}`);
  };
  for (let index = 1; index < pages.length; index += 1) {
    const value = pages[index];
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    flush();
    start = value;
    previous = value;
  }
  flush();
  return parts.join(',');
}

export function parsePdfPageScope(value, { maxPages = 5000, maxPage = 1_000_000 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const selected = new Set();
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (!part) throw new PdfPageScopeError('PDF page scope contains an empty segment.');
    const single = part.match(/^([1-9]\d*)$/);
    if (single) {
      const page = Number(single[1]);
      if (!Number.isSafeInteger(page) || page > maxPage) throw new PdfPageScopeError('PDF page number is out of range.');
      selected.add(page);
      if (selected.size > maxPages) throw new PdfPageScopeError('PDF page scope exceeds the configured page limit.', 'pdf_page_scope_limit');
      continue;
    }
    const range = part.match(/^([1-9]\d*)\s*-\s*([1-9]\d*)$/);
    if (!range) throw new PdfPageScopeError('PDF page scope syntax is invalid.');
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end > maxPage) {
      throw new PdfPageScopeError('PDF page range is invalid.');
    }
    if ((end - start + 1) > maxPages) throw new PdfPageScopeError('PDF page scope exceeds the configured page limit.', 'pdf_page_scope_limit');
    for (let page = start; page <= end; page += 1) {
      selected.add(page);
      if (selected.size > maxPages) throw new PdfPageScopeError('PDF page scope exceeds the configured page limit.', 'pdf_page_scope_limit');
    }
  }
  const pages = [...selected].sort((a, b) => a - b);
  if (pages.length === 0) throw new PdfPageScopeError('PDF page scope is empty.');
  return { pages, canonical: canonicalizePages(pages) };
}
