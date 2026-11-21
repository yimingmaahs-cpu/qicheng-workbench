import path from 'node:path';
import { chromium } from 'playwright-core';
import { normalizeJob, pullConditions, filterPulledJobs } from './jobs.mjs';

const OFFER_URL = 'https://offerqingbaoju.cn/info-summary';
const fail = message => Object.assign(new Error(message), { status: 400 });
export const isOfferSource = url => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'offerqingbaoju.cn' && u.pathname === '/info-summary'; } catch { return false; } };

export async function activateOfferHeader(page, column, filter = false) {
  const headers=page.locator('th:visible').filter({has:page.getByText(column,{exact:true})});
  // A rendered empty table can precede its asynchronously loaded columns.
  // Waiting on the actual header also protects callers outside the pull flow.
  try { await headers.first().waitFor({state:'visible',timeout:10000}); }
  catch (error) { if(error.name!=='TimeoutError')throw error; throw fail(`等待表格加载后仍没有可用的“${column}”列。请在采集窗口检查表格是否加载成功，再重试。`); }
  const count=await headers.count();
  if(count!==1)throw fail(count ? `网页中有多个“${column}”表头，已停止以避免操作错误的表格。` : `当前表格没有可用的“${column}”列，请检查所选招聘表格。`);
  const control=filter ? headers.locator('button.filter-btn') : headers.locator('button').first();
  await control.waitFor({state:'visible',timeout:10000});
  // Ant's fixed right column can cover the scrolled header button's click point.
  // Native keyboard activation focuses the real button without forcing a click
  // through that overlay or depending on the Edge window's size.
  await control.press('Enter');
}

export async function applyOfferFilter(page,column,text) {
  await activateOfferHeader(page,column,true);
  const heading=page.getByRole('heading',{name:`筛选 ${column}`,exact:true});
  await heading.waitFor({state:'visible',timeout:10000});
  const panel=page.locator('div.fixed').filter({has:heading});
  await panel.getByPlaceholder('搜索，支持用空格分隔多个关键词',{exact:true}).fill(text);
  await panel.getByRole('button',{name:'确认',exact:true}).press('Enter');
  await heading.waitFor({state:'hidden',timeout:10000});
}

export async function nextOfferPage(page) {
  const next = page.getByRole('button', { name: '下一页', exact: true });
  // A single-page result has no pager. A multi-page result disables Next on its last page.
  if (!await next.isVisible() || !await next.isEnabled()) return false;
  await next.click();
  return true;
}

