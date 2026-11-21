import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { pageTextInReadingOrder } from './pdf-text.mjs';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 120000;

export function cleanText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/[\t ]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

export async function extractFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!['.pdf', '.docx', '.txt', '.md'].includes(ext)) throw new Error('支持 PDF、DOCX、TXT 和 Markdown；旧版 DOC 请先另存为 DOCX。');
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('请选择非空文件，大小不超过 10 MB。');
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL(import.meta.url), { workerData: { buffer, ext }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('解析超时，请减少文档页数或粘贴简历文字。')); }, 25000);
    worker.once('message', result => {
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (result.error) reject(new Error(result.error));
      else resolve(result);
    });
    worker.once('error', () => { clearTimeout(timer); reject(new Error('文件解析失败，请确认文件未损坏，或改用粘贴文字。')); });
    worker.once('exit', () => { clearTimeout(timer); if (!settled) reject(new Error('文件解析中止，请减少文件大小后重试。')); });
  });
}

if (!isMainThread) {
  try {
    const buffer = Buffer.from(workerData.buffer);
    const ext = workerData.ext;
    let text = '', pages = null;
    if (ext === '.pdf') {
      if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效的 PDF。');
      const { getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      try {
        pages = pdf.numPages;
        if (pages > 30) throw new Error('简历最多支持 30 页，请上传精简版本。');
        const pageTexts = [];
        for (let i = 1; i <= pages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pageTexts.push(pageTextInReadingOrder(content.items, page.getViewport({ scale: 1 })));
        }
        text = pageTexts.join('\n\n');
      } finally { await pdf.loadingTask.destroy(); }
    } else if (ext === '.docx') {
      if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('文件内容不是有效的 DOCX。');
      // Bound ZIP expansion before handing a document to Mammoth.
      let expanded = 0;
      for (let offset = 0; offset < buffer.length - 46; offset++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
        expanded += buffer.readUInt32LE(offset + 24);
        if (expanded > 32 * 1024 * 1024) throw new Error('文档解压后过大，请移除图片后重新上传。');
        offset += 45 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
      }
      const mammoth = await import('mammoth');
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      if (buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buffer);
      else {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
      }
    }
    text = cleanText(text);
    if (text.length < 30) throw new Error('没有提取到足够文字。扫描版 PDF 暂不支持 OCR，请使用文字版文件或粘贴简历内容。');
    if (text.length > MAX_TEXT_LENGTH) throw new Error('简历文字过长，请精简到 12 万字以内。');
    parentPort.postMessage({ text, pages, ext: ext.slice(1) });
  } catch (error) {
    parentPort.postMessage({ error: /password/i.test(error.message) ? 'PDF 已加密，请解除密码后重新上传。' : error.message });
  }
}
