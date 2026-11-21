import { normalizeJob, pullConditions, jobFingerprint, platformJobFingerprint, platformJobURLFingerprint } from './jobs.mjs';
import { extractExperience, experienceRequirement, classifyRecruitment, classifyEmployment, requirementFailures } from './job-requirements.mjs';
// BOSS/Zhilian card selectors adapted from JobFindsMe (MIT); see THIRD_PARTY_NOTICES.md.
export const platformPages = {
  boss: { name:'BOSS直聘', login:'https://www.zhipin.com/web/user/', search:'https://www.zhipin.com/web/geek/jobs' },
  zhilian: { name:'智联招聘', login:'https://www.zhaopin.com/', search:'https://www.zhaopin.com/sou' },
  '51job': { name:'前程无忧', login:'https://login.51job.com/', search:'https://we.51job.com/pc/search' },
};
export function platformForJobURL(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
    if (u.hostname === 'www.zhipin.com' && /^\/job_detail\/[\w-]+\.html$/.test(u.pathname)) return 'boss';
    if (['www.zhaopin.com', 'jobs.zhaopin.com', 'xiaoyuan.zhaopin.com'].includes(u.hostname) && /\/jobdetail\/|^\/[\w-]+\.htm[l]?$|\/job\//i.test(u.pathname)) return 'zhilian';
    if ((u.hostname === 'jobs.51job.com' && /^\/[^/]+\/\d+\.html$/.test(u.pathname)) || (u.hostname === 'we.51job.com' && /^\/pc\/jobdetail(?:\/|$)/.test(u.pathname))) return '51job';
  } catch { /* Not a supported job link. */ }
  return '';
}

export function searchQueries(c) {
  const split = value => [...new Set((value || '').split(/[、,，;；\n]+/).map(s => s.trim()).filter(Boolean))];
  const keywords = split(c.keyword), majors = split(c.major);
  const queries = keywords.length ? keywords.flatMap(k => majors.length ? majors.map(m => `${k} ${m}`) : [k]) : majors;
  if (!queries.length || queries.length > 6) throw Object.assign(Error('请填写岗位名称或专业；用顿号分隔，每次最多 6 组搜索。'), { status: 400 });
  return queries;
}

export function recruitmentType(value) {
  if (/非应届|不招应届|不接受应届|非校招/.test(value)) return /社招|社会招聘/.test(value) ? 'social' : '';
  return /校招|校园|应届/.test(value) ? 'campus' : /社招|社会招聘/.test(value) ? 'social' : '';
}

export function map51Jobs(items) {
  const text = v => typeof v === 'string' ? v.trim() : '';
  return items.filter(j => j && typeof j === 'object').map(j => {
    const title = text(j.jobName || j.job_name), category = text(j.jobTypeString || j.jobtype_text);
    const label = v => text(v) || text(v?.name) || text(v?.label);
    const tags = [j.jobTags || j.job_tags || [],j.jobNatureString || j.jobNature || '',category].flat().map(label).filter(Boolean).join('、');
    const experience = text(j.workYearString || j.workyear_text || j.workYearName);
    return { title, jobTags:tags, company: text(j.fullCompanyName || j.companyName || j.company_name), location: text(j.jobAreaString || j.workarea_text), salary: text(j.provideSalaryString || j.providesalary_text), experience, industry: text(j.industryName || j.industry_name), category, description: [text(j.jobDescribe || j.job_describe), experience, category, tags].filter(Boolean).join(' · '), url: text(j.jobHref || j.job_href), sourceUpdatedAt: text(j.issueDateString || j.issue_date || j.updatedate).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '', recruitmentType: classifyRecruitment({title,category,jobTags:tags,experience}) };
  });
}

// Public job fields follow JobFindsMe's MIT BOSS mapping; no account fields are retained.
export function mapBossJobs(items) {
  const text = v => typeof v === 'string' ? v.trim() : '';
  const tags = v => Array.isArray(v) ? v.map(text).filter(Boolean).join('、') : '';
  return items.filter(j => j && typeof j === 'object').map(j => ({
    title:text(j.jobName),company:text(j.brandName),location:[j.cityName,j.areaDistrict,j.businessDistrict].map(text).filter(Boolean).join(' '),
    salary:text(j.salaryDesc),industry:text(j.brandIndustry),category:tags(j.jobLabels),
    description:[text(j.jobExperience),text(j.jobDegree),tags(j.skills),tags(j.welfareList)].filter(Boolean).join(' · '),
    url:/^[\w-]+$/.test(text(j.encryptJobId)) ? `https://www.zhipin.com/job_detail/${j.encryptJobId}.html` : '',
  }));
}

