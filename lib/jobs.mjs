import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export const APPLICATION_STATUSES = { preparing: '准备投递', submitted: '已投递', communicating: '沟通中', assessment: '笔试/测评', interview: '面试中', offer: '收到 Offer', rejected: '未通过', withdrawn: '已撤回' };
const fail = message => Object.assign(new Error(message), { status: 400 });
export function field(value, max, label, required = false) {
  if (value !== undefined && typeof value !== 'string') throw fail(`${label}须为文字。`);
  const text = (value || '').trim();
  if ((required && !text) || text.length > max) throw fail(`请填写${label}，最多 ${max} 字。`);
  return text;
}
export function jobURL(value, required = false) {
  const raw = field(value, 2000, '链接', required); if (!raw) return '';
  let url; try { url = new URL(raw); } catch { throw fail('请输入完整的 HTTP / HTTPS 链接。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('链接只支持无账号密码的 HTTP / HTTPS 地址。');
  return url.href;
}
export function normalizeJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('岗位格式无效。');
  const recordType = input.recordType === undefined ? '' : field(input.recordType, 20, '记录类型');
  if (recordType && !['announcement', 'position'].includes(recordType)) throw fail('请选择招聘公告或具体岗位。');
  const announcementId = field(input.announcementId, 50, '公告编号');
  if (announcementId && (!/^[a-f0-9-]{36}$/.test(announcementId) || recordType !== 'position')) throw fail('公告关系格式无效。');
  const recruitmentType = field(input.recruitmentType, 20, '招聘类型');
  if (recruitmentType && !['campus', 'social'].includes(recruitmentType)) throw fail('招聘类型无效。');
  const employmentType = field(input.employmentType, 20, '工作性质');
  if (employmentType && !['internship', 'fulltime'].includes(employmentType)) throw fail('工作性质无效。');
  const wechat = ['wechat','qq'].includes(input.sourceType) || (typeof input.sourceName === 'string' && input.sourceName.startsWith('微信群 · '));
  return { employmentType, jobTags: field(input.jobTags, 2000, '岗位标签'), ...(recordType ? { recordType, ...(announcementId ? { announcementId } : {}) } : {}), ...(wechat ? { sourceType: input.sourceType === 'qq' ? 'qq' : 'wechat' } : {}), ...(input.recruitmentType !== undefined ? { recruitmentType } : {}), title: field(input.title, recordType === 'announcement' ? 500 : 160, recordType === 'announcement' ? '公告名称' : '岗位名称', !wechat || !!recordType), company: field(input.company, 160, '公司名称', !wechat && !recordType), location: field(input.location, 200, '工作地点'), category: field(input.category, 100, '岗位类型'), salary: field(input.salary, 200, '薪资'), experience: field(input.experience, 100, '工作年限'), description: field(input.description, 30000, '岗位描述', wechat && !recordType), url: jobURL(input.url), sourceName: field(input.sourceName, 120, '来源名称') || '手动录入', deadline: dateValue(input.deadline, true), notes: field(input.notes, 5000, '备注'), appliedPosition: field(input.appliedPosition, 1000, '投递岗位'), batch: field(input.batch, 100, '招聘批次'), announcement: field(input.announcement, 500, '招聘公告'), companyType: field(input.companyType, 100, '企业性质'), industry: field(input.industry, 150, '行业'), announcementUrl: jobURL(input.announcementUrl), sourceUpdatedAt: dateValue(input.sourceUpdatedAt, true) };
}
export function pullConditions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('拉取条件须为有效对象。');
  if (input.limit !== undefined && !['string', 'number'].includes(typeof input.limit)) throw fail('拉取条数须为数字。');
  const limit = input.limit === '' || input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw fail('拉取条数须为 1 至 200 的整数。');
  const from = dateValue(input.from, true), to = dateValue(input.to, true);
  if (from && to && from > to) throw fail('开始日期不能晚于结束日期。');
  const table = field(input.table, 40, '表格') || '秋招汇总';
  if (!['秋招汇总', '实习信息汇总', '26届25届信息汇总', '社招国央企&事业单位&高校', '校招实习内推合集'].includes(table)) throw fail('请选择支持的招聘表格。');
  const recruitmentType = field(input.recruitmentType, 20, '招聘类型');
  if (recruitmentType && !['campus', 'social'].includes(recruitmentType)) throw fail('招聘类型无效。');
  const savedEmploymentType = field(input.employmentType, 20, '工作性质');
  const employmentType = savedEmploymentType === 'fulltime_or_unknown' ? 'fulltime' : savedEmploymentType;
  if (employmentType && !['internship', 'fulltime'].includes(employmentType)) throw fail('工作性质无效。');
  const number = (key, label, max) => {
    const value = input[key];
    if (value === undefined || value === '') return '';
    if (!['string', 'number'].includes(typeof value) || typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) throw fail(label + '须为非负数字。');
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > max) throw fail(label + '超出有效范围。');
    return n;
  };
  const salaryMin = number('salaryMin', '月薪下限', 10000000), salaryMax = number('salaryMax', '月薪上限', 10000000), experienceMax = number('experienceMax', '可接受的最低经验要求', 50);
  if (salaryMin !== '' && salaryMax !== '' && salaryMin > salaryMax) throw fail('月薪下限不能高于上限。');
  return { salaryMin, salaryMax, experienceMax, employmentType, keyword: field(input.keyword, 100, '岗位关键词'), major: field(input.major, 100, '专业'), industry: field(input.industry, 150, '行业'), recruitmentType, location: field(input.location, 100, '地点'), limit, from, to, table };
}
export function filterPulledJobs(jobs, conditions) {
  const c = pullConditions(conditions);
  return jobs.filter(j => (!c.keyword || j.title.toLowerCase().includes(c.keyword.toLowerCase())) && (!c.location || j.location.toLowerCase().includes(c.location.toLowerCase())) && (!c.from || (j.sourceUpdatedAt && j.sourceUpdatedAt >= c.from)) && (!c.to || (j.sourceUpdatedAt && j.sourceUpdatedAt <= c.to))).slice(0, c.limit);
}
export function dateValue(value, day = false) {
  if (value === '' || value === undefined) return '';
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('日期格式无效。');
  if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)) throw fail('截止日期格式无效。');
  if (!day) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || Number(value.slice(11,13))>23) throw fail('请填写含时区的有效提醒时间。');
    dateValue(value.slice(0,10),true);
  }
  return day ? value : new Date(value).toISOString();
}
const platformJobSources = new Set(['BOSS直聘', '智联招聘', '前程无忧']);
export function platformJobURLFingerprint(job) {
  if (job.recordType === 'announcement' || job.announcementId || !job.url) return '';
  try {
    const u = new URL(job.url); if(u.protocol!=='https:'||u.port||u.username||u.password)return '';
    let id;
    if(u.hostname==='www.zhipin.com')id=u.pathname.match(/^\/job_detail\/([\w-]+)\.html$/)?.[1];
    else if(u.hostname==='jobs.51job.com')id=u.pathname.match(/^\/[^/]+\/(\d+)\.html$/)?.[1];
    else if(['www.zhaopin.com','jobs.zhaopin.com'].includes(u.hostname))id=u.pathname.match(/^\/jobdetail\/([\w-]+)\.html?$/i)?.[1];
    if(!id)return '';
    const platform=u.hostname.includes('zhaopin.com')?'zhilian':u.hostname.includes('51job.com')?'51job':'boss';
    return createHash('sha256').update(JSON.stringify(['platform-url-v1',platform,id])).digest('hex');
  } catch { return ''; }
}
export function platformJobFingerprint(job) {
  if (!platformJobSources.has(job.sourceName) || !job.company || !job.title || !job.location || job.recordType === 'announcement' || job.announcementId) return '';
  const compact = value => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
  // Keep unknown locations, separate notices, and campus/social roles distinct.
  return createHash('sha256').update(JSON.stringify(['platform-job-v1', ...[job.company, job.title, job.location].map(compact), job.recruitmentType || '', ...(job.employmentType ? [job.employmentType] : [])])).digest('hex');
}
export function jobFingerprint(job) {
  let url = job.url;
  if (url) { const u = new URL(url); u.hash = ''; for (const key of [...u.searchParams.keys()]) if (/^(utm_|spm$|from$)/i.test(key)) u.searchParams.delete(key); u.searchParams.sort(); url = u.href.replace(/\/$/, ''); }
  const identity = [job.company.toLowerCase(), job.title.toLowerCase(), job.location.toLowerCase(), url];
  // Keep explicit positions distinct from their announcement and other notices.
  // Legacy fingerprints are deliberately unchanged to preserve import history.
  if (job.recordType) identity.push(job.recordType, job.announcementId || '');
  // Unidentified WeChat announcements must not collapse into one empty-field job.
  if (!job.recordType && ['wechat','qq'].includes(job.sourceType) && (!job.company || !job.title)) identity.push(job.description.normalize('NFKC').replace(/\s+/g, '').toLowerCase());
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function publicAddress(address) {
  if (isIP(address) === 4) { const [a, b] = address.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))); }
  // Public IPv6 global unicast only. IPv4-mapped and local addresses are rejected.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:(?:db8|0|10|20):/i.test(address) && !/^2002:/i.test(address);
}
export async function fetchJobSource(raw, redirects = 0, options = {}) {
  const url = new URL(jobURL(raw, true));
  if(options.httpsOnly && url.protocol!=='https:')throw fail('订阅地址及重定向必须使用 HTTPS。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  // Some local proxies return Fake-IP addresses. Resolve a real public destination
  // instead of allowing the reserved proxy range through the network guard.
  if (!isIP(hostname) && addresses.length && addresses.every(a => /^198\.(18|19)\./.test(a.address))) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw fail('代理 DNS 解析失败，请稍后重试。');
    const answer = await response.json();
    addresses = answer.Status === 0 && Array.isArray(answer.Answer) ? answer.Answer.filter(a => a.type === 1 && isIP(a.data) === 4).map(a => ({ address: a.data, family: 4 })) : [];
  }
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw fail('岗位拉取仅支持公网地址，不访问本机或内网。');
  const address = addresses[0];
  const result = await new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json, text/html;q=0.9', 'User-Agent': 'OfferWorkbench/0.1' }, lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); resolve({ redirect: res.headers.location }); return; }
      if (res.statusCode !== 200) { res.resume(); reject(fail(`来源返回 HTTP ${res.statusCode}，可能需要登录或不支持直接拉取。`)); return; }
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { req.destroy(fail('来源内容超过 2 MB，请使用单个岗位页面或较小的数据源。')); return; } chunks.push(chunk); });
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), url: url.href })); res.on('error', reject);
    }); req.on('error', reject);
  });
  if (result.redirect) { if (redirects >= 3) throw fail('来源重定向次数过多。'); return fetchJobSource(new URL(result.redirect, url).href, redirects + 1, options); }
  if (!result.text) throw fail('来源未返回可读取的岗位内容。');
  return result;
}
function plainHTML(value) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/(?:p|div|li)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:\d+|x[\da-f]+);/gi, token => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    if (named[token.toLowerCase()]) return named[token.toLowerCase()];
    const hex = token[2].toLowerCase() === 'x', number = parseInt(token.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).trim();
}
export function parseJobSource(text, baseURL, sourceName = '') {
  let records; let schema = false;
  try { const data = JSON.parse(text); records = Array.isArray(data) ? data : data.jobs; if (!records) { records = [data]; schema = true; } } catch {
    schema = true; records = [];
    for (const match of text.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { records.push(JSON.parse(match[1])); } catch { /* Ignore malformed unrelated metadata. */ } }
  }
  if (!Array.isArray(records)) throw fail('JSON 数据源须为岗位数组或包含 jobs 数组。');
  if (schema) {
    const found = [];
    function visit(value, depth = 0) { if (!value || typeof value !== 'object' || depth > 20) return; if ([value['@type']].flat().includes('JobPosting')) found.push(value); else for (const child of Object.values(value)) if (typeof child === 'object') visit(child, depth + 1); }
    visit(records); records = found;
  }
  if (!records.length) throw fail('未识别到公开岗位数据。该页面可能需要登录或由浏览器动态加载，请复制岗位 JD 后手动录入。');
  if (records.length > 200) throw fail('单次最多拉取 200 个岗位，请缩小数据源范围。');
  const jobs = []; let skipped = 0;
  for (const item of records) {
    try {
      const structured = [item?.['@type']].flat().includes('JobPosting');
      const locations = [item.jobLocation || []].flat().map(l => [l?.address?.addressRegion, l?.address?.addressLocality].filter(Boolean).join(' ')).filter(Boolean).join(' / ');
      const link = item.url ? new URL(item.url, baseURL).href : records.length === 1 ? baseURL : '';
      const record = structured ? { title: item.title, company: item.hiringOrganization?.name, location: locations || (item.jobLocationType === 'TELECOMMUTE' ? '远程' : ''), category: [item.employmentType || []].flat().join(' / '), description: plainHTML(item.description), url: link, deadline: item.validThrough ? String(item.validThrough).slice(0, 10) : '' } : { ...item, url: link };
      jobs.push(normalizeJob({ ...record, appliedPosition: '', sourceName: sourceName || new URL(baseURL).hostname }));
    } catch { skipped++; }
  }
  if (!jobs.length) throw fail('岗位数据缺少有效的岗位名称、公司或链接格式，请检查来源。');
  return { jobs, skipped };
}
