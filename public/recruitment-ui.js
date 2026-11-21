import { TabulatorFull as Tabulator } from '/vendor/tabulator.js';
import Sortable from '/vendor/sortable.js';

export function preference(key, fallback) {
  try { return JSON.parse(localStorage.getItem((globalThis.cloudPrefix||'')+key)) ?? fallback; } catch { return fallback; }
}
export function savePreference(key, value) {
  try { localStorage.setItem((globalThis.cloudPrefix||'')+key, JSON.stringify(value)); } catch { /* Storage may be disabled; the view still works. */ }
}
// City names derived from modood/Administrative-divisions-of-China (2023, WTFPL); see THIRD_PARTY_NOTICES.md.
const locationCityNames = ["阿坝藏族羌族自治州","阿克苏地区","阿拉尔","阿拉善盟","阿勒泰地区","阿里地区","安康","安庆","安顺","安阳","鞍山","澳门","巴彦淖尔","巴音郭楞蒙古自治州","巴中","白城","白山","白杨","白银","百色","蚌埠","包头","宝鸡","保定","保山","北海","北京","北屯","本溪","毕节","滨州","亳州","博尔塔拉蒙古自治州","沧州","昌都","昌吉回族自治州","常德","常州","朝阳","潮州","郴州","成都","承德","池州","赤峰","重庆","崇左","滁州","楚雄彝族自治州","达州","大理白族自治州","大连","大庆","大同","大兴安岭地区","丹东","儋州","德宏傣族景颇族自治州","德阳","德州","迪庆藏族自治州","定西","东方","东莞","东营","鄂尔多斯","鄂州","恩施土家族苗族自治州","防城港","佛山","福州","抚顺","抚州","阜新","阜阳","甘南藏族自治州","甘孜藏族自治州","赣州","高雄","固原","广安","广元","广州","贵港","贵阳","桂林","果洛藏族自治州","哈尔滨","哈密","海北藏族自治州","海东","海口","海南藏族自治州","海西蒙古族藏族自治州","邯郸","汉中","杭州","合肥","和田地区","河池","河源","菏泽","贺州","鹤壁","鹤岗","黑河","衡水","衡阳","红河哈尼族彝族自治州","呼和浩特","呼伦贝尔","胡杨河","湖州","葫芦岛","怀化","淮安","淮北","淮南","黄冈","黄南藏族自治州","黄山","黄石","惠州","鸡西","吉安","吉林","济南","济宁","济源","佳木斯","嘉兴","嘉峪关","江门","焦作","揭阳","金昌","金华","锦州","晋城","晋中","荆门","荆州","景德镇","九江","酒泉","喀什地区","开封","可克达拉","克拉玛依","克孜勒苏柯尔克孜自治州","昆明","昆玉","拉萨","来宾","兰州","廊坊","乐山","丽江","丽水","连云港","凉山彝族自治州","辽阳","辽源","聊城","林芝","临沧","临汾","临夏回族自治州","临沂","柳州","六安","六盘水","龙岩","陇南","娄底","泸州","吕梁","洛阳","漯河","马鞍山","茂名","眉山","梅州","绵阳","牡丹江","那曲","南昌","南充","南京","南宁","南平","南通","南阳","内江","宁波","宁德","怒江傈僳族自治州","攀枝花","盘锦","平顶山","平凉","萍乡","莆田","濮阳","普洱","七台河","齐齐哈尔","潜江","黔东南苗族侗族自治州","黔南布依族苗族自治州","黔西南布依族苗族自治州","钦州","秦皇岛","青岛","清远","庆阳","琼海","曲靖","衢州","泉州","日喀则","日照","三门峡","三明","三沙","三亚","厦门","山南","汕头","汕尾","商洛","商丘","上海","上饶","韶关","邵阳","绍兴","深圳","沈阳","十堰","石河子","石家庄","石嘴山","双河","双鸭山","朔州","四平","松原","苏州","宿迁","宿州","绥化","随州","遂宁","塔城地区","台北","台南","台中","台州","太原","泰安","泰州","唐山","桃园","天津","天门","天水","铁岭","铁门关","通化","通辽","铜川","铜陵","铜仁","图木舒克","吐鲁番","万宁","威海","潍坊","渭南","温州","文昌","文山壮族苗族自治州","乌海","乌兰察布","乌鲁木齐","无锡","吴忠","芜湖","梧州","五家渠","五指山","武汉","武威","西安","西宁","西双版纳傣族自治州","锡林郭勒盟","仙桃","咸宁","咸阳","香港","湘潭","湘西土家族苗族自治州","襄阳","孝感","忻州","新北","新乡","新星","新余","信阳","邢台","兴安盟","徐州","许昌","宣城","雅安","烟台","延安","延边朝鲜族自治州","盐城","扬州","阳江","阳泉","伊春","伊犁哈萨克自治州","宜宾","宜昌","宜春","益阳","银川","鹰潭","营口","永州","榆林","玉林","玉树藏族自治州","玉溪","岳阳","云浮","运城","枣庄","湛江","张家界","张家口","张掖","漳州","长春","长沙","长治","昭通","肇庆","镇江","郑州","中山","中卫","舟山","周口","株洲","珠海","驻马店","资阳","淄博","自贡","遵义"];
const locationCityDistricts = {"北京":["朝阳"],"辽源":["西安"],"益阳":["资阳"],"大连":["中山"],"长春":["朝阳"],"常州":["新北"],"牡丹江":["西安"],"大庆":["大同"]};
function locationFilterValues(value) {
  const text=String(value??'').trim(),cities=[];
  for(const part of text.split(/[,，、;；/|\n]+/u)){
    const found=locationCityNames.map(city=>({city,index:part.indexOf(city)})).filter(item=>item.index>=0).sort((a,b)=>a.index-b.index||b.city.length-a.city.length);
    const accepted=[];let end=0;
    for(const item of found){
      if(item.index<end||accepted.some(city=>locationCityDistricts[city]?.includes(item.city)))continue;
      accepted.push(item.city);end=item.index+item.city.length;
    }
    cities.push(...accepted);
  }
  return cities.length ? [...new Set(cities)] : [!text||['未注明','[待确认]','全国','远程','海外'].includes(text)?text:'未识别城市'];
}
function matchesColumn(filter, value, field) {
  const text=String(value ?? '');
  if(Array.isArray(filter)&&field==='location')return filter.flatMap(locationFilterValues).some(city=>city==='未识别城市'?locationFilterValues(text).includes(city):city===''?text==='':text.includes(city));
  if(Array.isArray(filter))return filter.includes(text);
  // Preserve saved text filters from earlier versions.
  return field==='progress' ? text===String(filter) : text.toLowerCase().includes(String(filter).toLowerCase());
}
function columnFilterPopup(table, column, trigger, popup) {
  const field=column.getField(),title=column.getDefinition().title;
  const filters=table.getHeaderFilters(),rawCurrent=filters.find(f=>f.field===field)?.value;
  const current=field==='location'&&Array.isArray(rawCurrent)?[...new Set(rawCurrent.flatMap(locationFilterValues))]:rawCurrent;
  const others=filters.filter(f=>f.field!==field);
  const rowValues=table.getData().filter(row=>others.every(f=>matchesColumn(f.value,row[f.field],f.field))).flatMap(row=>field==='location'?locationFilterValues(row[field]):[String(row[field]??'')]);
  const fixedValues=column.getDefinition().headerFilterParams?.values;
  const values=fixedValues ? [...new Set([...fixedValues,...rowValues])] : [...new Set(rowValues)].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const selected=new Set(values.filter(value=>current===undefined||matchesColumn(current,value,field)));
  // Keep temporarily unavailable choices when another column narrows the rows.
  const unavailable=Array.isArray(current)?current.filter(value=>!values.includes(value)):[];
  popup.replaceChildren();popup.setAttribute('aria-label','筛选'+title);
  const heading=document.createElement('strong');heading.textContent='筛选'+title;
  const search=document.createElement('input');search.type='search';search.placeholder='搜索本列的值';search.setAttribute('aria-label','搜索'+title+'的值');
  const list=document.createElement('div');list.className='job-filter-values';
  const tools=document.createElement('div');tools.className='job-filter-tools';
  const footer=document.createElement('div');footer.className='job-filter-tools';
  const addButton=(parent,text,fn,primary=false)=>{const b=document.createElement('button');b.type='button';b.className='btn small'+(primary?' primary':'');b.textContent=text;b.onclick=fn;parent.append(b);return b;};
  const visible=()=>values.filter(v=>v.toLowerCase().includes(search.value.trim().toLowerCase()));
  const draw=()=>{
    list.replaceChildren();
    const shown=visible();
    if(!shown.length){const empty=document.createElement('p');empty.textContent='没有匹配的值';list.append(empty);}
    for(const value of shown){const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');input.type='checkbox';input.checked=selected.has(value);input.onchange=()=>{if(input.checked)selected.add(value);else selected.delete(value);};text.textContent=value||'（空白）';label.append(input,text);list.append(label);}
  };
  addButton(tools,'全选',()=>{visible().forEach(v=>selected.add(v));draw();});
  addButton(tools,'全不选',()=>{visible().forEach(v=>selected.delete(v));draw();});
  const close=()=>{popup.hidePopover();trigger.focus();};
  addButton(tools,'清除此列',()=>{table.setHeaderFilterValue(field,'');close();});
  addButton(footer,'取消',close);
  addButton(footer,'应用',()=>{
    const chosen=visible().filter(v=>selected.has(v));
    table.setHeaderFilterValue(field,!search.value.trim()&&chosen.length===values.length ? '' : [...chosen,...unavailable]);close();
  },true);
  search.oninput=draw;
  search.onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();footer.lastElementChild.click();}};
  popup.append(heading,search,tools,list,footer);draw();
  popup.showPopover();
  const rect=trigger.getBoundingClientRect();
  popup.style.left=Math.max(8,Math.min(rect.left,innerWidth-popup.offsetWidth-8))+'px';
  popup.style.top=Math.max(8,Math.min(rect.bottom+6,innerHeight-popup.offsetHeight-8))+'px';
  search.focus();
}
export function createJobGrid(rows, columns, headerFilters = null, selection = false) {
  const top = document.querySelector('#job-scroll-top');
  const popup=document.createElement('div');popup.popover='auto';popup.className='job-column-popup';popup.setAttribute('role','dialog');document.body.append(popup);
  const fields = new Set(columns.map(column => column.field));
  const table = new Tabulator('#job-grid', {
    data: rows, index: 'id', layout: 'fitDataStretch', height: '65vh',
    // Pages are capped at 100 rows; render the full page to avoid virtual-scroll gaps with tall, wrapped cells.
    renderVertical: 'basic',
    selectableRows: selection ? 'highlight' : false,
    rowHeader: selection ? {formatter:'rowSelection',titleFormatter:'rowSelection',titleFormatterParams:{rowRange:'active'},width:48,minWidth:48,frozen:true,resizable:false,headerSort:false,headerFilter:false,download:false} : undefined,
    placeholder: '暂无符合条件的岗位，请调整筛选或岗位范围。',
    pagination: true, paginationSize: 20, paginationSizeSelector: [10, 20, 50, 100],
    paginationCounter: 'rows', movableColumns: true,
    persistenceID: 'workbench-jobs-v1',
    persistence: { columns: true, sort: true, headerFilter: true, page: { size: true, page: false } },
    persistenceReaderFunc: (id, type) => {
      const data = type === 'headerFilter' && headerFilters !== null ? headerFilters : preference(`${id}-${type}`, false);
      // Retired columns must not leave hidden filters or stale layout/sort entries.
      return ['columns', 'sort', 'headerFilter'].includes(type) && Array.isArray(data)
        ? data.filter(item => fields.has(type === 'sort' ? item.column : item.field)) : data;
    },
    persistenceWriterFunc: (id, type, data) => savePreference(`${id}-${type}`, data),
    locale: 'zh-cn', langs: { 'zh-cn': { pagination: {
      page_size: '每页', page_title: '第', first: '首页', first_title: '首页', last: '末页', last_title: '末页',
      prev: '上一页', prev_title: '上一页', next: '下一页', next_title: '下一页', all: '全部',
      counter: { showing: '显示', of: '，共', rows: '条', pages: '页' },
    } } },
    columnDefaults: {
      minWidth: 120, resizable: true, variableHeight: true,
      formatter: 'plaintext', headerFilter: () => document.createElement('span'),
      headerFilterFunc: (filter,value,row,params) => matchesColumn(filter,value,params.field),
      headerFilterLiveFilter: false, headerFilterEmptyCheck: value => value==='' || value==null,
      // CSV quotes alone do not stop spreadsheet formulas in imported job text.
      accessorDownload: value => /^[\s\uFEFF]*[=+@\-]/u.test(String(value ?? '')) ? "'" + value : value,
    }, columns: columns.map(column=>({...column,headerFilterFuncParams:{field:column.field}})),
  });
  const syncWidth = () => {
    const holder = document.querySelector('#job-grid .tabulator-tableholder');
    if (!holder) return;
    top.firstElementChild.style.width = holder.scrollWidth + 'px';
    top.onscroll = () => { holder.scrollLeft = top.scrollLeft; };
    holder.onscroll = () => { top.scrollLeft = holder.scrollLeft; };
    top.scrollLeft = holder.scrollLeft;
  };
  const syncFilters=()=>{
    const active=new Set(table.getHeaderFilters().map(f=>f.field));
    for(const column of table.getColumns()){
      if(!column.getField())continue;
      const el=column.getElement();let button=el.querySelector('.job-column-filter');
      if(!button){button=document.createElement('button');button.type='button';button.className='job-column-filter';button.innerHTML='<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3h12L9 9v4l-2-1V9z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';button.setAttribute('aria-label','筛选'+column.getDefinition().title);button.setAttribute('aria-haspopup','dialog');button.onclick=event=>{event.stopPropagation();columnFilterPopup(table,column,button,popup);};button.onmousedown=event=>event.stopPropagation();el.querySelector('.tabulator-col-title').append(button);}
      button.classList.toggle('active',active.has(column.getField()));button.title=active.has(column.getField())?'已筛选，点击修改':'筛选此列';
    }
  };
  table.on('tableBuilt',syncFilters);
  table.on('dataFiltered',syncFilters);
  table.on('tableDestroyed',()=>popup.remove());
  table.on('renderComplete', syncWidth);
  table.on('columnResized', syncWidth);
  table.on('columnMoved', syncWidth);
  return table;
}

