import { localExpert, expertMarkdown, workspaceFor } from './expert.mjs';
import { runReviewWorkflow } from './review-workflow.mjs';
export { redactContact } from './review-model.mjs';
export { generateInterview } from './review-workflow.mjs';
const dimensions = [
  { key: 'contact', label: '联系方式', pattern: /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?86[- ]?)?1[3-9]\d{9}|(?:phone|tel|电话|手机)\s*[:：]?\s*[+\d][\d ()-]{6,}/i },
  { key: 'education', label: '教育背景', pattern: /教育|学历|大学|学院|本科|硕士|博士|education|university|bachelor|master|college/i },
  { key: 'experience', label: '经历与项目', pattern: /经历|经验|项目|实习|工作|experience|project|internship|employment/i },
  { key: 'skills', label: '技能与能力', pattern: /技能|工具|证书|资格|语言能力|个人能力|专业能力|核心能力|skills|certification|proficien/i },
  { key: 'dates', label: '时间信息', pattern: /(?:19|20)\d{2}[.年/\-]|(?:19|20)\d{2}\s*[—–~至]|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+20\d{2}/i },
];

export function localReview(text, target = null, pages = null) {
  const lines = text.split(/\n/).map(s => s.trim()).filter(Boolean);
  const checks = dimensions.map(d => ({ key: d.key, label: d.label, present: d.pattern.test(text) }));
  const suggestions = [];
  const strengths = [];
  function add(priority, title, evidence, advice, rewrite = '') { suggestions.push({ priority, title, evidence, advice, rewrite }); }
  const missingAdvice = {
    contact: '检查是否清楚写出可联系的手机号或邮箱。系统只检查格式，不验证号码或邮箱是否可用。',
    education: '补充学校、专业、学历和预计毕业时间，便于招聘方判断资格。',
    experience: '增加真实项目、实习、工作或实践经历，说明背景、自己的职责和具体产出。',
    skills: '独立整理与目标岗位有关的工具、技能或证书，并在经历中提供使用证据。',
    dates: '为教育和主要经历补充起止年月，保持时间格式一致。',
  };
  for (const check of checks.filter(c => !c.present)) add('high', `检查${check.label}是否完整`, `未在提取文字中识别到「${check.label}」的常见格式。`, missingAdvice[check.key]);
  if (checks.filter(c => c.present).length >= 4) strengths.push('已识别到主要简历模块，招聘方可以较快定位你的背景与经历。');
  const achievements = lines.filter(l => /(?:提升|增长|降低|减少|完成|覆盖|服务|转化|营收|提高|节省|improv|increas|reduc|deliver|achiev)/i.test(l) && /\d+(?:\.\d+)?\s*(?:%|％|个|人|次|万|元|天|小时|倍|users|hours|clients|projects)/i.test(l));
  if (achievements.length) strengths.push(`发现 ${achievements.length} 处带数量或比例的成果描述；请确认统计口径和个人贡献都能解释。`);
  const vague = lines.filter(l => /负责|参与|协助|配合|responsible|participated|assisted/i.test(l) && l.length > 8 && !achievements.includes(l));
  if (vague.length) add('high', '把职责描述改成具体贡献', vague[0].slice(0, 240), '说明你面对的问题、独立采取的行动和最终产出。没有可靠数据时，用交付物或实际反馈描述结果，不补造数字。', '针对[真实问题]，我通过[具体行动]完成[实际交付物]，带来[可验证结果或反馈]。');
  else if (!achievements.length) add('medium', '让经历的成果更容易被看见', '暂未识别到明确带有数量或比例的成果句。', '优先补充能被验证的交付物、使用范围或改进结果。成果不一定要有数字，真实、具体比量化形式更重要。');
  const generic = lines.find(l => /吃苦耐劳|积极向上|责任心强|学习能力强|沟通能力强|团队精神|hard.?working|team player/i.test(l));
  if (generic) add('medium', '用事实支撑自我评价', generic.slice(0, 240), '选一段真实经历说明这项能力如何发挥作用，减少没有证据的形容词。', '在[真实场景]中，通过[你的行动]解决[具体问题]，获得[实际反馈]。');
  const longLine = lines.find(l => l.length > 180);
  if (longLine) add('medium', '拆分较长的经历段落', longLine.slice(0, 240), '这段提取文本较长。先核对是否由 PDF 排版合并导致；如果原文也是长段落，建议拆成 2–4 个要点，每点表达一个贡献。');
  if (pages && pages > 2) add('medium', '检查篇幅与重点', `原始 PDF 共 ${pages} 页。`, '根据经历丰富度决定篇幅。优先保留与目标岗位有关的内容，删减重复描述，避免为压缩页数而牺牲可读性。');
  if (text.length < 300) add('high', '先检查是否漏提取了内容', `目前仅提取到 ${text.length} 个字符。`, '在简历原文页核对文字与上传文件是否一致；若确实内容较少，再补充教育、经历与成果。');
  const targetFit = target ? { title: target.title, mode: 'keywords', matched: [], missing: [], note: '' } : null;
  if (targetFit) {
    const keywords = (target.keywords || '').split(/[,，、;；\n]/).map(x => x.trim()).filter(Boolean);
    targetFit.matched = keywords.filter(k => text.toLowerCase().includes(k.toLowerCase()));
    targetFit.missing = keywords.filter(k => !text.toLowerCase().includes(k.toLowerCase()));
    targetFit.note = keywords.length ? '仅比较你填写的关键词，不代表能力判断或录用概率。' : '此方向尚未填写关键词；基础检查不会仅凭岗位名称推断匹配度。可在本次评审中补充关键词，或使用 AI 深度评审。';
    if (targetFit.missing.length) add('medium', '检查目标岗位相关证据', `未找到关键词：${targetFit.missing.join('、')}`, '如果有对应的真实经历，请补充使用场景和产出；如果没有，不要直接把词添加进技能列表。');
  }
  if (!strengths.length) strengths.push('已提取可编辑的简历文字，可以先核对内容，再逐项补足信息。');
  const found = checks.filter(c => c.present).length;
  return {
    engine: 'local', model: null, summary: `在提取文字中识别到 ${found}/${checks.length} 项基础信息。以下建议来自本地规则检查，请结合原文件核对；它不评价你的职业水平，也不检查视觉排版。`,
    checks, strengths, suggestions, targetFit, expert: localExpert(text, target),
    profile: { email: text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] || '', phone: text.match(/(?<!\d)1[3-9]\d{9}(?!\d)/)?.[0] || '' },
  };
}