// Runs in the owned browser page. Only visible job cards and their public props are read.
export function readPlatformPage(key) {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const clean = v => (v || '').replace(/\s+/g, ' ').trim();
  const pick = (root, selectors) => {
    for (const selector of selectors.split(',')) {
      const node = [...root.querySelectorAll(selector)].find(visible);
      const value = clean(node?.getAttribute('aria-label') || node?.getAttribute('title') || node?.innerText);
      if (value) return value;
    }
    return '';
  };
  const body = (document.body?.innerText || '').slice(0,30000);
  const blocked = /Security Verification|验证连接安全性|滑动验证|请完成验证|访问过于频繁|安全验证|账号已被限制/i.test(body) || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="verify"]')].some(visible);
  const loginRequired = /passport\.|login\./.test(location.hostname) || [...document.querySelectorAll('input[type="password"],input[type="tel"]')].some(visible) || /登录之后再搜索|请登录后查看职位/.test(body);
  const empty = /暂无相关职位|没有找到相关职位|没有符合条件的职位|暂无搜索结果|未找到相关职位/.test(body);
  const ended = /没有更多职位|暂无更多职位|已到底了/.test(body);
  const selector = key === 'boss' ? '.job-card-wrapper,.job-card-box' : key === 'zhilian' ? '.job-list-panel .job-card,.joblist-box__item,.positionlist__item' : '.joblist-item';
  const cards = [...document.querySelectorAll(selector)].filter(visible), jobs = [];
  const readableCards = key === 'zhilian' ? cards.slice(-200) : cards.slice(0,200);
  for (const card of readableCards) {
    let title, company, url, locationText, salary, industry = '', category = '', experience = '', propTags = [];
    if (key === 'boss') {
      const titleNode = card.querySelector('.job-name,.job-title,.job-info h3')?.cloneNode(true);
      titleNode?.querySelectorAll('.salary,[class*="salary"],[class*="tag"],.job-area').forEach(e => e.remove());
      title = clean(titleNode?.textContent); company = pick(card,'.company-name,.company-info h3,.company-info h4,.boss-name');
      url = card.querySelector('a[href*="/job_detail/"]')?.href || '';
      locationText = pick(card,'.job-area'); salary = pick(card,'.salary');
      industry = pick(card,'.company-tag-list li'); category = pick(card,'.job-info .tag-list,.job-card-footer .tag-list');
    } else if (key === 'zhilian') {
      title = pick(card,'.job-card__title-clamp .vue-clamp__text,.job-card__name,.jobinfo__name');
      company = pick(card,'.job-card__company-name,.companyinfo__name');
      url = card.querySelector('a[href*="/jobdetail/"],a[href*="jobs.zhaopin.com"]')?.href || '';
      // The new Vue JobCard uses a click handler instead of an anchor. Match public props to the visible card.
      const component = card.__vue__, job = component?.$options?.name === 'JobCard' ? component.$props?.job : null;
      if (job && clean(job.companyName) === company && (clean(job.name) === title || /…|\.\.\./.test(title))) {
        title = clean(job.name); if (typeof job.positionUrl === 'string') url ||= job.positionUrl;
        const label = value => typeof value === 'string' ? clean(value) : typeof value?.name === 'string' ? clean(value.name) : typeof value?.label === 'string' ? clean(value.label) : '';
        experience = label(job.workingExp) || label(job.workExperience) || label(job.workingAge);
        salary = label(job.salary);
        propTags = [job.jobType,job.employmentType,job.workType,job.jobNature,job.jobNatureString,job.recruitmentType,job.graduateYear,job.jobTags || []].flat().map(label).filter(Boolean);
      }
      locationText = pick(card,'.job-card__location span[title],.job-card__location,.jobinfo__other-info-item'); salary ||= pick(card,'.job-card__salary,.jobinfo__salary,[class*="salary"]');
      industry = pick(card,'.companyinfo__tag,.job-card__company-type'); category = pick(card,'.job-card__tags,.jobinfo__tag');
      experience ||= pick(card,'.job-card__experience,.job-card__working-exp,.jobinfo__experience');
    } else {
      title = pick(card,'.jname'); company = pick(card,'.cname'); locationText = pick(card,'.area'); salary = pick(card,'.sal');
      url = card.querySelector('a[href*="/pc/jobdetail"],a[href*="jobs.51job.com/"]:not(.comp)')?.href || '';
      industry = pick(card,'.bc .dc'); category = pick(card,'.tags');
      experience = pick(card,'.workyear,.work-year,.experience');
    }
    // Labels may contain icons/formatting. innerText excludes hidden descendants.
    const labels = [...card.querySelectorAll('span,li,div,p')].filter(visible).flatMap(node=>node.innerText.split(/[|｜·\n]/)).map(clean);
    const experienceLabel = /^(?:(?:经验|工作经验|工作年限)[：: ]*)?(?:(?:[\d一二三四五六七八九十两]+(?:\.\d+)?年?[-~～—–至到])?[\d一二三四五六七八九十两]+(?:\.\d+)?年(?:及以上|以上|以下|以内)?(?:经验|工作经验)?|经验不限|不限经验|无需(?:工作)?经验|无经验|应届(?:毕业)?生|在校生[／/]应届生)$/;
    experience ||= labels.find(value=>experienceLabel.test(value)) || '';
    const jobTags = [...new Set([...propTags,category,...labels.filter(value=>experienceLabel.test(value)||/^(?:工作性质\s*[：:]\s*)?(?:校园|校招|校园招聘|社招|社会招聘|全职|兼职|非全职|临时工|小时工|实习(?:生)?|全职实习|(?:20)?\d{2}届(?:毕业生|应届生)?|面向(?:20)?\d{2}届)$/.test(value))].filter(Boolean))].join('、');
    if (title && company && url) jobs.push({ title, company, url, location: locationText, salary: /[\uE000-\uF8FF]/.test(salary) ? '' : salary, experience, jobTags, industry, category, description: clean(card.innerText).slice(0,6000) });
  }
  const input = document.querySelector('input.query-sug__input,input.query-search__content-input,input[placeholder="搜索职位、公司"],input[placeholder="请输入公司/职位"],input[name="query"]');
  const list = key === 'zhilian' ? document.querySelector('.job-list-panel')?.__vue__ : null;
  const listProps = list?.$options?.name === 'JobListPanel' ? list.$props : null;
  // Changing filters uses a separate overlay while the old list's loading prop stays false.
  const loading = !!(listProps?.loading || listProps?.loadingMore) || key === 'zhilian' && [...document.querySelectorAll('.search-page-loading')].some(visible);
  const listLoginGate = key === 'zhilian' && [...document.querySelectorAll('.job-list-login-gate')].some(visible);
  const listEnded = key === 'zhilian' && [...document.querySelectorAll('.job-list-panel__status')].filter(visible).some(e=>/没有更多了|没有更多职位/.test(e.innerText));
  // hasMore=false is also used by the site for login restrictions and failed requests.
  return { jobs, blocked, loginRequired, listLoginRequired: !loading && listLoginGate, empty, ended: !loading && !listLoginGate && (listEnded || (!listProps && ended)), loading, cards: cards.length, searchKeyword: input?.value || '', url: location.href };
}

