import path from 'node:path';
import { chromium } from 'playwright-core';

const fail = (status, message) => Object.assign(new Error(message), { status });
const origin = 'https://wx.mail.qq.com';
const messageKey = value => String(value || '').trim().replace(/^<|>$/g, '');

export function qqMailRoute(current, mailId) {
  const url = new URL(current);
  if (url.origin !== origin || url.pathname !== '/home/index' || !url.searchParams.get('sid')) throw fail(409, '请先在工作台 QQ 窗口登录邮箱，再点击原邮件。');
  if (mailId && !/^[A-Za-z0-9_@.-]{1,200}$/.test(mailId)) throw fail(502, 'QQ 邮件标识无效，请重新定位。');
  url.hash = mailId ? '/read/' + encodeURIComponent(mailId) : '/list/1';
  return url.href;
}

export function isExactQqMail(source, messageId) {
  const headers = String(source || '').split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const values = [...headers.matchAll(/^message-id:[ \t]*([^\r\n]+)/gim)];
  return values.length === 1 && !!messageKey(messageId) && messageKey(values[0][1]) === messageKey(messageId);
}

// The QQ web ID is not an IMAP UID. Resolve it in the user's QQ session and
// verify Message-ID; never save SID-bearing URLs in the workbench database.
export function qqMailBrowser(dataDir) {
  let context, launching, busy = false;
  async function windowPage() {
    if (!context) {
      launching ||= chromium.launchPersistentContext(path.join(dataDir, 'mail-browser-profile'), {
        channel: 'msedge', headless: false, viewport: null, timeout: 20000,
      }).then(c => { context = c; c.on('close', () => { if (context === c) context = undefined; }); return c; }).finally(() => { launching = undefined; });
      try { await launching; } catch { throw fail(503, '无法打开工作台 QQ 窗口，请关闭残留的工作台 QQ 窗口后重试。'); }
    }
    let page = context.pages().find(p => { try { return new URL(p.url()).origin === origin; } catch { return false; } });
    if (!page) { page = context.pages()[0] || await context.newPage(); await page.goto('https://mail.qq.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    await page.bringToFront();
    return page;
  }
  async function checkAccount(page, account) {
    const label = page.locator('.profile-user-info .user-email');
    try { await label.waitFor({ state: 'visible', timeout: 8000 }); } catch { return false; }
    if ((await label.innerText()).trim().toLowerCase() !== account.toLowerCase()) throw fail(409, 'QQ 窗口当前账号与这封邮件的邮箱账号不同，请切换到对应账号后重试。');
    qqMailRoute(page.url());
    return true;
  }
  return {
    async close() { if (launching) await launching.catch(() => {}); if (context) await context.close(); },
    async open(mail) {
      if (busy) throw fail(409, '正在定位另一封 QQ 邮件，请稍后再试。');
      if (!mail.account || !messageKey(mail.messageId)) throw fail(400, '这封邮件缺少原始标识，暂时无法自动定位；请查看本地正文。');
      busy = true;
      try {
        const page = await windowPage();
        if (!await checkAccount(page, mail.account)) return { status: 'login_required', message: '已打开工作台专用 QQ 窗口。首次使用请在该窗口登录，然后再次点击这封邮件；登录有效期间无需重复登录。' };
        await page.goto(qqMailRoute(page.url()), { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!await checkAccount(page, mail.account)) return { status: 'login_required', message: 'QQ 登录已过期，请在工作台 QQ 窗口登录后重试。' };
        const input = page.getByRole('textbox');
        if (!await input.count()) await page.getByText('搜索', { exact: true }).click({ timeout: 10000 });
        await input.fill(mail.subject, { timeout: 10000 });
        await input.press('Enter');
        await page.getByText('邮件搜索结果', { exact: true }).waitFor({ state: 'visible', timeout: 20000 });
        await page.waitForFunction(() => /共\s*\d+\s*封|没有找到|未找到|无搜索结果/.test(document.body.innerText), undefined, { timeout: 20000 });
        const candidates = await page.locator('[data-mailid]').evaluateAll((els, subject) => els.filter(el => el.querySelector('.mail-subject')?.textContent.trim() === subject.trim()).map(el => el.getAttribute('data-mailid')), mail.subject);
        const searchUrl = page.url();
        // ponytail: inspect at most 20 same-subject candidates; large result sets
        // stay in QQ search for manual selection instead of guessing a mail.
        if (!candidates.length || candidates.length > 20) throw fail(404, candidates.length ? '同主题邮件较多，已打开 QQ 搜索结果，请在结果中选择原邮件。' : '未找到对应原邮件，可能已移动或删除；QQ 窗口已保留搜索结果。');
        for (const id of [...new Set(candidates)]) {
          const readUrl = new URL(qqMailRoute(page.url(), id));
          const sourceUrl = new URL('/read/readmail', origin);
          sourceUrl.search = new URLSearchParams({func:'3',mailid:id,sid:readUrl.searchParams.get('sid')}).toString();
          const response = await page.request.get(sourceUrl.href, {timeout:15000});
          if (!response.ok()) throw fail(502, 'QQ 原邮件校验暂时失败，请稍后重试。');
          let source;
          try { source = await response.body(); } finally { await response.dispose(); }
          if (source.length > 2*1024*1024) throw fail(413, '原邮件超过 2 MB，请在 QQ 搜索结果中查看。');
          if (isExactQqMail(source.toString('utf8'), mail.messageId)) {
            await page.goto(readUrl.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.locator('.mail-detail-basic-action-bar').waitFor({ state: 'visible', timeout: 10000 });
            await page.bringToFront();
            return { status: 'opened', message: '已在 QQ 邮箱打开对应原邮件。' };
          }
        }
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        throw fail(404, '搜索结果与这封邮件的原始标识不一致，未自动选定；请在 QQ 窗口核对。');
      } catch (error) {
        if (error.status) throw error;
        // Browser error strings can contain SID URLs. Keep them out of API/logs.
        throw fail(502, 'QQ 邮件定位未完成，请检查工作台 QQ 窗口是否已登录，再重试。');
      } finally { busy = false; }
    },
  };
}