export function reportMarkdown(resume, report) {
  return `# ${resume.name} · 简历评审\n\n时间：${report.createdAt}\n方式：${report.engine === 'ai' ? `AI 深度评审（${report.model}）` : '本地基础检查'}\n文字版本：${report.revision}\n方向：${report.target?.title || '通用评审'}\n公司：${report.target?.company || '未填写'}\n\n${report.target?.description ? `## 本次岗位 JD\n\n${report.target.description}\n\n` : ''}${report.summary}\n\n## 基础信息检查\n\n${report.checks.map(c => `- ${c.present ? '[x]' : '[ ]'} ${c.label}`).join('\n')}\n\n## 值得保留\n\n${report.strengths.map(s => `- ${s}`).join('\n')}\n\n## 修改建议\n\n${report.suggestions.map((s, i) => `### ${i + 1}. ${s.title}\n\n${s.evidence ? `原文/检查依据：${s.evidence}\n\n` : ''}${s.advice}${s.rewrite ? `\n\n表达参考（需核实与补充）：${s.rewrite}` : ''}`).join('\n\n')}\n\n报告不代表录用概率；未检查原文件视觉排版。\n${expertMarkdown(report)}`;
}

export async function aiReview(text, target, pages, settings, apiKey, onProgress = () => {}, onCheckpoint = () => {}) {
  return { ...localReview(text, target, pages), ...await runReviewWorkflow({ sourceText: text, target }, settings, apiKey, 'concise', onProgress, onCheckpoint) };
}

export async function optimizeReview(report, settings, apiKey, style, onProgress = () => {}, onCheckpoint = () => {}) {
  const result = await runReviewWorkflow(report, settings, apiKey, style, onProgress, onCheckpoint);
  return { ...result, items: result.expert.optimizedItems, noRewriteReason: result.expert.noRewriteReason, originalWorkspace: workspaceFor(report) };
}
