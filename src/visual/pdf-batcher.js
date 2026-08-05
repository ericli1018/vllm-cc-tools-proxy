export function batchVisualPages(pages, size = 4) {
  if (!Number.isInteger(size) || size < 1) throw new Error('Visual batch size must be a positive integer');
  const batches = [];
  for (let index = 0; index < pages.length; index += size) batches.push(pages.slice(index, index + size));
  return batches;
}
