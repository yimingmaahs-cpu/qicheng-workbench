import { createHash } from 'node:crypto';
import { COMMON, PROMPTS } from './review-prompts.mjs';
import { requestReviewModel, quoteRestorer } from './review-model.mjs';
import { workspaceFor, STYLES } from './expert.mjs';
import { experienceBlocks, experienceParts, EXPERIENCE_LABELS, cleanResumeProse } from './resume-structure.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function string(value, limit = 6000, required = false, field = '模型文字字段') {
  if (typeof value !== 'string') throw new Error(`${field} 必须为字符串，当前为${value === undefined ? '缺失' : value === null ? 'null' : Array.isArray(value) ? '数组' : typeof value}。`);
  if (value.length > limit) throw new Error(`${field} 超过 ${limit} 字符（当前 ${value.length}），请精简此字段；未截断内容。`);
  if (required && !value.trim()) throw new Error(`${field} 不能为空字符串。`);
  return value.trim();
}
function array(value, limit = 100, field = '模型数组') {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${field} 必须是数组且最多 ${limit} 项，当前${Array.isArray(value) ? `为 ${value.length} 项` : '缺失或格式错误'}，未截断结果。`);
  return value;
}
function unique(values) { return [...new Set(values)]; }
// Short request-local fact IDs are easier for models to copy. Persist and
// validate canonical IDs; never replace matching words inside resume prose.
function mapFactReferences(value, names, field = '') {
  if (Array.isArray(value)) return value.map(item => ['fact_ids', 'factIds'].includes(field) && typeof item === 'string' ? names.get(item) || item : mapFactReferences(item, names, field));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, field === 'validated_facts' && key === 'id' ? names.get(item) || item : mapFactReferences(item, names, key)]));
}
function ids(value, available, limit = 100, field = 'fact_ids') {
  const result = unique(array(value, limit, field).map((v, i) => string(v, 120, true, `${field}[${i}]`)));
  if (result.some(v => !available.includes(v))) throw new Error(`${field} 引用了不可用编号；只能复制本节点允许的同类编号，不可把段落、事实和岗位要求编号混用。`);
  return result;
}
const placeholder = text => /\[(?:待补充|实际|真实|具体|可验证|邮箱已隐藏|手机号已隐藏|证件号码已隐藏)[^\]]*\]|(?:\{\{[^}]+\}\})/.test(text);
const labels = { jd: '拆解岗位 JD', facts: '整理经历事实', diagnosis: '诊断与匹配评分', rewrite: '生成修改对照', audit: '独立核查', repair: '修正问题建议', audit_repair: '复核修正结果', interview: '生成面试准备' };
export function sourceBlocks(text, prefix) {
  let at = 0;
  return text.split(/\n/).flatMap((line, i) => {
    const start = at; at += line.length + 1;
    return line.trim() ? [{ id: `${prefix}${i + 1}`, text: line, start }] : [];
  });
}
export function reviewSupplements(report) {
  const w = workspaceFor(report);
  return (report.expert?.followUpQuestions || []).filter(q => w.answers[q.id]?.trim()).map(q => ({ id: q.id, question: q.question, requirementId: q.requirementId || '', answer: w.answers[q.id].trim() })).sort((a, b) => a.id.localeCompare(b.id));
}
export function reviewAnswersKey(report) { return digest(reviewSupplements(report)); }

const dimensionRules = [
  { key: 'responsibility', label: '核心职责', weight: 40 },
  { key: 'skill', label: '技能要求', weight: 30 },
  { key: 'hard', label: '资格条件', weight: 20 },
  { key: 'bonus', label: '加分项', weight: 10 },
];
export function calculateMatchScore(requirements, matches, facts = []) {
  if (!requirements.length) return null;
  const active = dimensionRules.filter(d => requirements.some(r => r.kind === d.key));
  const total = active.reduce((sum, d) => sum + d.weight, 0);
  if (!total) return null;
  const factors = { direct: 1, transferable: 0.65, weak: 0.3, none: 0 };
  let rawScore = 0, unknownWeight = 0;
  const items = [], dimensions = active.map(d => {
    const reqs = requirements.filter(r => r.kind === d.key), sum = reqs.reduce((v, r) => v + (r.priority === 'high' ? 2 : 1), 0);
    const dimensionWeight = d.weight / total * 100;
    let earned = 0, unknown = 0;
    for (const req of reqs) {
      const m = matches.find(item => item.requirementId === req.id);
      const usableEvidence = (m?.factIds || []).length > 0 && m.factIds.every(id => facts.some(f => f.id === id && f.status === 'usable'));
      const support = usableEvidence ? m.support : 'none';
      const eligibility = usableEvidence ? m.eligibility : 'unknown';
      const conflict = eligibility === 'conflict';
      const missing = req.kind === 'hard' ? eligibility === 'unknown' : support === 'none' && !conflict;
      const factor = conflict ? 0 : req.kind === 'hard' ? (eligibility === 'supported' ? 1 : 0) : (factors[support] || 0);
      const possible = dimensionWeight * (req.priority === 'high' ? 2 : 1) / sum, points = possible * factor;
      earned += points; if (missing) unknown += possible;
      items.push({ requirementId: req.id, text: req.text, kind: req.kind, necessity: req.necessity, support, eligibility, unknown: missing, conflict, factor, weight: Number(possible.toFixed(2)), earned: Number(points.toFixed(2)), factIds: m?.factIds || [], reason: m?.optimizationSuggestion || '当前材料未说明。' });
    }
    rawScore += earned; unknownWeight += unknown;
    return { ...d, weight: Number(dimensionWeight.toFixed(2)), earned: Number(earned.toFixed(2)), score: Math.round(earned / dimensionWeight * 100), unknown: reqs.filter(r => items.find(i => i.requirementId === r.id)?.unknown).length };
  });
  return {
    rubric: 'evidence-v1', score: Math.round(rawScore), coverage: Math.round(100 - unknownWeight), unknownPoints: Math.round(unknownWeight),
    dimensions, items, conflicts: items.filter(i => i.conflict).map(i => i.requirementId), unknowns: items.filter(i => i.unknown).map(i => i.requirementId),
    includesAnswers: matches.some(m => m.factIds?.some(id => facts.some(f => f.id === id && f.sourceType === 'answer'))),
    note: '分数衡量当前材料对本次 JD 的证据支持，不代表实际能力或录用概率。未说明的要求暂不计分，单独列为未知；明确冲突另外提示。',
    formula: '职责40 / 技能30 / 资格20 / 加分10；JD 未出现的维度按比例分配权重。维度内高优先级权重2，其余1。直接证据100%、可迁移65%、弱线索30%、未说明0%；资格满足100%、明确冲突或未知0%。总分四舍五入。',
  };
}

function quote(value, source, redact) {
  const restored = quoteRestorer(source, redact)(string(value, 12000, true));
  if (!restored || !source.includes(restored)) throw new Error('引用不能在指定原文中核对，不能采用。');
  return restored;
}
function normalizeJD(raw, blocks, redact) {
  if (!object(raw)) throw new Error('JD 拆解结构无效。');
  const kinds = { '职责': 'responsibility', '资格': 'hard', '技能': 'skill', '加分项': 'bonus', responsibility: 'responsibility', hard: 'hard', skill: 'skill', bonus: 'bonus' };
  const priorities = { '核心': 'high', '一般': 'medium', '加分': 'low', high: 'high', medium: 'medium', low: 'low' };
  const necessities = { '明确必须': 'mandatory', '明确优先': 'preferred', '未明确': 'unspecified', mandatory: 'mandatory', preferred: 'preferred', unspecified: 'unspecified' };
  const seen = new Set();
  const requirements = array(raw.requirements, 40).map((r, i) => {
    const inputId = string(r.id, 120, true), block = blocks.find(b => b.id === r.source_block_id);
    if (!block || seen.has(inputId) || !kinds[r.kind] || !priorities[r.priority] || !necessities[r.necessity]) throw new Error('岗位要求编号、来源或分类无效。');
    seen.add(inputId);
    return { id: `jd-${i + 1}`, text: string(r.text, 1000, true), evidence: quote(r.quote, block.text, redact), blockId: block.id, kind: kinds[r.kind], priority: priorities[r.priority], necessity: necessities[r.necessity], priorityReason: string(r.priority_reason, 2000, true) };
  });
  if (!requirements.length) throw new Error('JD 中未提取到可核验的要求，请补全真实岗位描述。');
  if (unique(requirements.map(r => r.text)).length !== requirements.length) throw new Error('岗位要求重复，请合并后返回，不得重复计分。');
  return { summary: string(raw.role_summary, 3000, true), requirements, ambiguities: array(raw.jd_ambiguities, 30) };
}
function normalizeFacts(raw, sources, redact) {
  if (!object(raw)) throw new Error('模型事实结构无效。');
  const all = array(raw.facts, 100);
  const facts = all.map((f, index) => {
    if (!object(f)) throw new Error(`第 ${index + 1} 条事实必须为对象。`);
    let source = sources.find(s => s.id === f.source_id);
    if (!source) {
      // Recover a mistyped ID only when the full quote identifies exactly one original block.
      const matches = sources.filter(s => { const restored = quoteRestorer(s.text, redact)(f.quote); return typeof restored === 'string' && restored.length > 0 && s.text.includes(restored); });
      if (matches.length === 1) source = matches[0];
    }
    if (!source) throw new Error(`第 ${index + 1} 条事实的 source_id 无法唯一核对；必须复制输入段落的 id，并逐字引用该段文字。`);
    if (!['usable', 'uncertain', 'conflicted'].includes(f.status)) throw new Error(`第 ${index + 1} 条事实的 status 只能为 usable、uncertain 或 conflicted。`);
    const evidence = quote(f.quote, source.text, redact);
    return { id: 'f-' + digest([source.type, source.id, evidence]).slice(0, 16), sourceType: source.type, sourceId: source.id, quote: evidence, status: f.status };
  });
  if (!facts.length) throw new Error('事实条目为空，请引用已有原文证据。');
  const merged = new Map(), caution = { usable: 0, uncertain: 1, conflicted: 2 };
  for (const fact of facts) {
    const previous = merged.get(fact.id);
    if (!previous || caution[fact.status] > caution[previous.status]) merged.set(fact.id, fact);
  }
  return { facts: [...merged.values()], conflicts: array(raw.conflicts, 50), missingContext: array(raw.missing_context, 50) };
}
function normalizeDiagnosis(raw, requirements, facts, blocks, previousQuestions, answers) {
  if (!object(raw)) throw new Error('模型诊断结构无效。');
  const factIds = facts.filter(f => f.status === 'usable').map(f => f.id), reqIds = requirements.map(r => r.id), blockIds = blocks.map(b => b.id);
  const supportMap = { direct: 'direct', transferable: 'transferable', weak: 'weak', none: 'none', '直接支持': 'direct', '可迁移': 'transferable', '仅弱线索': 'weak', '未见证据': 'none' };
  const eligibilityMap = { supported: 'supported', conflict: 'conflict', unknown: 'unknown', not_applicable: 'not_applicable', '材料支持满足': 'supported', '材料明确冲突': 'conflict', '材料未说明': 'unknown', '不适用': 'not_applicable' };
  const matches = array(raw.matches, 40, 'matches（岗位匹配）').map((m, i) => {
    if (!object(m)) throw new Error(`matches[${i}] 必须为对象。`);
    const req = requirements.find(r => r.id === m.requirement_id), refs = ids(m.fact_ids, factIds, 100, `matches[${i}].fact_ids`);
    const support = supportMap[m.evidence_support], eligibility = eligibilityMap[m.eligibility];
    if (!req) throw new Error(`matches[${i}].requirement_id 不在 validated_requirements 中。`);
    if (!support || !eligibility || (!refs.length && (support !== 'none' || !['unknown', 'not_applicable'].includes(eligibility)))) throw new Error(`matches[${i}] 匹配结论没有有效证据或对应要求。`);
    if (req.kind === 'hard' && !['supported', 'conflict', 'unknown'].includes(eligibility)) throw new Error('资格条件必须明确为满足、冲突或未知。');
    return { requirementId: req.id, jdRequirement: req.text, jdEvidence: req.evidence, factIds: refs, support, eligibility, resumeEvidence: refs.map(id => { const f = facts.find(x => x.id === id); return `${f.sourceType === 'answer' ? '本人补充：' : ''}${f.quote}`; }).join('\n'), evidenceStrength: ({ direct: 'strong', transferable: 'medium', weak: 'weak', none: 'none' })[support], optimizationSuggestion: string(m.reason, 4000, true) };
  });
  if (matches.length !== requirements.length || unique(matches.map(m => m.requirementId)).length !== requirements.length) throw new Error('诊断必须覆盖每项 JD 要求且不得重复，不能遗漏计分项。');
  const warnings = [];
  // Plans and unanswered follow-up proposals are optional model suggestions.
  // Reject their invalid entries without discarding independently valid scoring evidence.
  const plan = array(raw.edit_plan, 24, 'edit_plan（修改计划）').flatMap((p, i) => {
    const field = `edit_plan[${i}]`;
    try {
      if (!object(p)) throw new Error(`${field} 必须为对象。`);
      return [{ blockId: ids([p.block_id], blockIds, 1, `${field}.block_id`)[0], requirementIds: ids(p.requirement_ids ?? [], reqIds, 40, `${field}.requirement_ids`), factIds: ids(p.fact_ids, factIds, 100, `${field}.fact_ids`), frontload: string(p.frontload ?? '', 3000, false, `${field}.frontload`), keep: string(p.keep ?? '', 3000, false, `${field}.keep`), compress: string(p.compress ?? '', 3000, false, `${field}.compress`), reason: string(p.reason, 3000, true, `${field}.reason`), priority: ['high', 'medium', 'low'].includes(p.priority) ? p.priority : 'medium' }];
    } catch (error) { warnings.push({ field, message: error.message }); return []; }
  });
  const proposedQuestions = array(raw.questions, 5, 'questions（经历追问）').flatMap((q, i) => {
    try {
    if (!object(q)) throw new Error(`questions[${i}] 必须为对象。`);
    const question = string(q.question, 3000, true), reqId = q.requirement_id || '';
    if (reqId && !reqIds.includes(reqId)) throw new Error('追问关联的岗位要求不存在。');
    const blockId = string(q.block_id || '', 120);
    if (blockId && !blockIds.includes(blockId)) throw new Error('追问关联的简历段落不存在。');
    const known = previousQuestions.find(p => p.question === question && (p.requirementId || '') === reqId && (p.blockId || '') === blockId);
    const req = requirements.find(r => r.id === reqId);
    return [{ id: known?.id || 'q-' + digest([question, reqId, blockId]).slice(0, 12), question, purpose: string(q.purpose, 2000, true), requirementId: reqId, jdRequirement: req?.text || '', jdEvidence: req?.evidence || '', blockId }];
    } catch (error) { warnings.push({ field: `questions[${i}]`, message: error.message }); return []; }
  });
  const questions = proposedQuestions.filter((q, i) => proposedQuestions.findIndex(other => other.id === q.id) === i);
  // Keep answered questions so saved answers never disappear when the model proposes a new set.
  for (const q of previousQuestions) if (answers[q.id]?.trim() && !questions.some(n => n.id === q.id)) questions.push(q);
  return { summary: string(raw.summary, 5000, true), matches, plan, questions, gaps: array(raw.remaining_gaps, 40, 'remaining_gaps（信息缺口）'), warnings };
}
function normalizeEdits(raw, blocks, redact, allowedIds) {
  if (!object(raw)) throw new Error('模型修改结构无效。');
  const edits = array(raw.edits, 24, 'edits').map((e, i) => {
    const path = `edits[${i}]`;
    if (!object(e)) throw new Error(`${path} 必须为对象。`);
    const blockId = string(e.block_id, 120, true, `${path}.block_id`), block = blocks.find(b => b.id === blockId);
    if (!block) throw new Error(`${path}.block_id 不在 resume_blocks 中，请复制该输入的 id；不要使用事实或修改计划中的编号。`);
    // Whole-experience boundaries and metadata belong to the source, not the model.
    const before = block.experience ? block.text.trim() : string(e.before, 35000, true, `${path}.before`);
    let after;
    const fields = ['background', 'responsibilities', 'results'];
    if (block.experience && fields.some(key => Object.hasOwn(e, key))) {
      const parts = fields.map(key => {
        if (!Object.hasOwn(e, key)) throw new Error(`${path}.${key} 缺失；经历必须提供 background、responsibilities、results，材料未说明时填空字符串。`);
        const value = e[key] === null ? '' : e[key];
        return Array.isArray(value)
          ? array(value, 30, `${path}.${key}`).map((line, n) => string(line, 5000, false, `${path}.${key}[${n}]`)).join('\n')
          : string(value, 5000, false, `${path}.${key}`);
      });
      after = (block.header ? block.header + '\n' : '') + parts.map((part, n) => `${EXPERIENCE_LABELS[n]}：${part}`).join('\n');
    } else {
      // Keep existing checked reports and repair responses compatible.
      after = string(e.after, 5000, true, `${path}.after`);
    }
    return { id: string(e.edit_id || `edit-${i + 1}`, 120, true, `${path}.edit_id`), blockId,
      requirementIds: unique(array(e.requirement_ids ?? [], 40, `${path}.requirement_ids`).map((v, n) => string(v, 120, true, `${path}.requirement_ids[${n}]`))),
      factIds: unique(array(e.fact_ids, 100, `${path}.fact_ids`).map((v, n) => string(v, 120, true, `${path}.fact_ids[${n}]`))),
      before: quoteRestorer(block.text, redact)(before) || before,
      after: string(cleanResumeProse(string(after, 5000, true, `${path}.after（组装正文）`).replace(/\r\n?/g, '\n')), 5000, true, `${path}.after（清理批注后正文）`),
      reason: string(e.reason ?? '', 5000, false, `${path}.reason`), experience: Boolean(block.experience) };
  });
  if (unique(edits.map(e => e.id)).length !== edits.length) throw new Error('修改项编号重复。');
  if (allowedIds && (edits.length !== allowedIds.length || edits.some(e => !allowedIds.some(allowed => allowed.id === e.id && allowed.blockId === e.blockId)))) throw new Error('修正必须保留所有待修正项的编号和对应经历，不能新增、遗漏或改换经历。');
  if (!allowedIds) {
    const missing = blocks.filter(b => b.experience && !edits.some(e => e.blockId === b.id));
    if (missing.length) throw new Error(`必须逐项整理全部经历，遗漏经历编号：${missing.map(b => b.id).join('、')}。每项完整保留标题并按项目背景、项目职责、项目成果组织，缺失字段留空。`);
  }
  const noRewriteReason = string(raw.no_edit_reason ?? '', 3000, false, 'no_edit_reason');
  if (!edits.length && !noRewriteReason) throw new Error('没有修改建议时必须说明原因。');
  return { edits, noRewriteReason };
}
export function checkEdits(edits, blocks, requirements, facts) {
  const checked = edits.map(e => {
    const block = blocks.find(b => b.id === e.blockId), refs = facts.filter(f => e.factIds.includes(f.id));
    const errors = [];
    const offset = block?.text.indexOf(e.before) ?? -1;
    if (!block || offset < 0 || block.text.indexOf(e.before, offset + 1) >= 0) errors.push('原文无法在指定段落唯一定位');
    if (blocks.some(b => b !== block && b.text.includes(e.before))) errors.push('原文在多处重复，请扩大引用范围或手动编辑');
    if (!e.factIds.length || unique(e.factIds).length !== e.factIds.length || refs.length !== e.factIds.length || refs.some(f => f.status !== 'usable')) errors.push('没有可用且唯一的事实依据');
    if (e.requirementIds.some(id => !requirements.some(r => r.id === id))) errors.push('关联了不存在的 JD 要求');
    if ((!block?.experience && e.before === e.after) || placeholder(e.after)) errors.push('建议未改变原文或包含待填 / 脱敏占位符');
    const parts = block?.experience ? experienceParts(e.after) : null;
    if (block?.experience) {
      if (e.before !== block.text.trim()) errors.push('必须替换完整经历，不能只改其中一句');
      if (!parts) errors.push('经历必须按项目背景、项目职责、项目成果三段式输出，各标签单独起行且只出现一次');
      if (block.header && !e.after.startsWith(block.header + '\n')) errors.push('经历标题、机构、职位和日期的所有行必须逐字保留在开头');
      if (!block.header && !e.after.startsWith('项目背景：') && !e.after.startsWith('项目背景:')) errors.push('无标题经历从项目背景开始，不得新增机构、日期或职位');
    }
    // A contact-bearing range cannot be rewritten: preserving the local original is safer than guessing how to restore it.
    if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)/i.test(e.before + e.after)) errors.push('修改范围含联系方式或证件号码，请保留该段');
    const start = offset < 0 ? -1 : block.start + offset;
    const basis = refs.map(f => f.quote).join('\n');
    const numbers = unique(e.after.match(/\d+(?:\.\d+)?\s*(?:%|％|万|元|人|份|年|月|天)?/g) || []).filter(n => !basis.includes(n));
    return { ...e, start, end: start + e.before.length, errors, numbers, missingFields: parts ? EXPERIENCE_LABELS.filter((_, i) => !parts[i]) : [] };
  });
  for (const e of checked) if (e.start >= 0 && checked.some(other => other !== e && other.start >= 0 && e.start < other.end && e.end > other.start)) e.errors.push('修改范围与另一项重叠');
  return checked;
}
function normalizeAudit(raw, edits) {
  if (!object(raw)) throw new Error('模型核查结构无效。');
  const checks = array(raw.checks, 24).map(c => {
    if (!edits.some(e => e.id === c.edit_id) || !['pass', 'revise', 'withhold'].includes(c.verdict)) throw new Error('核查编号或结论无效。');
    const issues = array(c.issues, 30).map(i => ({ type: string(i.type, 1000, true), span: string(i.span, 5000), sourceIds: array(i.source_ids, 100).map(v => string(v, 120)), explanation: string(i.explanation, 5000, true), requiredFix: string(i.required_fix, 3000) }));
    if ((c.verdict === 'pass' && issues.length) || (c.verdict !== 'pass' && !issues.length)) throw new Error('核查结论与问题清单不一致。');
    return { editId: c.edit_id, verdict: c.verdict, issues };
  });
  if (checks.length !== edits.length || unique(checks.map(c => c.editId)).length !== edits.length) throw new Error('核查结果必须逐项覆盖全部修改，不能遗漏或重复。');
  return checks;
}

export async function runReviewWorkflow(report, settings, apiKey, style = 'concise', onProgress = () => {}, onCheckpoint = () => {}) {
  if (settings.enabled === false) throw new Error('AI 已关闭，请先在本地设置中启用 AI。');
  const text = report.sourceText, target = report.target, w = workspaceFor(report), supplements = reviewSupplements(report);
  if (!text?.trim() || text.length > 35000 || text.length + supplements.reduce((n, a) => n + a.answer.length, 0) > 45000) throw new Error('请提供可读简历；简历最多 3.5 万字符，含补充回答最多 4.5 万字符，未截断材料。');
  if (!settings.baseUrl || !settings.model) throw new Error('请先配置模型地址和名称。');
  if (!Object.hasOwn(STYLES, style)) throw new Error('请选择有效的优化风格。');
  const started = Date.now(), resumeBlocks = sourceBlocks(text, 'R'), jdBlocks = sourceBlocks(target?.description || '', 'J');
  const rewriteBlocks = experienceBlocks(text, resumeBlocks);
  const sources = [...resumeBlocks.map(b => ({ ...b, type: 'resume' })), ...supplements.map(a => ({ id: a.id, text: a.answer, type: 'answer', question: a.question }))];
  const cache = structuredClone(report.pendingReview?.checkpoint || (report.reviewProcess?.version === 3 ? report.reviewProcess.checkpoint || {} : {}));
  const completed = [], reused = new Set(), redact = settings.redact !== false;
  const orderedStages = () => Object.keys(labels).filter(name => completed.includes(name));
  const persist = () => onCheckpoint({ version: 3, checkpoint: structuredClone(cache), stages: orderedStages(), durationMs: Date.now() - started });
  let stage = '', jd = { summary: '', requirements: [], ambiguities: [] }, factResult = { facts: [], conflicts: [], missingContext: [] }, diagnosis = null, editsResult = { edits: [], noRewriteReason: '' }, final = [], withheld = [], failure = null, checked = [], checks = [];
  async function step(name, payload, validate, options = {}) {
    stage = name;
    const factNames = new Map((payload.validated_facts || []).map((fact, index) => [fact.id, `F${index + 1}`]));
    const canonicalNames = new Map([...factNames].map(([canonical, short]) => [short, canonical]));
    const prompt = PROMPTS[name === 'repair' ? 'rewrite' : name === 'audit_repair' ? 'audit' : name] + '\n' + (options.contract || '') + (factNames.size ? '\n本次 fact_ids 使用输入 validated_facts 中的短编号 F1、F2 等，必须逐字复制；不要自行生成编号。编号只放在引用字段，不能写入正文。' : '');
    const key = digest([5, name, settings.baseUrl, settings.model, redact, payload, COMMON, prompt]);
    if (!options.refresh && cache[name]?.key === key) { completed.push(name); reused.add(name); return cache[name].value; }
    const nodeStarted = Date.now();
    onProgress(name, `${labels[name]}…`);
    let error = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await requestReviewModel(settings, apiKey, COMMON + '\n\n' + prompt, { stage: name, ...mapFactReferences(payload, factNames), ...(error ? { validation_error: error } : {}) }, { ...options, onRetry: message => onProgress(name, `${labels[name]}：${message}`) }).catch(e => { e.reviewStage = name; throw e; });
      let value;
      try { value = validate(mapFactReferences(raw, canonicalNames)); }
      catch (e) { error = e.message; if (attempt === 1) { e.reviewStage = name; throw e; } onProgress(name, `${labels[name]}：修正引用或结构一次…`); continue; }
      cache[name] = { key, value, durationMs: Date.now() - nodeStarted, ...(name === 'audit_repair' ? { policy: digest([COMMON, PROMPTS.audit]), candidateHashes: Object.fromEntries(payload.candidate_edits.map(e => [e.id, digest([e.blockId, e.before, e.after])])) } : {}) }; completed.push(name); persist(); return value;
    }
  }
  try {
    const prepared = await Promise.allSettled([
      jdBlocks.length ? step('jd', { jd_blocks: jdBlocks, target_company: target.company || '', target_role: target.title || '' }, raw => normalizeJD(raw, jdBlocks, redact), { temperature: 0.1, maxTokens: 4000 }).then(value => { jd = value; }) : Promise.resolve(),
      step('facts', { resume_blocks: resumeBlocks, answer_blocks: sources.filter(s => s.type === 'answer') }, raw => normalizeFacts(raw, sources, redact), { temperature: 0.1, maxTokens: 6000 }).then(value => { factResult = value; }),
    ]);
    const rejected = prepared.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
    const previousQuestions = report.expert?.followUpQuestions || [];
    try {
    diagnosis = await step('diagnosis', { review_mode: jdBlocks.length ? 'targeted' : 'general', validated_requirements: jd.requirements, validated_facts: factResult.facts.filter(f => f.status === 'usable'), reference_rules: { fact_ids: factResult.facts.filter(f => f.status === 'usable').map(f => f.id), requirement_ids: jd.requirements.map(r => r.id), block_ids: resumeBlocks.map(b => b.id) }, conflicts: factResult.conflicts, resume_blocks: resumeBlocks, question_history: supplements }, raw => normalizeDiagnosis(raw, jd.requirements, factResult.facts, resumeBlocks, previousQuestions, w.answers), { maxTokens: 5000, contract: 'edit_plan 最多24项，questions 最多5项，remaining_gaps 最多40项；这些字段必须为数组，无内容时用[]。matches 每项字段为 requirement_id、fact_ids、evidence_support(direct|transferable|weak|none)、eligibility(supported|conflict|unknown|not_applicable)、reason。questions 每项字段为 question、purpose、requirement_id(无则空)、block_id。edit_plan 的 frontload、keep、compress、reason 均为字符串，priority 为 high|medium|low。只可引用输入中的 id。' });
    } catch (error) {
      if (error.status) throw error;
      failure = { stage: 'diagnosis', message: error.message };
      onProgress('rewrite', '岗位诊断暂未完成，继续基于已核对事实整理三段式经历…');
    }
    const rewritePayload = { resume_blocks: rewriteBlocks, validated_requirements: jd.requirements, validated_facts: factResult.facts, edit_plan: diagnosis?.plan || [], style: STYLES[style], current_draft: w.draft };
    editsResult = await step('rewrite', rewritePayload, raw => normalizeEdits(raw, rewriteBlocks, redact), { temperature: 0.3, maxTokens: 6000 });
    checked = checkEdits(editsResult.edits, rewriteBlocks, jd.requirements, factResult.facts);
    const auditPayload = list => ({ candidate_edits: list, source_materials: sources, validated_facts: factResult.facts, validated_requirements: jd.requirements, goal_sources: sources.filter(s => /目标|计划|预计|测算|拟|希望/.test(s.text)), claims_to_check: list.filter(e => e.numbers.length).map(e => ({ edit_id: e.id, numbers: e.numbers })) });
    const valid = checked.filter(e => !e.errors.length);
    checks = valid.length ? await step('audit', auditPayload(valid), raw => normalizeAudit(raw, valid), { temperature: 0.1, maxTokens: 4000 }) : [];
    // Earlier continuations may already have approved some repaired entries.
    // Keep them only for exactly the same rewrite/audit inputs and valid ranges;
    // the latest repair cache alone can omit entries approved in an older round.
    const previousCache = report.reviewProcess?.checkpoint;
    const replaying = reused.has('rewrite') && (reused.has('audit') || (!valid.length && cache.audit_repair?.policy === digest([COMMON, PROMPTS.audit])));
    if (replaying && previousCache?.rewrite?.key === cache.rewrite.key && (valid.length ? previousCache?.audit?.key === cache.audit?.key : previousCache?.audit_repair?.policy === cache.audit_repair?.policy)) {
      const retained = (report.expert?.optimizedItems || []).filter(item => item.verified && item.auditStatus === 'pass' && checked.some(e => e.id === item.id && e.blockId === item.blockId && e.before === item.before));
      const candidates = checkEdits(checked.map(e => retained.find(item => item.id === e.id) || e), rewriteBlocks, jd.requirements, factResult.facts);
      for (const candidate of candidates) if (!candidate.errors.length && retained.some(item => item.id === candidate.id)) {
        checked = checked.map(e => e.id === candidate.id ? candidate : e);
        checks = checks.filter(c => c.editId !== candidate.id).concat({ editId: candidate.id, verdict: 'pass', issues: [] });
      }
    }
    const repair = checked.filter(e => e.errors.length || checks.find(c => c.editId === e.id)?.verdict === 'revise');
    if (repair.length) {
      const continuingRepair = replaying && cache.audit_repair?.value?.some(c => c.verdict === 'revise' && repair.some(e => e.id === c.editId));
      const feedback = repair.map(e => {
        // On an explicit continuation use the latest rejected revision and its
        // feedback, not the same cached failed repair forever.
        const priorCheck = replaying && cache.audit_repair?.value?.find(c => c.editId === e.id && c.verdict === 'revise');
        const priorEdit = priorCheck && cache.repair?.value?.edits?.find(item => item.id === e.id && item.blockId === e.blockId && cache.audit_repair.candidateHashes?.[item.id] === digest([item.blockId, item.before, item.after]));
        const original = priorEdit ? checkEdits([priorEdit], rewriteBlocks, jd.requirements, factResult.facts)[0] : e;
        return { edit_id: e.id, original, rule_errors: original.errors, issues: priorEdit ? priorCheck.issues : checks.find(c => c.editId === e.id)?.issues || [] };
      });
      const repaired = await step('repair', { ...rewritePayload, review_feedback: feedback }, raw => normalizeEdits(raw, rewriteBlocks, redact, repair), { refresh: continuingRepair, temperature: 0.3, maxTokens: 6000, contract: '只返回 review_feedback 中的修改，保留其 edit_id，不返回其他已通过的修改。' });
      checked = checkEdits(checked.map(e => repaired.edits.find(r => r.id === e.id) || e), rewriteBlocks, jd.requirements, factResult.facts);
      const again = checked.filter(e => repair.some(r => r.id === e.id) && !e.errors.length);
      checks = checks.filter(c => !repair.some(e => e.id === c.editId));
      const rechecked = again.length ? await step('audit_repair', auditPayload(again), raw => normalizeAudit(raw, again), { temperature: 0.1, maxTokens: 4000 }) : [];
      checks = checks.concat(rechecked);
    }
  } catch (error) {
    if (error.status) throw error;
    stage = error.reviewStage || stage;
    failure = { stage, message: error.message };
    // Keep completed checks; an interrupted repair must not discard independently passed edits.
    if (!completed.length && !Object.keys(cache).length) throw new Error(`${labels[stage] || '评审节点'}失败：${error.message}`);
  }
    for (const e of checked) {
      const check = checks.find(c => c.editId === e.id), req = jd.requirements.find(r => r.id === e.requirementIds[0]);
      const item = { id: e.id, blockId: e.blockId, start: e.start, before: e.before, after: e.after, reason: e.reason, factIds: e.factIds, requirementIds: e.requirementIds, requirementId: req?.id || '', jdRequirement: req?.text || '', jdEvidence: req?.evidence || '', experience: e.experience, missingFields: e.missingFields, auditStatus: check?.verdict || 'withhold', verified: !e.errors.length && check?.verdict === 'pass', riskWarning: e.missingFields?.length ? `待补充：${e.missingFields.join('、')}。未编造缺失内容。` : '' };
      if (item.verified) final.push(item);
      else withheld.push({ ...item, riskWarning: [...e.errors, ...(check?.issues || []).map(i => i.explanation + (i.requiredFix ? '；' + i.requiredFix : ''))].join('；') || '核查未完成' });
    }
  const requirements = jd.requirements, matches = diagnosis?.matches || [];
  const score = diagnosis ? calculateMatchScore(requirements, matches, factResult.facts) : null;
  const expert = {
    engine: 'ai', note: '事实引用经程序核对，改写需通过独立核查。引用一致不代表经历获得外部认证。',
    jdAnalysis: { requirements, responsibilities: requirements.filter(r => r.kind === 'responsibility').map(r => r.text), hardRequirements: requirements.filter(r => r.kind === 'hard').map(r => r.text), keywords: [], summary: jd.summary, ambiguities: jd.ambiguities },
    matchItems: matches, followUpQuestions: diagnosis?.questions || report.expert?.followUpQuestions || [], optimizedItems: final, withheldItems: withheld, structure: { version: 1, experienceCount: rewriteBlocks.filter(b => b.experience).length, readyCount: final.filter(e => e.experience).length },
    noRewriteReason: failure ? `${labels[failure.stage] || failure.stage}未完成：${failure.message}` : editsResult.noRewriteReason || (withheld.length ? '部分修改未通过核查，已隔离；请补充事实后再生成。' : ''),
    interviewPrep: [], facts: factResult.facts, conflicts: factResult.conflicts, remainingGaps: diagnosis?.gaps || [], editPlan: diagnosis?.plan || [], diagnosticWarnings: diagnosis?.warnings || [],
  };
  return {
    engine: 'ai', model: settings.model, summary: diagnosis?.summary || (expert.structure.experienceCount > 0 && expert.structure.readyCount === expert.structure.experienceCount ? '经历已按三段式重组并通过核查，岗位诊断尚未完成，可稍后继续。' : '评审流程尚未完成，已保留完成的节点；可继续评审，无需重新提交原材料。'),
    strengths: matches.filter(m => ['direct', 'transferable'].includes(m.support) && !['conflict', 'unknown'].includes(m.eligibility)).map(m => `${m.jdRequirement}：${m.optimizationSuggestion}`),
    suggestions: (diagnosis?.plan || []).map(p => ({ priority: p.priority, title: p.frontload || '调整经历表达', evidence: resumeBlocks.find(b => b.id === p.blockId)?.text || '', advice: p.reason, rewrite: '' })),
    targetFit: target ? { title: target.title, mode: target.description ? 'semantic' : 'general', matched: matches.filter(m => ['direct', 'transferable'].includes(m.support) && !['conflict', 'unknown'].includes(m.eligibility)).map(m => m.jdRequirement), missing: matches.filter(m => ['none', 'weak'].includes(m.support) || ['conflict', 'unknown'].includes(m.eligibility)).map(m => m.jdRequirement), note: score?.note || '未完成具体 JD 的证据诊断，暂不评分。', score } : null,
    expert, reviewProcess: { version: 3, status: failure || withheld.length ? 'partial' : 'completed', stages: orderedStages(), failedStage: failure?.stage || '', error: failure?.message || '', checkpoint: cache, durationMs: Date.now() - started, nodeDurations: Object.fromEntries(orderedStages().map(name => [name, cache[name]?.durationMs || 0])), answersKey: digest(supplements), evaluatedAnswers: Object.fromEntries(supplements.map(s => [s.id, s.answer])), materialHash: digest([text, target]), generatedAt: new Date().toISOString() },
  };
}

export async function generateInterview(report, settings, apiKey, onProgress = () => {}) {
  if (report.reviewProcess?.version !== 3 || !report.expert?.facts?.length || !report.reviewProcess.stages?.includes('diagnosis')) throw new Error('请先完成新版事实诊断，再生成面试准备。');
  if (reviewAnswersKey(report) !== report.reviewProcess.answersKey) throw new Error('补充回答已变化，请先更新诊断与改写。');
  const w = workspaceFor(report);
  onProgress('interview', '正在围绕所选草稿与真实事实生成面试准备…');
  const payload = { stage: 'interview', validated_requirements: report.expert.jdAnalysis.requirements, validated_facts: report.expert.facts, final_draft: w.draft, remaining_gaps: report.expert.remainingGaps || [] };
  const raw = await requestReviewModel(settings, apiKey, COMMON + '\n' + PROMPTS.interview + '\nanswer_outline 为字符串，materials_to_prepare 为字符串数组。', payload, { temperature: 0.3, maxTokens: 3000, onRetry: message => onProgress('interview', `生成面试准备：${message}`) });
  if (!object(raw)) throw new Error('模型面试准备结构无效。');
  const factIds = report.expert.facts.filter(f => f.status === 'usable').map(f => f.id);
  const items = array(raw.questions, 5, 'questions（经历追问）').map(q => ({ question: string(q.question, 3000, true), approach: string(q.answer_outline, 5000, true), evidence: array(q.materials_to_prepare, 15).map(s => string(s, 2000, true)), why: string(q.why, 3000, true), factIds: ids(q.fact_ids, factIds) }));
  if (!items.length) throw new Error('模型未返回面试准备内容。');
  return { items, draftHash: digest(w.draft), generatedAt: new Date().toISOString() };
}
