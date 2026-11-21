// Keep source wording; these parsers only support filtering, never invent missing requirements.
const excludesGraduates = /(?:不接受|不招收?|不考虑|非)应届(?:毕业)?生?|非校招/;
const excludesBeginners = /无(?:工作)?经验(?:者|的)?(?:请)?(?:勿扰|勿投|不招|不考虑)/;
export function experienceRequirement(value = '') {
  const digits = {零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  const text = value.normalize('NFKC').replace(/\s+/g, '').replace(/[零一二两三四五六七八九十]+(?=年|[-~～—–至到])/g, number => {
    if (!number.includes('十')) return digits[number] ?? number;
    const [tens, ones] = number.split('十');
    return (digits[tens] ?? 1) * 10 + (digits[ones] ?? 0);
  });
  const requirements = [...text.matchAll(/(?:(\d+(?:\.\d+)?)年?[-~～—–至到])?(\d+(?:\.\d+)?)年(及以上|以下|以内|以上|起)?/g)].map(match => {
    const max = Number(match[2]), min = match[1] ? Number(match[1]) : /以下|以内/.test(match[3] || '') ? 0 : max;
    return {min,max};
  });
  if (requirements.some(({min,max})=>min>max)) return null;
  // Conflicting card/detail requirements use the stricter minimum, regardless of wording order.
  if (requirements.length) return requirements.sort((a,b)=>b.min-a.min)[0];
  if (excludesBeginners.test(text)) return null;
  if (/经验不限|不限经验|无需.{0,2}经验|无经验|不限工作经验/.test(text)) return { min: 0, max: 0 };
  if (!excludesGraduates.test(text) && /应届|在校/.test(text)) return { min: 0, max: 0 };
  return null;
}

export function extractExperience(value = '') {
  // Only year counts next to experience wording; dates/company age in a JD are not requirements.
  const number = '(?:[0-9０-９]+(?:[.．][0-9０-９]+)?|[零一二两三四五六七八九十]+)';
  const years = `(?:${number}\\s*年?\\s*[-－~～—–至到]\\s*)?${number}\\s*年(?:及以上|以上|以下|以内|起)?`;
  const requirements = [...value.matchAll(new RegExp(`(?:工作经验|工作年限|经验要求|经验)[：:\\s]*${years}|${years}[的\\s]*(?:相关|行业|岗位|全职|专业|开发)?[的\\s]*(?:工作)?经验`, 'g'))].map(match=>match[0]);
  // Standalone label values (e.g. "一年以下") do not need an extra "经验" suffix.
  if (new RegExp(`^${years}$`).test(value.trim())) requirements.push(value.trim());
  requirements.sort((a,b)=>(experienceRequirement(b)?.min ?? -1)-(experienceRequirement(a)?.min ?? -1));
  const excluded = value.match(excludesGraduates)?.[0] || value.match(excludesBeginners)?.[0];
  const requirement = requirements[0] || value.match(/经验不限|不限经验|无需(?:工作)?经验|不限工作经验/)?.[0]
    || (!excluded && value.match(/无经验|在校生[／/]应届生|应届(?:毕业)?生/)?.[0]);
  return [...new Set([excluded, requirement].filter(Boolean))].join('；');
}

export function classifyRecruitment(row) {
  const text = [row.title, row.category, row.jobTags, row.experience].filter(Boolean).join(' ');
  const experience = experienceRequirement(row.experience || '');
  if (experience?.min > 0) return 'social';
  if (row.recruitmentType === 'social' || /社招|社会招聘/.test(text) || excludesGraduates.test(text) || excludesBeginners.test(text)) return 'social';
  if (row.recruitmentType === 'campus' || /校招|校园招聘|应届|(?:20)?\d{2}届/.test(text) || /(?:^|[\s、,，;；|/])校园(?:$|[\s、,，;；|/])/.test([row.jobTags,row.category].filter(Boolean).join('、'))) return 'campus';
  return '';
}

const employmentText = row => [row.jobTags,row.category,row.title].filter(Boolean).join(' ')
  .replace(/(?:非|不接受|不招收?|不考虑|谢绝)\s*(?:实习生?|兼职)/g,'')
  .replace(/(?:实习生?|兼职)(?:者|人员)?(?:请)?(?:勿扰|勿投)/g,'');

export function classifyEmployment(row) {
  const text = employmentText(row);
  // Internship takes precedence when a card says "全职实习"; no assumption from salary or campus type.
  if (row.employmentType === 'internship' || /实习/.test(text)) return 'internship';
  if (/兼职|非全职|临时工|小时工/.test(text)) return '';
  if (row.employmentType === 'fulltime' || /全职/.test(text)) return 'fulltime';
  return '';
}

// Resolve missing display fields from the posting itself, including older imports.
// Keep the original fields intact for edits, snapshots and import fingerprints.
export function withJobTypes(job) {
  if (job.employmentType && job.recruitmentType) return job;
  const lines = (job.description || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const labels = lines.filter(line => /^(?:【|\[)?(?:工作性质|岗位性质|职位性质|招聘类型|招聘岗位|岗位名称|职位名称|招聘批次)(?:】|\]|[：:])/.test(line));
  const hiring = lines.find(line => /(?:本次|本岗)(?:为|是)?(?:全职|实习|校招|社招)(?:招聘|岗位)|(?:现招|诚招|招募|招聘)实习生|实习生(?:招募|招聘)/.test(line));
  const table = (job.sourceName || '').match(/^Offer\s*情报局\s*[·・-]\s*(.+)$/i)?.[1];
  const tableHint = {'实习信息汇总':'实习','秋招汇总':'校招','26届25届信息汇总':'校招','社招国央企&事业单位&高校':'社招'}[table] || '';
  // A combined campus/internship feed is not evidence about any one role.
  const category = (job.category || '').replace(/校招实习内推合集/g,'');
  const fields = [job.appliedPosition, [job.title, category, job.jobTags].filter(Boolean).join(' '),
    labels.join(' '), job.batch, tableHint, job.announcement, lines[0], hiring];
  let {employmentType = '', recruitmentType = ''} = job;
  for (const field of fields) {
    if (!field) continue;
    const text = field.replace(/(?:实习|全职)(?:工作|实践)?(?:经历|经验|证明)|非全职|(?:不提供|不支持|无)实习(?:岗位|机会)/g,'');
    if (!employmentType && !/(?:全职\s*[/、或兼]\s*实习|实习\s*[/、或兼]\s*全职)/.test(text)) {
      employmentType = classifyEmployment({title:text});
    }
    if (!recruitmentType && !(/校招|校园招聘/.test(text) && /社招|社会招聘/.test(text))) {
      recruitmentType = classifyRecruitment({jobTags:text.replace(/秋招|春招/g,'校招')});
    }
    if (employmentType && recruitmentType) break;
  }
  return {...job, employmentType, recruitmentType};
}

export function monthlySalary(value = '') {
  const text = value.normalize('NFKC').replace(/[\s,，]/g, '').replace(/·\d+薪/g, '');
  // Daily/hourly pay, negotiable pay and foreign currencies are not comparable monthly RMB.
  if (/面议|待定|[美港澳加新]元|[美港]币|USD|HKD|\$|€|£|欧元|英镑|日元|\/天|\/日|\/时|每天|每日|每小时|时薪|日薪/i.test(text)) return null;
  const match = text.match(/^(?:人民币|月薪|年薪)?(\d+(?:\.\d+)?)([kK千万元]?)(?:[-~～—–至到](\d+(?:\.\d+)?)([kK千万元]?))?(?:元)?(?:人民币)?(?:\/月|每月|\/年|每年)?$/);
  if (!match) return null;
  const unit = u => /[kK千]/.test(u) ? 1000 : u === '万' ? 10000 : 1;
  const min = Number(match[1]) * unit(match[2] || match[4] || '元');
  const max = match[3] ? Number(match[3]) * unit(match[4] || match[2] || '元') : min;
  const divisor = /年薪|\/年|每年/.test(text) ? 12 : 1;
  return min > 0 && min <= max ? { min: min / divisor, max: max / divisor } : null;
}

export function requirementFailures(job, conditions) {
  const failures = [];
  const {salaryMin = '', salaryMax = '', experienceMax = ''} = conditions;
  if (conditions.recruitmentType && job.recruitmentType !== conditions.recruitmentType) {
    const experience = experienceRequirement(job.experience);
    const graduateFriendly = !job.recruitmentType && experience?.min === 0 && experience.max <= 1;
    if (conditions.recruitmentType !== 'campus' || !graduateFriendly) failures.push('招聘类型或应届友好经验');
  }
  const otherEmployment = /实习|兼职|非全职|临时工|小时工/.test(employmentText(job));
  if (conditions.employmentType === 'fulltime') {
    if (otherEmployment || job.employmentType && job.employmentType !== 'fulltime') failures.push('工作性质不符');
  } else if (conditions.employmentType && job.employmentType !== conditions.employmentType) failures.push('工作性质不符');
  if (experienceMax !== '') {
    const experience = experienceRequirement(job.experience);
    if (!experience || experience.min > experienceMax) failures.push('经验上限');
  }
  if (salaryMin !== '' || salaryMax !== '') {
    const salary = monthlySalary(job.salary);
    if (!salary || salaryMin !== '' && salary.max < salaryMin || salaryMax !== '' && salary.min > salaryMax) failures.push('薪资区间');
  }
  return failures;
}

export function matchesRequirements(job, conditions) {
  return requirementFailures(job, conditions).length === 0;
}