export async function settleOfferTable(page, columns = ['招聘公告','更新时间'], timeout = 35000) {
  const started = Date.now(); let previous = '', stable = 0, last;
  while (Date.now() - started < timeout) {
    last = await page.locator('body').evaluate(body => {
      const visible = el => { const box=el.getBoundingClientRect(),style=getComputedStyle(el); return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none'; };
      const headers = [...body.querySelectorAll('th')].filter(visible).map(el=>{ const label=el.cloneNode(true);label.querySelectorAll('button, .ant-table-column-sorter').forEach(control=>control.remove());return label.textContent.replace(/\s+/g,' ').trim(); });
      const loading = [...body.querySelectorAll('.ant-spin-spinning, [aria-busy="true"]')].some(visible);
      const notices = [...body.querySelectorAll('.ant-message-notice-content, .ant-alert-message')].filter(visible).map(el=>el.innerText).join('\n');
      const rows = [...body.querySelectorAll('tbody tr')].filter(el=>visible(el)&&el.querySelector('td')&&el.innerText.trim()).map(el=>el.innerText);
      const empty = [...body.querySelectorAll('.ant-empty')].some(visible);
      return {headers,loading,rows,empty,loginError:/请先登录|登录已过期|登录已失效|登录状态.*失效/.test(notices),accessError:/需要登录或VIP权限|需要.*会员|没有权限|无权访问/.test(notices),loadError:/获取导航数据失败|数据加载失败|网络错误|请求超时/.test(notices)};
    });
    if(last.loginError)throw fail('网站提示登录状态失效，请在独立 Edge 采集窗口重新登录后再拉取。');
    if(last.accessError)throw fail('网站提示当前账号没有读取该表格的权限，请在独立 Edge 采集窗口确认登录和访问权限。');
    if(last.loadError&&!last.loading)throw fail('网站表格数据加载失败，请在独立 Edge 采集窗口刷新表格后重试。');
    if(!last.loading&&columns.every(column=>last.headers.includes(column))&&(last.rows.length||last.empty)) {
      const current=JSON.stringify([last.headers,last.rows,last.empty]);
      stable=current===previous?stable+1:0; previous=current;
      if(stable>=2)return;
    } else { previous='';stable=0; }
    await page.waitForTimeout(300);
  }
  const missing=columns.filter(column=>!last?.headers.includes(column));
  throw fail(last?.loading ? '网站表格仍在加载，已停止本次读取，请稍后重试。' : missing.length ? `网站表格未加载完整，仍缺少${missing.map(column=>`“${column}”`).join('、')}列。请在独立 Edge 采集窗口刷新所选表格后重试。` : '网站表格内容尚未稳定，已停止本次读取，请稍后重试。');
}

export function offerBrowserError(error,stage) {
  if(error.status)return error;
  const message=String(error.message);
  const detail=/intercepts pointer events/.test(message)?'控件被页面浮层遮挡':
    /not visible|outside of the viewport/.test(message)?'控件未显示在可用区域':
    /strict mode violation/.test(message)?'页面出现多个同名控件':
    /Timeout|timeout/.test(message)?'未能找到或激活所需控件（等待超时）':
    '页面结构或连接状态发生变化';
  return fail(`采集在“${stage}”步骤未完成：${detail}。请检查独立 Edge 页面是否仍已登录并加载完成，再重试。`);
}

// Read rendered cells only. Company headings on this site sometimes contain a
// graduation year, so retain the announcement as evidence for the company name.
export function offerRowJob(row, table, keyword = '') {
  const c = row.cells, links = row.links;
  const at = name => row.headers.indexOf(name);
  const value = name => c[at(name)] || '';
  const link = name => links[at(name)]?.[0] || '';
  const announcement = value('招聘公告');
  const allTitles = value('职位');
  const titles = keyword ? allTitles.split(/[,，]/).filter(t => t.toLowerCase().includes(keyword.toLowerCase())) : [];
  const companyCell = value('企业名称');
  const company = companyCell && !/^[\d,，\s]+$/.test(companyCell) ? companyCell : announcement.replace(/20\d{2}.*$/, '').trim();
  const title = (titles.length ? [...new Set(titles)].join(' / ') : allTitles || announcement).slice(0, 160);
  return normalizeJob({ title, company, announcement, batch: value('招聘批次'), companyType: value('企业性质'), industry: value('行业'), location: value('工作地点'), announcementUrl: link('公告链接'), url: link('投递地址') || link('公告链接'), sourceUpdatedAt: value('更新时间'), category: table === '实习信息汇总' ? '实习 · 招聘汇总' : `${table} · 招聘汇总`, sourceName: `Offer 情报局 · ${table}`, description: `【招聘汇总，尚未获取完整 JD】\n公告：${announcement}\n公告内职位原文：${allTitles}\n公告覆盖城市：${value('工作地点')}\n更新时间：${value('更新时间')}\n公告链接：${link('公告链接')}\n投递地址：${link('投递地址') || value('投递地址')}\n具体岗位职责、要求、薪资及在招状态请查阅原公告。`, notes: '来自已登录浏览器中的可见招聘表格。城市为公告整体覆盖范围；公司名称可能由公告标题提取。' });
}

export function offerBrowser(dataDir) {
  let context, launching, busy = false;
  async function open() {
    if (!context) {
      launching ||= chromium.launchPersistentContext(path.join(dataDir, 'offer-browser-profile'), { channel: 'msedge', headless: false, viewport: null, timeout: 20000 }).then(c => { context = c; c.on('close', () => { context = undefined; }); return c; }).finally(() => { launching = undefined; });
      try { await launching; } catch { throw fail('无法启动 Edge 采集窗口。请确认已安装 Microsoft Edge，并关闭残留的工作台采集窗口后重试。'); }
    }
    let page = context.pages().find(p => p.url().startsWith('https://offerqingbaoju.cn/'));
    if (!page) { page = context.pages()[0] || await context.newPage(); await page.goto(OFFER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
    return page;
  }
  return {
    async login() { if (busy) throw fail('正在采集，请完成后再打开登录窗口。'); const page = await open(); await page.bringToFront(); return { message: '已打开独立 Edge 采集窗口，请在其中登录 Offer 情报局；完成后回到这里拉取。' }; },
    async close() { if (context) await context.close(); },
    async pull(input, onProgress = () => {}) {
      if (busy) throw fail('采集浏览器正在使用，请稍后重试。');
      const c = pullConditions(input); busy = true; let stage = '打开采集窗口';
      const step = value => { stage = value; onProgress(value + '…'); };
      const columns = ['招聘公告','更新时间',...(c.keyword?['职位']:[]),...(c.location?['工作地点']:[])];
      const settle = page => settleOfferTable(page,columns);
      try {
        step('打开采集窗口');
        const page = await open();
        page.setDefaultTimeout(10000);
        step('加载信息汇总页面');
        await page.goto(OFFER_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try { await page.getByRole('button', { name: '退出登录', exact: true }).waitFor({ state: 'visible', timeout: 6000 }); }
        catch { throw fail('请先在独立 Edge 采集窗口登录 Offer 情报局，再返回工作台重试；Codex 内置浏览器的登录不会自动共享。'); }
        // The site auto-loads its default table on mount. Finish that request
        // before switching, otherwise its late response can replace our columns.
        step('等待初始表格加载');
        await settleOfferTable(page);
        step('切换招聘表格');
        await page.getByRole('button', { name: c.table, exact: true }).click(); await settle(page);
        step('清除原有筛选');
        await page.getByRole('button', { name: '清除筛选', exact: true }).click(); await settle(page);
        for (const [column, text] of [['职位', c.keyword], ['工作地点', c.location]]) {
          if (!text) continue;
          step(`设置${column}筛选`);
          await applyOfferFilter(page,column,text); await settle(page);
        }
        step('按更新时间排序');
        // A fresh page starts without an explicit sort; this site's own control
        // cycles ascending then descending, independently of Ant's sorter.
        await activateOfferHeader(page,'更新时间'); await settle(page);
        await activateOfferHeader(page,'更新时间'); await settle(page);
        const found = new Map(); let scanned = 0, skipped = 0, pages = 0, finished = false, lastDate = '', priorRows = '';
        const start = Date.now();
        // ponytail: bound one pull to 100 pages / 3 minutes; narrower filters
        // are required beyond that rather than unattended whole-site crawling.
        while (pages < 100 && Date.now() - start < 180000) {
          stage = '读取招聘表格';
          const rows = await page.locator('table').evaluateAll(tables => {
            const headers = tables.flatMap(t => Array.from(t.querySelectorAll('th'))).map(c => c.innerText.trim());
            // Ant Table adds an empty scrollbar header and an invisible measuring
            // row. Data cells need not equal the header count.
            return tables.flatMap(t => Array.from(t.querySelectorAll('tbody tr'))).filter(r => r.querySelector('td') && r.innerText.trim()).map(r => ({ headers, cells: Array.from(r.querySelectorAll('td')).map(c => c.innerText.trim()), links: Array.from(r.querySelectorAll('td')).map(c => Array.from(c.querySelectorAll('a[href]')).map(a => a.href)) }));
          });
          const signature = JSON.stringify(rows);
          if (pages && signature === priorRows) throw fail('翻页后内容未变化，已停止采集。请重试。');
          priorRows = signature; pages++;
          if (!rows.length) { finished = true; break; }
          for (const row of rows) {
            scanned++;
            let job; try { job = offerRowJob(row, c.table, c.keyword); } catch { skipped++; continue; }
            if (lastDate && job.sourceUpdatedAt > lastDate) throw fail('网站更新时间排序异常，已停止采集，避免返回错误的最新记录。');
            lastDate = job.sourceUpdatedAt;
            if (!filterPulledJobs([job], c).length) continue;
            const key = job.announcement + '|' + job.announcementUrl;
            const previous = found.get(key);
            if (!previous) found.set(key, job);
            else if (previous.url === previous.announcementUrl && job.url !== job.announcementUrl) found.set(key, job);
          }
          onProgress(`已读取 ${pages} 页、${scanned} 行，符合条件且去重后 ${found.size} 条`);
          stage = '翻页';
          if (found.size >= c.limit || (c.from && lastDate && lastDate < c.from) || !(await nextOfferPage(page))) { finished = true; break; }
          await settle(page);
        }
        return { jobs: [...found.values()].slice(0, c.limit), skipped, scanned, pages, warning: finished ? '' : '已达到单次读取上限（100 页 / 3 分钟），这是部分结果，请缩小条件。' };
      } catch (error) {
        throw offerBrowserError(error,stage);
      } finally { busy = false; }
    },
  };
}
