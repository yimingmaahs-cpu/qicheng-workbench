import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { pullConditions } from './jobs.mjs';
import { platformPages as platforms, platformForJobURL, searchQueries, collectPlatformJobs } from './platform-pages.mjs';

const fail = message => Object.assign(new Error(message), { status: 400 });
export function platformBrowser(dataDir) {
  const contexts = new Map(), launching = new Map(), failedPages = new Map(), applicationPages = new WeakSet(); let busy = false, closed = false;
  const open = async key => {
    const p = platforms[key]; if (!Object.hasOwn(platforms,key)) throw fail('暂不支持该招聘平台。');
    if (closed) throw fail('采集服务已关闭，请重新启动工作台。');
    if (!contexts.has(key)) {
      let opening = launching.get(key);
      if (!opening) {
        const profile = path.join(dataDir, 'platform-browser', key); mkdirSync(profile, { recursive: true });
        opening = chromium.launchPersistentContext(profile, { channel: 'msedge', headless: false, chromiumSandbox: true, viewport: { width: 1280, height: 850 }, timeout: 20000 }).then(async context => {
          try {
            // BOSS's console timing/getter probes mistake Playwright's console transport
            // for open DevTools and clear the page. Its probes also run in srcdoc frames.
            if (key === 'boss') await context.addInitScript(() => {
              try {
                if (window.top.location.hostname === 'www.zhipin.com') {
                  console.log = () => {}; console.table = () => {};
                }
              } catch { /* Cross-origin frames keep their own console. */ }
            });
          } catch (error) { await context.close().catch(() => {}); throw error; }
          if (closed) { await context.close(); throw fail('采集服务已关闭。'); }
          contexts.set(key, context); context.on('close', () => { if (contexts.get(key) === context) contexts.delete(key); }); return context;
        });
        launching.set(key, opening);
      }
      try { await opening; } finally { if (launching.get(key) === opening) launching.delete(key); }
    }
    const context = contexts.get(key);
    const pages = context.pages().filter(page => !applicationPages.has(page));
    // Login and collection share a page; detail/application tabs remain separate.
    return { p, context, page: pages[0] || await context.newPage() };
  };
  async function pull(key,input,onProgress = () => {},existingJob = () => null) {
    if (busy) throw Object.assign(fail('本机招聘采集正在处理上一项任务，请稍后重试。'),{status:409});
    if (!Object.hasOwn(platforms,key)) throw fail('暂不支持该招聘平台。');
    const c = pullConditions(input); searchQueries(c);
    busy = true; let page;
    try {
      if (closed) throw fail('采集服务已关闭，请重新启动工作台。');
      page = failedPages.get(key);
      if (!page || page.isClosed()) page = (await open(key)).page;
      failedPages.delete(key);
      return await collectPlatformJobs(page,key,c,onProgress,() => closed,existingJob);
    } catch (error) {
      if (page && !page.isClosed()) { failedPages.set(key,page); await page.bringToFront().catch(() => {}); }
      if (error.status) throw error;
      throw fail(platforms[key].name + '页面加载失败或连接超时，请检查保留的采集窗口后重试。');
    } finally {
      busy = false;
    }
  }
  return {
    async login(key) {
      if (busy) throw Object.assign(fail('本机采集或登录窗口正在处理，请稍后重试。'), { status: 409 });
      busy = true;
      try {
        if (closed) throw fail('采集服务已关闭，请重新启动工作台。');
        const pending = failedPages.get(key);
        if (pending && !pending.isClosed() && /^https?:/.test(pending.url())) {
          await pending.bringToFront();
          return { message: `${platforms[key].name}采集窗口已显示；请在当前页面完成登录或安全验证，然后回到工作台重试拉取。` };
        }
        const opened = await open(key); await opened.page.goto(opened.p.login, { waitUntil: 'domcontentloaded', timeout: 45000 }); await opened.page.bringToFront();
        return { message: `${opened.p.name}登录窗口已打开；请在本机完成登录或安全验证，登录状态仅保存在本机。` };
      } catch (error) {
        if (error.status) throw error;
        throw fail('无法打开登录窗口，请确认本机已安装 Microsoft Edge，且平台登录页面可以访问。');
      } finally { busy = false; }
    },
    async openJob(key,url) {
      if (platformForJobURL(url) !== key) throw fail('不支持此平台的岗位链接。');
      const {context} = await open(key);
      const page = await context.newPage(); applicationPages.add(page);
      try { await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}); await page.bringToFront(); return {message:'已在该平台的已登录窗口打开岗位，请在原网站查看并投递。'}; }
      catch { throw fail('岗位页面暂时无法打开，请检查平台窗口或网络后重试。'); }
    },
    pull,
    async close() {
      closed = true;
      await Promise.allSettled([...launching.values()]);
      await Promise.all([...contexts.values()].map(context => context.close())); contexts.clear(); failedPages.clear();
    },
  };
}
