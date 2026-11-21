const contactRedactions = [
  [/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]'],
  [/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]'],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, '[证件号码已隐藏]'],
];
export function redactContact(text) { return contactRedactions.reduce((value, [pattern, mask]) => value.replace(pattern, mask), text); }

export function quoteRestorer(original, enabled) {
  if (!enabled) return value => value;
  let masked = original, boundaries = Array.from({ length: original.length + 1 }, (_, i) => i);
  for (const [pattern, mask] of contactRedactions) {
    let next = '', cursor = 0; const nextBoundaries = [];
    for (const match of masked.matchAll(pattern)) {
      next += masked.slice(cursor, match.index) + mask;
      for (let i = cursor; i < match.index; i++) nextBoundaries.push(boundaries[i]);
      nextBoundaries.push(boundaries[match.index], ...Array(mask.length - 1).fill(null));
      cursor = match.index + match[0].length;
    }
    next += masked.slice(cursor);
    for (let i = cursor; i <= masked.length; i++) nextBoundaries.push(boundaries[i]);
    masked = next; boundaries = nextBoundaries;
  }
  return value => {
    if (typeof value !== 'string') return value;
    const quote = value.trim();
    if (!quote || original.includes(quote)) return quote;
    const start = masked.indexOf(quote), end = start + quote.length;
    if (start < 0 || masked.indexOf(quote, start + 1) >= 0 || boundaries[start] === null || boundaries[end] === null) return '';
    return original.slice(boundaries[start], boundaries[end]);
  };
}

export async function requestReviewModel(settings, apiKey, system, payload, { temperature = 0.2, maxTokens = 6000, onRetry = () => {} } = {}) {
  if (settings.enabled === false) throw new Error('AI 已关闭，请先在本地设置中启用 AI。');
  if (!settings.baseUrl || !settings.model) throw new Error('请先配置模型地址和名称。');
  const content = JSON.stringify(payload);
  if (content.length > 180000) throw new Error('本节点材料过长，请精简简历或补充回答；未截断任何材料。');
  // Fixed, separately audited nodes use direct structured answers rather than repeated long reasoning.
  const deepseek = new URL(settings.baseUrl).origin === 'https://api.deepseek.com' && /^deepseek-(flash|v4-pro)$/i.test(settings.model);
  let outputLimit = Math.min(16384, Math.max(maxTokens, 1));
  const signal = AbortSignal.timeout(90000);
  let omitTemperature = false, tokenParameter = 'max_tokens', lengthRetried = false, transientRetried = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: settings.model, messages: [{ role: 'system', content: system + (lengthRetried ? '\n上次输出达到长度上限。请重新返回完整 JSON，压缩重复解释；保留全部要求覆盖、必要字段和逐字引用，不续写上次片段、不省略必要结果。' : '') }, { role: 'user', content: settings.redact !== false ? redactContact(content) : content }], ...(!omitTemperature ? { temperature } : {}), [tokenParameter]: outputLimit, ...(deepseek ? { thinking: { type: 'disabled' } } : {}) }),
      });
      if (!response.ok) {
        const details = await response.text();
        if (response.status === 400 && !omitTemperature && /temperature/i.test(details) && /unsupported|not supported|does not support|only.*supported|not compatible|不支持/i.test(details)) { omitTemperature = true; continue; }
        if (response.status === 400 && tokenParameter === 'max_tokens' && /max_tokens/i.test(details) && /max_completion_tokens/i.test(details) && /unsupported|not supported|does not support|use|不支持/i.test(details)) { tokenParameter = 'max_completion_tokens'; continue; }
        if (response.status === 401 || response.status === 403) throw new Error('模型服务拒绝访问，请检查 API Key 和模型权限。');
        if (response.status === 429) throw new Error('模型请求过多或额度不足，请稍后重试或检查余额。');
        if ([502, 503, 504].includes(response.status) && !transientRetried) { transientRetried = true; continue; }
        throw new Error(`模型服务返回 HTTP ${response.status}，请检查地址和模型名称。`);
      }
      const raw = await response.text();
      if (raw.length > 500000) throw new Error('模型响应过长，请精简材料后重试。');
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('模型服务未返回有效 JSON。'); }
      if (data.choices?.[0]?.finish_reason === 'length') {
        if (!lengthRetried) {
          lengthRetried = true; outputLimit = Math.min(16384, outputLimit * 2);
          onRetry(`输出达到长度上限，正以 ${outputLimit.toLocaleString('en-US')} token 预算重新生成当前节点（仅一次）…`);
          continue;
        }
        throw new Error(`当前节点自动重试后仍被截断（请求上限 ${outputLimit} token），可能达到模型输出或上下文限制。请精简材料或选择支持更长输出的模型后重试；未采用不完整结果。`);
      }
      const message = data.choices?.[0]?.message?.content;
      if (typeof message !== 'string') throw new Error('模型未返回文字内容。');
      try { return JSON.parse(message.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
      catch { throw new Error('模型未返回有效的结构化报告，请重试或更换支持 JSON 的模型。'); }
    } catch (error) {
      if (signal.aborted || error.name === 'TimeoutError') throw new Error('当前模型节点超过 90 秒，已停止自动等待；已完成进度会保留，可稍后继续评审。');
      if (!transientRetried && error.message === 'fetch failed') { transientRetried = true; continue; }
      if (error.message === 'fetch failed') throw new Error('无法连接模型服务，请检查配置后重试当前节点。');
      throw error;
    }
  }
  throw new Error('模型参数兼容与重试已达上限，请核对模型配置；未采用不完整结果。');
}
