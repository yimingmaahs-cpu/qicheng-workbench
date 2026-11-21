import test from 'node:test';
import assert from 'node:assert/strict';
import {withJobTypes} from '../lib/job-requirements.mjs';

test('legacy jobs get types from posting evidence independently of the group name or promotional footer',()=>{
  const examples = [
    [{title:'运营',sourceName:'Offer 情报局 · 实习信息汇总'},'internship',''],
    [{title:'运营',category:'校招实习内推合集 · 招聘汇总',sourceName:'Offer 情报局 · 校招实习内推合集'},'',''],
    [{announcement:'示例公司秋招',description:'示例公司秋招\n关注可领取秋招、实习岗位表格'},'','campus'],
    [{description:'招聘公告\n【岗位性质】实习\n招聘类型：校园招聘'},'internship','campus'],
    [{description:'招聘信息\n本次实习招聘涉及市场部'},'internship',''],
    [{title:'社招产品经理',employmentType:'fulltime'},'fulltime','social'],
    [{title:'运营实习生',employmentType:'fulltime',recruitmentType:'social'},'fulltime','social'],
    [{sourceName:'微信群 · 校招实习群',description:'有实习经验者优先'},'',''],
  ];
  for(const [raw,employment,recruitment] of examples){
    const before={...raw},resolved=withJobTypes(raw);
    assert.equal(resolved.employmentType,employment);assert.equal(resolved.recruitmentType,recruitment);
    assert.deepEqual(raw,before);
  }
});

import {createLocal} from '../local-server.mjs';
import {chromium} from 'playwright-core';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('a saved posting and its application show the same types in the grid, board, list and timeline',async t=>{
  const dataDir=mkdtempSync(path.join(tmpdir(),'job-types-'));
  const app=await createLocal({dataDir,tenantOptions:{autoBackups:false}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const base='http://127.0.0.1:'+app.server.address().port;
  async function post(route,body){
    const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Workbench':'1'},body:JSON.stringify(body)});
    assert.ok(r.ok,'POST '+route+' '+r.status);return r.json();
  }
  const {jobs:[job]}=await post('/api/jobs',{company:'测试公司',title:'产品运营',announcement:'校园招聘',sourceName:'Offer 情报局 · 实习信息汇总'});
  await post('/api/jobs/'+job.id+'/progress',{status:'submitted',revision:0});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();await page.goto(base);
    await page.getByRole('button',{name:'我的岗位',exact:true}).click();
    const grid=page.locator('#job-grid');
    assert.equal(await grid.locator('.tabulator-cell[tabulator-field="employmentType"]').innerText(),'实习');
    assert.equal(await grid.locator('.tabulator-cell[tabulator-field="recruitmentType"]').innerText(),'校招 / 应届');
    assert.equal(await grid.locator('.tabulator-col[tabulator-field="salary"], .tabulator-col[tabulator-field="experience"]').count(),0);
    await page.getByRole('button',{name:'投递跟踪',exact:true}).click();
    const expected='实习 · 校招 / 应届';
    await page.locator('.application-card').getByText(expected,{exact:true}).waitFor();
    await page.getByRole('button',{name:'列表',exact:true}).click();
    await page.locator('.application-list').getByText(expected,{exact:true}).waitFor();
    await page.locator('.application-list [data-action="application-detail"]').click();
    await page.locator('#modal').getByText(expected,{exact:false}).first().waitFor();
  }finally{await browser.close();}
});
