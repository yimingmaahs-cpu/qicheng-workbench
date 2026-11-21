// PDF paint order is not reading order. Rebuild visual rows in viewport coordinates.
export function pageTextInReadingOrder(items, viewport) {
  const fragments = items.filter(item => typeof item.str === 'string' && item.str.trim() && item.transform?.length === 6).map(item => {
    const [a, b, c, d, tx, ty] = item.transform;
    const [x, y] = viewport.convertToViewportPoint(tx, ty);
    const length = Math.hypot(a, b) || 1;
    const end = viewport.convertToViewportPoint(tx + item.width * a / length, ty + item.width * b / length);
    return { text: item.str, x: Math.min(x, end[0]), right: Math.max(x, end[0]), y, height: Math.max(1, Math.hypot(c, d) * viewport.scale) };
  }).filter(item => [item.x, item.right, item.y, item.height].every(Number.isFinite));
  fragments.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const fragment of fragments) {
    // Compare baselines, not glyph tops: headings often mix font sizes on one row.
    const row = rows.findLast(row => Math.abs(row.y - fragment.y) <= Math.max(2, Math.min(row.height, fragment.height) * 0.35));
    if (row) { row.items.push(fragment); row.height = Math.min(row.height, fragment.height); }
    else rows.push({ y: fragment.y, height: fragment.height, items: [fragment] });
  }
  // ponytail: line-major order preserves aligned table rows. Independent multi-column
  // text boxes can still need manual correction; do not guess columns from date fields.
  return rows.map(row => {
    row.items.sort((a, b) => a.x - b.x || a.right - b.right);
    let text = '', previous = null;
    for (const item of row.items) {
      if (previous) {
        const gap = item.x - previous.right;
        const height = Math.min(item.height, previous.height);
        if (!/\s$/.test(text) && !/^\s/.test(item.text) && gap > Math.max(1, height * 0.15)) text += gap > height * 2 ? '    ' : ' ';
      }
      text += item.text;
      previous = item;
    }
    return text.trim();
  }).filter(Boolean).join('\n');
}