export async function selectZhilianLocation(page, locationText) {
  // Use the site's region search, which supplies city/district codes and updates jl/re.
  // The header's city channel is independent: jl=489 means nationwide, not Chongqing.
  const name = locationText.trim().replace(/市$/,'');
  const box = page.locator('.filter-region-box:visible').first();
  try {
    await box.locator('.filter-select-box__trigger').click({timeout:10000});
    const dialog = page.locator('.s-dialog:visible').filter({has:page.locator('input[placeholder="搜索城市名/区县"]')}).first();
    await dialog.locator('input[placeholder="搜索城市名/区县"]').fill(name,{timeout:5000});
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const option = dialog.locator('.s-option__label:visible').filter({hasText:new RegExp('^\\s*'+escaped+'市?\\s*$')});
    await option.first().waitFor({state:'visible',timeout:10000});
    if (await option.count() !== 1) throw Error('地区名称有多个匹配项');
    await option.click({timeout:5000});
    await page.waitForFunction(expected => {
      const label = document.querySelector('.filter-region-box .filter-select-box__label')?.textContent.trim().replace(/市$/,'');
      const code = new URL(location.href).searchParams.get('jl');
      return label === expected && code && code !== '489';
    },name,{timeout:10000});
    const url = new URL(page.url());
    return {city:url.searchParams.get('jl'),district:url.searchParams.get('re') || '',name};
  } catch {
    throw Object.assign(Error('智联招聘未能确认地区“'+locationText+'”。请在保留的窗口检查登录、验证或地区选择；地点请填写官网可选的城市或区县名称。本次没有把全国结果当成本地结果。'),{status:400,requiresAction:true});
  }
}

