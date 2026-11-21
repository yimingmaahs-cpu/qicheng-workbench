import { randomUUID } from 'node:crypto';
import { field } from './jobs.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const columns = new Set(['employmentType', 'recruitmentType', 'salary', 'experience', 'sourceName', 'batch', 'announcement', 'companyType', 'industry', 'location', 'announcementUrl', 'appliedPosition', 'progress', 'operation']);
function normalize(input) {
  const name = field(input.name, 80, '筛选名称', true), q = field(input.q, 500, '搜索文字');
  const archived = input.archived || '', kind = input.kind || '';
  if (!['', 'yes', 'all', 'deleted'].includes(archived) || !['', 'announcement', 'position'].includes(kind)) throw fail(400, '筛选范围无效。');
  if (!Array.isArray(input.headerFilters) || input.headerFilters.length > columns.size) throw fail(400, '表头筛选无效。');
  const seen = new Set();
  const headerFilters = input.headerFilters.map(item => {
    if (!item || !columns.has(item.field) || seen.has(item.field)) throw fail(400, '筛选列无效或重复。');
    seen.add(item.field);
    if(Array.isArray(item.value)){
      if(item.value.length>5000 || item.value.some(value=>typeof value!=='string'||value.length>4000) || JSON.stringify(item.value).length>200000)throw fail(400,'筛选选项过多或过长。');
      return {field:item.field,value:[...new Set(item.value)]};
    }
    return { field: item.field, value: field(item.value, 500, '筛选条件', true) };
  });
  return { name, q, archived, kind, headerFilters };
}

export function jobFilters(db) {
  db.exec('CREATE TABLE IF NOT EXISTS job_filters(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const list = () => db.prepare('SELECT data FROM job_filters ORDER BY rowid').all().map(r => JSON.parse(r.data));
  return {
    list,
    async handle(req, res, route, { jsonBody, send }) {
      const match = route.match(/^\/api\/job-filters(?:\/([a-f0-9-]+))?$/);
      if (!match) return false;
      const id = match[1];
      if (!id && req.method === 'GET') { send(res, 200, { filters: list() }); return true; }
      if ((!id && req.method === 'POST') || (id && ['PATCH', 'DELETE'].includes(req.method))) {
        const input = await jsonBody(req), saved = list(), previous = saved.find(item => item.id === id);
        if (id && !previous) throw fail(404, '筛选组合已不存在，请刷新。');
        if (id && input.revision !== previous.revision) throw fail(409, '筛选组合已更新，请刷新后重试。');
        if (req.method === 'DELETE') { db.prepare('DELETE FROM job_filters WHERE id=?').run(id); send(res, 200, { deleted: true }); return true; }
        const value = normalize(input);
        if (saved.some(item => item.id !== id && item.name === value.name)) throw fail(409, '已有同名筛选，请选择另一个名称。');
        if (!id && saved.length >= 30) throw fail(400, '最多保存 30 个筛选组合，请先删除不用的组合。');
        const filter = { ...value, id: id || randomUUID(), revision: (previous?.revision || 0) + 1, updatedAt: new Date().toISOString() };
        db.prepare('INSERT INTO job_filters(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(filter.id, JSON.stringify(filter));
        send(res, id ? 200 : 201, { filter }); return true;
      }
      return false;
    },
  };
}