export function createApplicationBoard(onMove) {
  let moving = false;
  const boards = [...document.querySelectorAll('.kanban-lane')].map(lane => Sortable.create(lane, {
    group: 'workbench-applications', draggable: '.application-card', handle: '.card-drag',
    animation: 160, sort: false, ghostClass: 'card-ghost', emptyInsertThreshold: 30,
    onMove: () => !moving,
    async onEnd(event) {
      if (event.to === event.from) return;
      moving = true;
      // Restore DOM order before saving. The normal render becomes the single source of truth.
      const anchor = event.from.children[event.oldIndex];
      event.from.insertBefore(event.item, anchor || null);
      try { await onMove(event.item.dataset.id, event.to.dataset.status); }
      finally { moving = false; }
    },
  }));
  const top = document.querySelector('#application-scroll-top');
  const holder = document.querySelector('.application-board');
  let resize;
  if (top && holder) {
    const syncWidth = () => {
      top.hidden = holder.scrollWidth <= holder.clientWidth;
      top.firstElementChild.style.width = (holder.scrollWidth - holder.clientWidth + top.clientWidth) + 'px';
      top.scrollLeft = holder.scrollLeft;
    };
    top.onscroll = () => { if (holder.scrollLeft !== top.scrollLeft) holder.scrollLeft = top.scrollLeft; };
    holder.onscroll = () => { if (top.scrollLeft !== holder.scrollLeft) top.scrollLeft = holder.scrollLeft; };
    resize = new ResizeObserver(syncWidth);
    resize.observe(holder);
    syncWidth();
  }
  return () => {
    resize?.disconnect();
    if (top) top.onscroll = null;
    if (holder) holder.onscroll = null;
    boards.forEach(board => board.destroy());
  };
}