export function advancePlatformPage(key) {
  const selectors = key === 'zhilian' ? '.soupager__btn--next,.soupager a.soupager__btn:not(.soupager__btn__before),.soupager .next,.pagination .next,.el-pagination .btn-next' : key === '51job' ? '.el-pagination .btn-next' : '';
  const next = selectors && document.querySelector(selectors);
  if (next && !next.matches('[disabled],.disabled,.soupager__btn--disable,[aria-disabled="true"]')) { next.click(); return true; }
  const cards = key === 'boss' ? '.job-card-wrapper,.job-card-box' : key === 'zhilian' && /^\/jobs\/?$/.test(location.pathname) ? '.job-list-panel .job-card' : '';
  if (!cards) return false;
  const list = key === 'zhilian' ? document.querySelector('.job-list-panel')?.__vue__ : null;
  const canLoadMore = list?.$options?.name === 'JobListPanel' && list.$props?.hasMore === true && !list.$props.loading && !list.$props.loadingMore;
  let node = document.querySelector(cards)?.parentElement;
  while (node) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 4) {
      const before = node.scrollTop;
      if (key === 'zhilian') node.scrollTo({top:node.scrollHeight,behavior:'instant'});
      else node.scrollBy(0,Math.max(240,node.clientHeight*.8));
      if (before === node.scrollTop && canLoadMore) { node.dispatchEvent(new Event('scroll')); return true; }
      return before !== node.scrollTop;
    }
    node = node.parentElement;
  }
  const before = scrollY;
  // Zhilian loads at the page bottom; one viewport step may leave all 20 cards unchanged.
  if (key === 'zhilian') scrollTo({top:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),behavior:'instant'});
  else scrollBy(0,Math.max(240,innerHeight*.8));
  // A short list or scroll anchoring can leave us already at the bottom. Ask the
  // normal scroll handler to load; the collector still bounds retries and waits for new cards.
  if (before === scrollY && canLoadMore) { window.dispatchEvent(new Event('scroll')); return true; }
  return before !== scrollY;
}

export async function searchBossHomepage(page, query) {
  // Use the site's visible GET search form when a direct SPA navigation returns home.
  // Never submit a login form or accept homepage recommendations as search results.
  const form = page.locator('form[action="/web/geek/jobs"]:visible,form[action="https://www.zhipin.com/web/geek/jobs"]:visible').filter({has:page.locator('input[name="query"]:visible')}).first();
  if (!await form.isVisible()) return false;
  try { await form.locator('input[name="query"]:visible').first().fill(query,{timeout:5000}); }
  catch { throw Object.assign(Error('BOSS直聘首页搜索框未能填写，请查看保留的窗口是否有遮挡或页面跳转。'),{status:400,requiresAction:true}); }
  try { await form.locator('button.btn-search:visible').first().click({timeout:10000}); }
  catch { throw Object.assign(Error('BOSS直聘首页搜索按钮未能完成操作，请查看保留的窗口提示。'),{status:400,requiresAction:true}); }
  return true;
}

export function isSearchResult(snapshot, key, query) {
  try {
    const actual = new URL(snapshot.url), expected = new URL(platformPages[key].search);
    const correctPath = key === 'zhilian' ? /^\/sou(?:\/|$)/.test(actual.pathname) || /^\/jobs\/?$/.test(actual.pathname) : actual.pathname.replace(/\/$/,'') === expected.pathname;
    const queryKey = key === 'boss' ? 'query' : key === 'zhilian' ? 'kw' : 'keyword';
    return actual.origin === expected.origin && correctPath && (actual.searchParams.get(queryKey) === query || snapshot.searchKeyword?.trim() === query);
  } catch { return false; }
}

