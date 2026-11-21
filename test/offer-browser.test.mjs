import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {activateOfferHeader,applyOfferFilter,nextOfferPage,offerBrowserError,settleOfferTable} from '../lib/offer-browser.mjs';

test('offer pagination ends on a single page without controls and on a disabled last page', async t => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(1000);
  await page.setContent('<p>总计：8 条 | 1 页</p>');
  assert.equal(await nextOfferPage(page), false);
  await page.setContent('<button onclick="this.disabled=true">下一页</button>');
  assert.equal(await nextOfferPage(page), true);
  assert.equal(await nextOfferPage(page), false);
});

test('offer filters and date sort work with clipped/covered headers and unrelated inputs',async t=>{
  // Local synthetic DOM only; no persistent profile, login or external requests.
  const browser=await chromium.launch({channel:'msedge',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:640,height:480}});
  await page.setContent(`<style>
    .scroll{position:relative;width:320px;overflow:hidden}table{width:1000px;table-layout:fixed}
    .cover{position:absolute;inset:0;z-index:2;background:#eee;opacity:.8}
    .fixed{position:fixed;top:120px;left:0;z-index:9999;background:white}
  </style>
  <table hidden><thead><tr><th><span>职位</span><button class="filter-btn">隐藏副本</button></th></tr></thead></table>
  <div class="scroll"><table><thead><tr>
    <th><span>职位</span><button class="filter-btn" data-column="职位">筛选</button></th>
    <th><span>工作地点</span><button class="filter-btn" data-column="工作地点">筛选</button></th>
    <th><span>更新时间</span><button id="sort">排序</button></th>
  </tr></thead></table><div class="cover">固定列覆盖点击位置</div></div>
  <div class="fixed" hidden><h4></h4><input placeholder="搜索，支持用空格分隔多个关键词"><button id="confirm">确认</button></div>
  <input id="unrelated" value="不要修改"><output id="result"></output><output id="sort-count">0</output>
  <script>
    for(const b of document.querySelectorAll('[data-column]'))b.onclick=()=>{
      document.querySelector('.fixed').hidden=false;
      document.querySelector('h4').textContent='筛选 '+b.dataset.column;
    };
    document.querySelector('#confirm').onclick=()=>{
      document.querySelector('#result').textContent=document.querySelector('h4').textContent+':'+document.querySelector('.fixed input').value;
      document.querySelector('.fixed').hidden=true;
    };
    document.querySelector('#sort').onclick=()=>document.querySelector('#sort-count').textContent=String(Number(document.querySelector('#sort-count').textContent)+1);
  </script>`);
  const old=page.locator('th:visible').filter({has:page.getByText('职位',{exact:true})}).locator('button.filter-btn');
  await old.waitFor({state:'visible'});
  assert.equal(await old.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.classList.contains('cover');}),true);
  await assert.rejects(old.click({timeout:400}),{name:'TimeoutError'});
  assert.equal(await page.locator('.fixed').isVisible(),false);
  await applyOfferFilter(page,'职位','销售');
  assert.equal(await page.locator('#result').innerText(),'筛选 职位:销售');
  await applyOfferFilter(page,'工作地点','上海');
  assert.equal(await page.locator('#result').innerText(),'筛选 工作地点:上海');
  assert.equal(await page.locator('#unrelated').inputValue(),'不要修改');
  await activateOfferHeader(page,'更新时间');await activateOfferHeader(page,'更新时间');
  assert.equal(await page.locator('#sort-count').innerText(),'2');
  await assert.rejects(applyOfferFilter(page,'不存在','词'),/没有可用的/);
});

test('offer failures explain the obstacle without dumping browser details or page content',()=>{
  const error=offerBrowserError(Error('locator.click: Timeout 10000ms exceeded\nsecret-page-content intercepts pointer events'),'设置职位筛选');
  assert.match(error.message,/控件被页面浮层遮挡/);assert.doesNotMatch(error.message,/secret-page-content|locator.click/);
  const known=Object.assign(Error('请先登录'),{status:400});assert.equal(offerBrowserError(known,'登录'),known);
});

test('offer waits for delayed columns and loading completion instead of accepting a stable empty table',async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<div class="ant-spin-spinning">加载中</div><table><thead><tr><th>求职进展</th></tr></thead><tbody></tbody></table><div class="ant-empty">暂无数据</div>');
  let settled=false;
  const waiting=settleOfferTable(page,['招聘公告','更新时间','职位'],6000).then(()=>{settled=true;});
  // The former body-text stability check would have returned after 1.2s.
  await page.waitForTimeout(1400);assert.equal(settled,false);
  await page.evaluate(()=>{document.querySelector('thead tr').innerHTML='<th>招聘公告</th><th>更新时间</th><th><span>职位</span><button class="filter-btn" onclick="this.dataset.activated=\'yes\'">筛选</button></th>';});
  await page.waitForTimeout(700);assert.equal(settled,false,'ready columns do not mean a loading request has finished');
  await page.evaluate(()=>{document.querySelector('.ant-spin-spinning').remove();document.querySelector('.ant-empty').remove();document.querySelector('tbody').innerHTML='<tr><td>合成企业秋招</td><td>2026-09-28</td><td>产品经理</td></tr>';});
  await waiting;await activateOfferHeader(page,'职位',true);
  assert.equal(await page.locator('.filter-btn').getAttribute('data-activated'),'yes');
});

test('offer accepts a loaded empty result and distinguishes missing columns, failed loading and lost access',async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<table><thead><tr><th>招聘公告</th><th>更新时间</th><th>职位</th></tr></thead><tbody></tbody></table><div class="ant-empty">暂无数据</div>');
  await settleOfferTable(page,['招聘公告','更新时间','职位'],3000);
  await assert.rejects(settleOfferTable(page,['不存在'],350),/未加载完整.*不存在/);
  await page.setContent('<div class="ant-message-notice-content">获取导航数据失败</div><table><tr><th>求职进展</th></tr></table>');
  await assert.rejects(settleOfferTable(page,undefined,1000),/表格数据加载失败/);
  await page.setContent('<div class="ant-message-notice-content">需要登录或VIP权限</div>');
  await assert.rejects(settleOfferTable(page,undefined,1000),/没有读取该表格的权限/);
  await page.setContent('<div class="ant-message-notice-content">登录已过期</div>');
  await assert.rejects(settleOfferTable(page,undefined,1000),/登录状态失效/);
});

test('offer header activation waits for rendering but refuses ambiguous visible columns',async t=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();await page.setContent('<table><thead><tr></tr></thead></table>');
  const waiting=activateOfferHeader(page,'职位',true);
  await page.waitForTimeout(250);
  await page.evaluate(()=>{document.querySelector('tr').innerHTML='<th><span>职位</span><button class="filter-btn" onclick="this.dataset.activated=\'yes\'">筛选</button></th>';});
  await waiting;assert.equal(await page.locator('.filter-btn').getAttribute('data-activated'),'yes');
  await page.evaluate(()=>document.querySelector('tr').append(document.querySelector('th').cloneNode(true)));
  await assert.rejects(activateOfferHeader(page,'职位',true),/多个.*表头/);
});
