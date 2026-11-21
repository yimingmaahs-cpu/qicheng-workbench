const r=await fetch('/api/state');
if(!r.ok)throw Error('请确认本地后台已启动');
const state=await r.json();
window.cloudPrefix='private:'+state.local.workspace+':';
await import('/app.js');

const version = state.local.version;
document.querySelector('.local-status .version').textContent = 'v'+version;
const notice = document.createElement('a');
notice.href = 'https://github.com/Yimingmaahs-CPU/qicheng-workbench/releases/latest';
notice.target = '_blank';
notice.rel = 'noopener noreferrer';
notice.setAttribute('role','status');
document.querySelector('.topbar-right').prepend(notice);
async function checkRelease() {
  try {
    const response = await fetch('https://api.github.com/repos/Yimingmaahs-CPU/qicheng-workbench/releases/latest',{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(5000)});
    if (!response.ok) return;
    const latest = await response.json(), tag = latest.tag_name || '';
    if (!/^v\d+\.\d+\.\d+$/.test(tag) || latest.draft || latest.prerelease || !latest.assets?.some(a=>a.name==='Qicheng-Windows-x64.zip' && a.digest)) return;
    const current = version.split('.').map(Number);
    const difference = tag.slice(1).split('.').map((n,i)=>Number(n)-current[i]).find(n=>n!==0);
    if (difference>0) notice.textContent = tag+' 可用 · 保存后退出并重新启动工作台';
  } catch { /* Offline use continues with the installed version. */ }
}
void checkRelease();
setInterval(checkRelease,300000);