export async function collectPlatformJobs(page,key,input,onProgress = () => {},isClosed = () => false,existingJob = () => null) {
  const fail = message => Object.assign(Error(message),{status:400});
  const c = pullConditions(input), p = platformPages[key], queries = searchQueries(c);
  const clean = v => typeof v === 'string' ? v.replace(/\s+/g,' ').trim() : '';
  const matches = (v,f) => !f || clean(v).toLowerCase().includes(f.toLowerCase());
  const unique = new Map(), identities = new Set(), seen = new Set(), warnings = new Set(), queryResults = [];
  const filterReasons = {};
  let activeJobs = [], scanned = 0, invalid = 0, filtered = 0, skippedExisting = 0, skippedDeleted = 0;
  const addRows = rows => {
    for (const row of rows) {
      const rowKey = JSON.stringify([row.url,row.title,row.company,row.location]);
      if (seen.has(rowKey)) continue; seen.add(rowKey); scanned++;
      try {
        const link = new URL(row.url,p.search);
        // Zhilian's public search cards still emit HTTP links to HTTPS-capable job pages.
        if (key === 'zhilian' && link.protocol === 'http:' && ['www.zhaopin.com','jobs.zhaopin.com'].includes(link.hostname) && !link.port) link.protocol = 'https:';
        const url = link.href;
        if (platformForJobURL(url) !== key) throw fail('岗位链接缺失或不属于此平台。');
        const fields = Object.fromEntries(Object.entries({title:160,company:160,location:200,salary:200,experience:100,jobTags:2000,category:100,industry:150,description:30000}).map(([f,max]) => [f,clean(row[f]).slice(0,max)]));
        const experienceEvidence = [extractExperience(fields.description),...fields.jobTags.split(/[、,，;；|｜]/).map(value=>extractExperience(value.trim()))].filter(Boolean).sort((a,b)=>(experienceRequirement(b)?.min ?? -1)-(experienceRequirement(a)?.min ?? -1));
        const describedExperience = experienceEvidence[0] || '';
        if (experienceRequirement(describedExperience)?.min > (experienceRequirement(fields.experience)?.min ?? -1)) {
          fields.experience = [describedExperience, fields.experience].filter(Boolean).join('；').slice(0,100);
        } else fields.experience ||= describedExperience;
        const type = key === 'boss' ? row.recruitmentType || recruitmentType([row.title,row.category,row.description].join(' ')) : classifyRecruitment({...row,...fields,experience:[...experienceEvidence,fields.experience].join('；')});
        const job = normalizeJob({ ...row,...fields,url,sourceName:p.name,recruitmentType:type,employmentType:classifyEmployment({...row,...fields}) });
        const failures = requirementFailures(job,c);
        if (!matches(job.industry,c.industry)) failures.push('行业');
        if (!matches(job.location,key === 'zhilian' ? c.location.replace(/[市区县]$/,'') : c.location)) failures.push('地点');
        if ((c.from && job.sourceUpdatedAt < c.from) || (c.to && (!job.sourceUpdatedAt || job.sourceUpdatedAt > c.to))) failures.push('更新时间');
        if (failures.length) { filtered++; for (const reason of failures) filterReasons[reason] = (filterReasons[reason] || 0) + 1; continue; }
        const existing=existingJob(job);
        if(existing){if(existing.deletedAt)skippedDeleted++;else skippedExisting++;continue;}
        const keys = [platformJobFingerprint(job),platformJobURLFingerprint(job),jobFingerprint(job)].filter(Boolean);
        if (!keys.some(identity=>identities.has(identity))) { unique.set(keys[0],job); activeJobs.push(job); }
        keys.forEach(identity=>identities.add(identity));
      } catch (error) { if (error.status !== 400 && !(error instanceof TypeError)) throw error; invalid++; }
    }
  };
  // Observe the platform page's own requests; never synthesize internal API calls.
  let received = [], generation = 0, activeQuery = '', responseError = '', responseEmpty = false, responseCount = 0, pendingBodies = 0;
  let zhilianRequest = null, zhilianPending = false;
  const requests = new WeakMap();
  const onRequest = request => {
    requests.set(request,generation);
    if (key !== 'zhilian' || request.url?.() !== 'https://fe-api.zhaopin.com/c/i/search/positions') return;
    let query; try { query = request.postDataJSON()?.S_SOU_FULL_INDEX; } catch { return; }
    if (query !== activeQuery) return;
    zhilianRequest = request; zhilianPending = true; responseError = '';
  };
  const onRequestFailed = request => {
    if (request !== zhilianRequest || requests.get(request) !== generation) return;
    zhilianPending = false;
    responseError = '智联招聘列表请求失败，不能把当前首批岗位当作全部结果；请检查保留的窗口后重试。';
  };
  const listener = response => {
    const u = new URL(response.url());
    if (key === 'zhilian' && response.request?.() === zhilianRequest && zhilianRequest && requests.get(zhilianRequest) === generation) {
      const current = generation, request = zhilianRequest;
      void response.json().then(payload => {
        if (current !== generation || request !== zhilianRequest) return;
        if (response.status() !== 200 || payload?.code !== 200) responseError = '智联招聘列表请求未成功（HTTP '+response.status()+'，返回码 '+(Number.isSafeInteger(payload?.code)?payload.code:'未知')+'），本次停止，不能把已显示的岗位当作全部结果。';
        else if (payload.data?.isVerification === 1) responseError = '智联招聘列表要求安全验证，请在保留的采集窗口完成验证后重试。';
        else if (!Array.isArray(payload.data?.list)) responseError = '智联招聘列表响应结构无法识别，本次停止以避免将旧列表当作新结果。';
      }).catch(()=>{ if(current === generation && request === zhilianRequest) responseError = '智联招聘列表响应未能读取，本次停止以避免将旧列表当作新结果。'; })
        .finally(()=>{ if(current === generation && request === zhilianRequest) zhilianPending = false; });
      return;
    }
    const boss = key === 'boss' && u.origin === 'https://www.zhipin.com' && u.pathname === '/wapi/zpgeek/search/joblist.json';
    if (!boss && (key !== '51job' || u.origin !== 'https://we.51job.com' || u.pathname !== '/api/job/search-pc')) return;
    const request = response.request?.();
    if (request && requests.get(request) !== generation) return;
    const queryKey = boss ? 'query' : 'keyword';
    let query = u.searchParams.get(queryKey);
    if (query === null) { try { query = request?.postDataJSON()?.[queryKey]; } catch {} }
    if ((boss || query != null) && query !== activeQuery) return;
    const current = generation;
    responseCount++;
    if (boss && [403,429].includes(response.status())) {
      responseError = response.status() === 429 ? 'BOSS直聘岗位接口明确限流（HTTP 429），本次采集已停止。' : 'BOSS直聘岗位接口拒绝访问（HTTP 403），本次采集已停止；仅凭此状态不能确定是否为账号风控。';
      return;
    }
    pendingBodies++;
    void response.json().then(payload => {
      if (current !== generation) return;
      if (boss) {
        const message = typeof payload?.message === 'string' ? payload.message : '';
        const evidence = message.match(/访问过于频繁|请求过于频繁|操作过于频繁|安全验证|滑动验证|请完成验证|账号已被限制|访问受限|异常访问|验证码/);
        if (evidence) { responseError = 'BOSS直聘岗位接口要求验证或限制访问（' + evidence[0] + '），本次采集已停止。'; return; }
        if (payload?.code !== 0) {
          const code = Number.isSafeInteger(payload?.code) ? payload.code : '未知';
          responseError = 'BOSS直聘岗位接口未成功（返回码 ' + code + '），尚不能判定为风控。'; return;
        }
        const items = payload?.zpData?.jobList;
        if (Array.isArray(items)) { received.push(...mapBossJobs(items.slice(0,100))); responseEmpty = items.length === 0; }
        else responseError = 'BOSS直聘岗位接口返回了未知数据结构，尚不能判定为风控。';
        return;
      }
      const items = payload?.resultbody?.job?.items;
      if (Array.isArray(items)) { received.push(...map51Jobs(items.slice(0,100))); responseEmpty = items.length === 0; }
      else responseError = '前程无忧岗位接口返回了未知数据结构，本次停止以避免遗漏筛选字段。';
    }).catch(() => { if (current === generation) responseError = p.name + '岗位接口未返回可解析的数据，尚不能判定为风控。'; }).finally(() => { if (current === generation) pendingBodies--; });
  };
  const check = snapshot => {
    if (responseError) throw Object.assign(fail(responseError),{requiresAction:true});
    if (snapshot.blocked || snapshot.loginRequired) throw Object.assign(fail(p.name + (snapshot.blocked ? '要求安全验证，请在保留的采集窗口完成验证，再重试。' : '需要登录，请在采集窗口登录后重试。')),{requiresAction:true});
  };
  page.on('request',onRequest); page.on('response',listener); page.on('requestfailed',onRequestFailed);
  try {
    for (const [queryIndex, query] of queries.entries()) {
      if (isClosed()) throw fail('采集服务已停止。');
      // Give each query its own bounded pass; the first major must not consume the whole result limit.
      const deadline = Date.now() + 90000, queryLimit = Math.ceil(c.limit / queries.length);
      activeJobs = []; queryResults.push({query,jobs:activeJobs});
      generation++; received = []; activeQuery = query; responseError = ''; responseEmpty = false; responseCount = 0; pendingBodies = 0;
      zhilianRequest = null; zhilianPending = false;
      const url = new URL(p.search); url.searchParams.set(key === 'boss' ? 'query' : key === 'zhilian' ? 'kw' : 'keyword',query);
      if (key === 'boss') url.searchParams.set('city','100010000');
      if (key === '51job') url.searchParams.set('jobArea','000000');
      onProgress('正在搜索 ' + (queryIndex+1) + '/' + queries.length + '：' + query);
      await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:30000});
      let noGrowth = 0, homeSearchTried = false, previousCards = '', region = null;
      const batchLimit = key === 'zhilian' ? 20 : 7;
      for (let batch = 0; batch < batchLimit && activeJobs.length < queryLimit && Date.now() < deadline; batch++) {
        let snapshot;
        for (let poll = 0; poll < 12; poll++) {
          if (isClosed()) throw fail('采集服务已停止。');
          try { snapshot = await page.evaluate(readPlatformPage,key); }
          catch (error) {
            if (poll < 11 && /Execution context was destroyed|Cannot find context with specified id/.test(error.message)) { await page.waitForTimeout(500); continue; }
            throw error;
          }
          check(snapshot);
          if (key === 'zhilian' && c.location && !region && isSearchResult(snapshot,key,query)) {
            onProgress('正在官网选择地区：'+c.location);
            region = await selectZhilianLocation(page,c.location);
            await page.waitForTimeout(1000);
            continue;
          }
          if (key === 'boss' && snapshot.url === 'https://www.zhipin.com/' && !homeSearchTried) {
            homeSearchTried = true;
            onProgress('搜索跳回首页，正在通过官网搜索框重新搜索 ' + query);
            if (await searchBossHomepage(page,query)) { await page.waitForTimeout(1000); continue; }
          }
          if (!pendingBodies && !zhilianPending && !snapshot.loading && !snapshot.listLoginRequired && (snapshot.jobs.length && JSON.stringify(snapshot.jobs) !== previousCards || received.length || snapshot.empty || responseEmpty)) break;
          await page.waitForTimeout(1000);
        }
        check(snapshot);
        if (snapshot.loading || zhilianPending) throw Object.assign(fail(p.name+'岗位列表仍在加载，本次停止以避免读取旧结果；请稍后重试。'),{requiresAction:true});
        if (snapshot.listLoginRequired) throw Object.assign(fail('智联招聘列表显示“登录查看更多相关职位”，当前只开放首批 '+(snapshot.cards || snapshot.jobs.length)+' 条。请在保留的采集窗口完成登录后重新拉取；顶部显示头像不代表搜索列表登录状态有效。'),{requiresAction:true});
        if (key === 'zhilian' && c.location) {
          const actual = new URL(snapshot.url);
          if (!region || actual.searchParams.get('jl') !== region.city || (actual.searchParams.get('re') || '') !== region.district) throw Object.assign(fail('智联招聘地区条件未保持为“'+c.location+'”，已停止读取，避免导入其他地区结果。'),{requiresAction:true});
        }
        if (pendingBodies) throw Object.assign(fail(p.name + '岗位响应尚未读取完成，本次停止以避免误读；尚不能判定为风控。'),{requiresAction:true});
        if (!isSearchResult(snapshot,key,query)) {
          let where = ''; try { const u = new URL(snapshot.url); where = ' 当前页面：' + u.origin + u.pathname + '；已识别 ' + snapshot.jobs.length + ' 条岗位。'; } catch {}
          throw Object.assign(fail(p.name + (homeSearchTried ? '通过官网搜索框重试后仍未进入搜索结果页，自动采集已暂停；请查看保留的窗口提示。' : '未停留在本次搜索结果页，已停止读取；请检查保留的窗口后重试。') + where),{requiresAction:true});
        }
        if (!snapshot.jobs.length && !received.length && !snapshot.empty && !responseEmpty) throw fail(p.name + '搜索页未返回可识别岗位（页面卡片 ' + (snapshot.cards || 0) + '，匹配的列表响应 ' + responseCount + '）。尚不能判定为风控；已保留窗口，请查看实际提示。');
        if (snapshot.searchKeyword && snapshot.searchKeyword.trim() !== query) throw fail(p.name + '页面搜索词与本次条件不同，已停止读取，避免导入推荐岗位。');
        const currentCards = JSON.stringify(snapshot.jobs);
        if (currentCards === previousCards && !received.length && !snapshot.empty && !responseEmpty) {
          warnings.add('搜索“' + query + '”翻页后列表未更新，已停止继续翻页；保留此前读取的岗位。');
          break;
        }
        // Keep BOSS's existing incremental-scroll policy; this wait guards the two target platforms.
        previousCards = key === 'boss' ? '' : currentCards;
        const before = seen.size;
        const rows = new Map();
        for (const row of [...snapshot.jobs,...received.splice(0)]) {
          const identity = platformJobURLFingerprint(row) || row.url || JSON.stringify([row.title,row.company,row.location]);
          const previous = rows.get(identity);
          const merged = {...previous,...Object.fromEntries(Object.entries(row).filter(([,value])=>value !== '' && value !== undefined))};
          // Both sources are evidence: an API's "无需经验" must not erase a stricter visible requirement.
          if (previous) {
            merged.url = previous.url;
            merged.description = [...new Set([previous.description,row.description].map(clean).filter(Boolean))].join('\n');
            merged.experience = [...new Set([previous.experience,row.experience].map(clean).filter(Boolean))].sort((a,b)=>(experienceRequirement(b)?.min ?? -1)-(experienceRequirement(a)?.min ?? -1)).join('；');
            merged.jobTags = [...new Set([previous.jobTags,row.jobTags,previous.employmentType === 'internship' ? '实习' : ''].map(clean).filter(Boolean))].join('、');
            if (previous.recruitmentType === 'social') merged.recruitmentType = 'social';
          }
          rows.set(identity,merged);
        }
        addRows([...rows.values()]);
        noGrowth = seen.size === before ? noGrowth + 1 : 0;
        onProgress('搜索 ' + (queryIndex+1) + '/' + queries.length + '：' + query + '；本组新增候选 ' + activeJobs.length + ' 条，累计读取 ' + scanned + ' 条');
        if (snapshot.empty || responseEmpty || snapshot.ended) {
          warnings.add('搜索“'+query+'”'+(snapshot.ended?'官网显示“没有更多职位”':'官网返回空结果')+'，已结束本组读取；设置上限 '+c.limit+' 不代表网站实际返回条数。');
          break;
        }
        if (activeJobs.length >= queryLimit) break;
        if (batch === batchLimit-1) { warnings.add('搜索“'+query+'”达到本组 '+batchLimit+' 批读取上限，未遍历全部岗位。'); break; }
        if (noGrowth >= 2 || !await page.evaluate(advancePlatformPage,key)) { warnings.add('已读取当前可访问的结果，未继续翻页；不代表平台全部岗位。'); break; }
        await page.waitForTimeout(1800);
      }
      if (Date.now() >= deadline) warnings.add('搜索“' + query + '”达到本组时间上限。');
    }
    if (invalid) warnings.add('已跳过 ' + invalid + ' 条字段或链接异常的岗位。');
    if (filtered) warnings.add('有 ' + filtered + ' 条不符合筛选条件。');
    if (filtered) warnings.add('排除原因（同一岗位可计入多项）：' + Object.entries(filterReasons).map(([reason,count])=>reason+' '+count+' 条').join('；')+'。');
    if (filtered && !unique.size) warnings.add('已读取的岗位中没有符合全部条件的新增岗位，不代表平台没有符合岗位；缺少所选条件需要的标签、薪资或经验信息时不会按符合处理。');
    const jobs = [];
    for (let index = 0; jobs.length < c.limit && queryResults.some(result=>result.jobs[index]); index++) {
      for (const result of queryResults) { if (result.jobs[index] && jobs.length < c.limit) jobs.push(result.jobs[index]); }
    }
    const searches = queryResults.map(result=>({query:result.query,candidates:result.jobs.length,returned:result.jobs.filter(job=>jobs.includes(job)).length}));
    if (queries.length > 1) warnings.add('已逐组搜索：' + searches.map(result=>result.query+'（候选 '+result.candidates+' 条，保留 '+result.returned+' 条）').join('；')+'。');
    return { jobs,searches,scanned,skipped:invalid,filtered,filterReasons,skippedExisting,skippedDeleted,duplicates:scanned-invalid-filtered-skippedExisting-skippedDeleted-unique.size,limited:Math.max(0,unique.size-jobs.length),warning:[...warnings].join('') };
  } finally { generation++; page.off('request',onRequest); page.off('response',listener); page.off('requestfailed',onRequestFailed); }
}
