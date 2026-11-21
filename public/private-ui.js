export function qqMailSetupGuide() {
  return `<ol class="mail-setup-guide" aria-label="QQ 邮箱授权码获取步骤">
    <li><strong>打开邮箱</strong><span>在浏览器打开 QQ 邮箱并登录自己的账号。</span></li>
    <li><strong>进入安全设置</strong><span>点击邮箱右上角的<strong>设置</strong>，进入<strong>账号与安全 → 安全设置</strong>。</span></li>
    <li><strong>生成授权码</strong><span>找到<strong>POP3/IMAP/SMTP/Exchange/CardDAV 服务</strong>。未开启时，先开启服务并按邮箱提示完成验证；显示<strong>“已开启”</strong>时，直接点击<strong>“生成授权码”</strong>，按提示操作并复制授权码。</span></li>
    <li><strong>返回工作台填写</strong><span>在下方填写邮箱地址，粘贴刚生成的授权码。填写的是<strong>邮箱授权码，不是 QQ 登录密码</strong>。</span></li>
  </ol>`;
}

export function createPrivateUI({api,e,modal,toast,refresh,render,go,getState,getView,onModelSaved=()=>{}}) {
  let serial=0,paste=null;
  const button=(label,action,extra='',kind='')=>`<button type="button" class="btn ${kind}" data-action="private-${action}" ${extra}>${label}</button>`;
  const field=(name,label,value='',type='text',required=false)=>`<div class="field"><label for="private-${name}">${label}</label><input id="private-${name}" name="${name}" type="${type}" value="${e(value)}" ${required?'required':''}></div>`;
  const footer=label=>`<div class="inline-error" role="alert"></div><div class="form-actions"><button type="submit" class="btn primary">${label}</button>${button('取消','close')}</div>`;
  const header=(title,sub,actions='')=>`<div class="page-heading"><div><span class="eyebrow">启程 · 私人求职工作台</span><h1>${title}</h1><p>${sub}</p></div><div class="actions">${actions}</div></div>`;
  function accountView() {
    const config=getState().local.model;
    return header('本地设置','简历、投递和邮箱保存在这台电脑上，无需注册账号。')+`<section class="panel private-section"><h2>我的 AI 模型</h2><p>使用你自己的 API Key；不配置也可浏览岗位、管理投递和运行基础检查。</p><form id="private-model-form" data-revision="${config.revision}">${field('baseUrl','模型 API 地址',config.baseUrl,'url',true)}${field('model','模型名称',config.model,'text',true)}${field('apiKey','API Key（留空保留已保存密钥）','','password')}<label class="private-check"><input type="checkbox" name="enabled" ${config.enabled?'checked':''}>启用 AI${config.hasKey?' · 已保存密钥':''}</label><label class="private-check"><input type="checkbox" name="clearKey">清除已保存密钥（同时取消启用 AI）</label><button type="submit" class="btn primary">保存模型设置</button><p class="muted">密钥加密保存在本机。AI 评审会将简历与岗位要求发送到你配置的模型服务，费用由你的模型账户承担。</p></form></section>`;
  }

  function mailSettings() {
    const c=getState().mail;
    modal('连接 QQ 邮箱',`<form id="private-mail-form">${qqMailSetupGuide()}${field('account','QQ / Foxmail 邮箱地址',c.account,'email',true)}${field('authorizationCode','邮箱授权码（不是登录密码）','','password',true)}<details><summary>同步范围</summary><div class="field"><label for="private-days">首次同步范围</label><select id="private-days" name="days"><option value="7">最近 7 天</option><option value="30" selected>最近 30 天</option><option value="90">最近 90 天</option></select></div><p>默认读取收件箱，每 15 分钟同步，每批最多扫描 100 封；有剩余时可继续同步。</p></details><p class="muted">授权码在本机加密保存。邮件只读同步，不发送邮件，不修改 QQ 原邮件，正文不发送给模型。</p>${footer('连接并开始同步')}${c.hasSecret?button('断开绑定','disconnect','','subtle'):''}${c.account||c.count?button('清除站内邮件数据','clear-mail','','subtle'):''}</form>`);
  }


  const post=(url,value={})=>api(url,{method:'POST',body:JSON.stringify(value)});
  const date=v=>v?new Date(v).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):'尚无';
  async function paint(view){
    if(getView()!==view)return;
    const ticket=++serial,main=document.querySelector('#main');
    main.innerHTML='<p class="loading-state">正在读取本机工作台…</p>';
    try{
      await refresh();
      if(ticket!==serial||getView()!==view)return;
      if(view==='account'){main.innerHTML=accountView();return;}
      const jobSources=(getState().jobSources||[]).filter(s=>s.type!=='wechat');
      main.innerHTML=header('我的来源','管理招聘群与自动采集。',button('刷新','refresh'))+
      '<div class="private-admin-grid source-platforms">'+['wechat','qq'].map(platform=>'<section class="panel private-section"><h2>'+(platform==='wechat'?'微信群':'QQ群')+'</h2>'+button('导入招聘消息','paste','data-platform="'+platform+'"','primary')+'</section>').join('')+'</div>'+
      '<p class="source-running-note muted">自动采集时，请保持电脑、连接组件和工作台后台运行。</p>'+
      '<section class="panel private-section source-list"><div class="panel-head"><h2>招聘网站来源 <span class="source-count">'+jobSources.length+'</span></h2><button type="button" class="btn subtle" data-action="source-new">添加来源</button></div>'+
      (jobSources.map(s=>'<article class="source-card"><div class="panel-head"><div><h3>'+e(s.name)+'</h3><p class="muted">'+e(s.url)+'</p></div><span class="catalog-tag">'+(s.running?'采集中':s.automation?.paused?'待验证':s.automation?.enabled?'自动拉取已启用':s.lastError?'需要处理':s.lastCheckedAt?'已检查':'待检查')+'</span></div><p>'+e(s.lastResult||'尚未采集')+'</p>'+(s.platform?'<p class="muted">'+(s.automation?.enabled?'每 '+e(s.automation.intervalMinutes)+' 分钟自动去重入库 · '+(s.automation.paused?'已暂停，请完成验证后重新启用':'下次 '+e(date(s.automation.nextRunAt))):'自动拉取未启用')+'</p>':'')+'<div class="actions">'+(s.platform||/offerqingbaoju\.cn\/info-summary/.test(s.url)?'<button type="button" class="btn small" data-action="source-login" data-id="'+e(s.id)+'">登录采集窗口</button>':'')+'<button type="button" class="btn small primary" data-action="source-pull" data-id="'+e(s.id)+'">拉取并预览</button>'+(s.platform?'<button type="button" class="btn small" data-action="source-auto" data-id="'+e(s.id)+'">自动拉取设置</button>'+(s.automation?.enabled?'<button type="button" class="btn small subtle" data-action="source-auto-pause" data-id="'+e(s.id)+'">暂停自动拉取</button>':''):'<button type="button" class="btn small subtle" data-action="source-edit" data-id="'+e(s.id)+'">编辑来源</button>')+'</div></article>').join('')||'<p class="source-empty muted">暂无招聘网站来源。</p>')+'</section>';
    }catch(err){if(ticket===serial&&getView()===view)main.innerHTML='<section class="panel private-section"><h2>暂时无法读取</h2><p>'+e(err.message)+'</p>'+button('重试','refresh')+'</section>';}
  }
  function pasteForm(platform,restore=false){
    if(!getState().capabilities?.privateImportSelection){modal('请先重启新版后台','<p>消息导入已更新，请关闭新版后台并重新运行“启动新版.cmd”，再刷新页面。</p>'+button('关闭','close'));return;}
    const draft=restore&&paste?.platform===platform?{...paste}:null;paste=null;modal(platform==='qq'?'导入 QQ 群招聘消息':'导入微信招聘消息','<form id="private-paste-form" data-platform="'+platform+'"><p>选择聊天记录文本，或直接粘贴群消息。预览后勾选需要的招聘信息，再保存到我的岗位。</p>'+field('group','来源群名称','','text',true)+'<div class="field"><label for="private-message-file">选择聊天记录文本（可选）</label><input id="private-message-file" type="file" accept=".txt,.md,.log,text/plain"><small>支持 TXT / MD / LOG，最大 1 MB。请导出为文本；数据库、BAK 和图片暂不支持。</small></div><div class="field"><label for="private-file-encoding">文件编码</label><select id="private-file-encoding"><option value="auto">自动识别（UTF-8 / UTF-16 / GB18030）</option><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option><option value="utf-16le">UTF-16 LE</option></select><p id="private-file-status" role="status"></p></div><div class="field"><label for="private-message-text">粘贴招聘消息</label><textarea id="private-message-text" name="text" rows="10" maxlength="300000" required></textarea><small>'+(platform==='qq'?'QQ 的“日期 时间 昵称”或“昵称 日期 时间”会自动分条。':'')+'无时间昵称的多条消息，可用单独一行 --- 分隔；正文空行会保留。每次最多识别 1000 条，确认入库最多 200 条。</small></div><details><summary>筛选招聘消息（可选）</summary>'+field('keyword','关注岗位（选填）')+field('location','关注城市（选填）')+field('exclude','排除关键词（选填）')+'</details>'+footer('预览识别结果')+'</form>');
    const area=document.querySelector('#private-message-text');
    if(draft){for(const key of ['group','keyword','location','exclude'])document.querySelector('#private-'+key).value=draft[key]||'';area.value=draft.text;}
    let fileRevision=0;
    const fileInput=document.querySelector('#private-message-file'),encoding=document.querySelector('#private-file-encoding'),status=document.querySelector('#private-file-status'),preview=document.querySelector('#private-paste-form [type="submit"]');
    area.addEventListener('input',()=>{fileRevision++;preview.disabled=false;status.textContent='使用当前编辑的文本。';});
    const readFile=async()=>{
      const revision=++fileRevision,file=fileInput.files[0];if(!file){preview.disabled=false;return;}
      preview.disabled=true;status.textContent='正在读取文件…';
      try{
        if(!/\.(txt|md|log)$/i.test(file.name))throw Error('请选择文本文件；不支持 QQ 数据库、备份或图片。');
        if(file.size>1024*1024)throw Error('文件超过 1 MB，请分批导入。');
        const bytes=new Uint8Array(await file.arrayBuffer());let code=encoding.value,content;
        if(code==='auto'){
          if(bytes[0]===255&&bytes[1]===254)code='utf-16le';else if(bytes[0]===254&&bytes[1]===255)code='utf-16be';
          else {try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);code='utf-8';}catch{code='gb18030';}}
        }
        try{content=new TextDecoder(code,{fatal:true}).decode(bytes);}catch{throw Error('无法按所选编码读取，请更换文件编码。');}
        if(content.includes('\0')||content.includes('\uFFFD'))throw Error('文件不像可读文本，请更换编码或复制群消息。');
        if(content.length>300000)throw Error('文件超过 300000 字，请分批导入。');
        if(!area.isConnected||revision!==fileRevision)return;
        area.value=content;status.textContent='已读取 '+file.name+' · '+code.toUpperCase()+'，请核对正文后预览。';
      }catch(err){if(area.isConnected&&revision===fileRevision)status.textContent=err.message+' 原有正文保持不变。';}
      finally{if(area.isConnected&&revision===fileRevision)preview.disabled=false;}
    };
    fileInput.onchange=readFile;encoding.onchange=readFile;
  }
  function importPreview(r){
    modal('招聘消息预览','<form id="private-import-form"><p>共 '+r.scanned+' 条消息，识别到 '+r.jobs.length+' 条招聘，过滤 '+r.filtered+' 条，不支持 '+r.unsupported+' 条。</p><p class="muted">请核对并勾选要保存的消息。识别采用本地规则，图片和附件不会识别；重复岗位和已彻底删除的岗位会跳过。</p>'+(r.jobs.length?'<div class="actions">'+button('全选','import-all')+button('取消全选','import-none')+'</div><p id="private-import-count" role="status"></p>':'')+r.jobs.map((j,i)=>'<article class="source-card"><label class="private-check"><input type="checkbox" name="selected" value="'+i+'" checked>'+e(j.company||'公司待核对')+' · '+e(j.title||'岗位待核对')+'</label><details><summary>查看消息原文</summary><p class="preserve">'+e(j.description)+'</p></details></article>').join('')+(r.jobs.length?footer('确认导入我的岗位'):'')+button('返回修改','paste-back','data-platform="'+paste.platform+'"')+'</form>');
    document.querySelector('#private-import-form').addEventListener('change',importCount);importCount();
  }
  function importCount(){const form=document.querySelector('#private-import-form'),count=form.querySelectorAll('[name="selected"]:checked').length,submit=form.querySelector('[type="submit"]');if(submit){submit.disabled=count<1||count>200;form.querySelector('#private-import-count').textContent='已选 '+count+' 条，每次最多 200 条。';}}
  async function action(name,el){
    name=name.slice(8);
    if(name==='close'){document.querySelector('#modal').close();return;}
    if(name==='refresh'){await paint(getView());return;}
    if(name==='paste'||name==='paste-back'){pasteForm(el.dataset.platform,name==='paste-back');return;}
    if(name==='import-all'||name==='import-none'){document.querySelectorAll('#private-import-form [name="selected"]').forEach(c=>c.checked=name==='import-all');importCount();return;}
    if(name==='disconnect'){modal('断开邮箱绑定','<form id="private-disconnect-form"><p>清除邮箱授权码并停止同步，保留已有邮件和投递记录。</p>'+footer('确认断开')+'</form>');return;}
    if(name==='clear-mail'){modal('清除本机邮件数据','<form id="private-clear-mail-form"><p>断开邮箱并清除工作台内的邮件、扫描记录和相关提醒，保留 QQ 原邮件与投递时间线。既有备份仍按原策略保留。</p><label class="private-check"><input type="checkbox" name="confirm" required>确认清除本机邮件数据</label>'+footer('确认清除')+'</form>');}
  }
  async function submit(form){
    const submit=form.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;const original=submit.textContent;
    const data=new FormData(form),f=Object.fromEntries(data);
    try{
      if(form.id==='private-paste-form'){const draft={...f,platform:form.dataset.platform};const r=await post('/api/private/import-preview',draft);if(!form.isConnected||!document.querySelector('#modal').open)return;paste=draft;importPreview(r);return;}
      if(form.id==='private-import-form'){const r=await post('/api/private/import',{...paste,selected:data.getAll('selected').map(Number),confirm:true});document.querySelector('#modal').close();await refresh();await go('jobs');toast('新增 '+r.inserted+' 条，跳过重复 '+r.duplicates+' 条'+(r.suppressed?'（其中 '+r.suppressed+' 条已彻底删除）':'')+'。');return;}
      if(form.id==='private-model-form'){await api('/api/local/model',{method:'PUT',body:JSON.stringify({...f,enabled:f.enabled==='on'&&f.clearKey!=='on',clearKey:f.clearKey==='on',revision:Number(form.dataset.revision)})});onModelSaved();}
      if(form.id==='private-mail-form'){submit.textContent='正在检测与同步…';const r=await post('/api/mail/connect',{...f,days:Number(f.days)});await refresh();document.querySelector('#modal').close();render();toast(r.syncError?'已绑定，首次同步未完成：'+r.syncError:'邮箱已连接并完成首次同步。',!!r.syncError);return;}
      if(form.id==='private-disconnect-form')await post('/api/mail/disconnect');
      if(form.id==='private-clear-mail-form')await post('/api/mail/clear-data',{confirm:f.confirm==='on'});
      document.querySelector('#modal').close();await refresh();render();toast('已保存。');
    }catch(err){const box=form.querySelector('.inline-error');if(box)box.textContent=err.message;else toast(err.message,true);}
    finally{submit.disabled=false;submit.textContent=original;}
  }
  return {render:paint,action,submit,mailSettings};

}
