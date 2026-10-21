(() => {
  'use strict';
  const {types,points} = window.FH3_DATA;
  const mapConfigs = window.FH3_MAPS;
  const $ = id => document.getElementById(id);
  const PREFIX = 'fh3.collect.v1.';
  const regions = {};
  for(const [key,config] of Object.entries(mapConfigs)) {
    const [x,y]=config.position,[,,w,h]=config.crop;
    regions[key]={name:config.name,box:[x,y,w*config.unit,h*config.unit]};
  }
  function imagePoint(key,x,y) {
    const [a,b]=mapConfigs[key].oldToImage;
    return [a[0]*x+a[1]*y+a[2],b[0]*x+b[1]*y+b[2]];
  }
  const byId = new Map();
  const collected = new Set();
  const enabledTypes = new Set(Object.keys(types).map(Number));
  const map = $('map');
  let region = 'main',status = 'all';
  let scale = 1,tx = 0,ty = 0,fitScale = 1,renderRequest = 0;
  let undo = null,toastTimer,backupMode = 'export',lastMapSize;
  let storageOK = true;
  const layers = new Map();
  const tileCache = new Map();
  const MAX_REQUESTS=4,MAX_CACHED_TILES=96;
  let wantedTiles=new Set(),activeRequests=0,maxActiveRequests=0;
  for(const [key,config] of Object.entries(mapConfigs)) {
    const layer=document.createElement('div'),preview=document.createElement('img');
    const [,,cw,ch]=config.crop,u=config.unit;
    layer.className='map-layer';layer.dataset.region=key;
    layer.style.width=cw*u+'px';layer.style.height=ch*u+'px';
    preview.className='map-image map-preview';preview.alt=config.name+'地图';preview.draggable=false;preview.decoding='async';
    preview.addEventListener('load',updateImageStatus);
    preview.addEventListener('error',()=>{layer.dataset.failed='true';updateImageStatus();});
    layer.append(preview);$('map-layers').append(layer);
    layers.set(key,{layer,preview,config});
  }
  function updateImageStatus() {
    const visible=[...layers.entries()].filter(([key])=>key===region).map(([,value])=>value);
    const failed=visible.some(v=>v.layer.dataset.failed==='true')||[...wantedTiles].some(key=>tileCache.get(key)?.state==='error');
    const pending=visible.filter(v=>!v.preview.complete||!v.preview.naturalWidth).length+[...wantedTiles].filter(key=>tileCache.get(key)?.state!=='ready').length;
    map.setAttribute('aria-busy',String(!failed&&pending>0));
    map.dataset.activeRequests=activeRequests;map.dataset.maxActiveRequests=maxActiveRequests;
    map.dataset.cachedTiles=tileCache.size;
    $('map-status').textContent=failed?'部分底图加载失败':pending?'正在加载底图…':regions[region].name;
  }
  function updateLayers() {
    for(const [key,{layer,preview,config}] of layers) {
      const show=region===key;layer.hidden=!show;
      if(show&&!preview.hasAttribute('src'))preview.src=config.tiles.base+'/0/0-0.webp';
    }
    updateImageStatus();
  }
  function disposeTile(entry) {
    entry.cancelled=true;entry.controller?.abort();entry.cancelDirect?.();entry.img.remove();
    if(entry.objectURL)URL.revokeObjectURL(entry.objectURL);
    tileCache.delete(entry.key);
  }
  async function loadTile(entry) {
    entry.state='loading';activeRequests++;maxActiveRequests=Math.max(maxActiveRequests,activeRequests);
    updateImageStatus();
    try {
      if(location.protocol==='file:') {
        const loaded=await new Promise((resolve,reject)=>{
          entry.img.onload=()=>resolve(true);entry.img.onerror=()=>reject(new Error('Tile loading failed'));
          entry.cancelDirect=()=>{entry.img.onload=null;entry.img.onerror=null;entry.img.removeAttribute('src');resolve(false);};
          entry.img.src=entry.url;
        });
        if(!loaded||entry.cancelled)return;
      } else {
        entry.controller=new AbortController();
        const response=await fetch(entry.url,{signal:entry.controller.signal});
        if(!response.ok)throw new Error('Tile HTTP '+response.status);
        const blob=await response.blob();if(entry.cancelled)return;
        entry.objectURL=URL.createObjectURL(blob);entry.img.src=entry.objectURL;
        await entry.img.decode();if(entry.cancelled)return;
      }
      entry.state='ready';entry.img.hidden=false;
    } catch(error) {
      if(!entry.cancelled&&error.name!=='AbortError')entry.state='error';
    } finally {
      activeRequests--;scheduleMap();pumpTiles();updateImageStatus();
    }
  }
  function pumpTiles() {
    const queue=[...tileCache.values()].filter(e=>e.state==='queued'&&wantedTiles.has(e.key)).sort((a,b)=>a.priority-b.priority);
    while(activeRequests<MAX_REQUESTS&&queue.length)loadTile(queue.shift());
  }
  function tileOnScreen(entry,margin=0) {
    const x=entry.worldX*scale+tx,y=entry.worldY*scale+ty;
    return x+entry.worldW*scale>=-margin&&y+entry.worldH*scale>=-margin&&x<=map.clientWidth+margin&&y<=map.clientHeight+margin;
  }
  function updateTiles() {
    const needed=new Set(),dpr=Math.min(window.devicePixelRatio||1,2);
    for(const [regionKey,{layer,config}] of layers) {
      if(layer.hidden)continue;
      const [ox,oy]=config.position,[,,cw,ch]=config.crop,u=config.unit;
      const levels=config.tiles.levels,last=levels.length-1;
      const z=Math.max(0,Math.min(last,Math.ceil(last+Math.log2(Math.max(scale*u*dpr,.0001)))));
      const level=levels[z],size=config.tiles.size;
      const pxPerLevelX=cw/level.width,pxPerLevelY=ch/level.height;
      const left=Math.max(0,(-tx/scale-ox)/u),top=Math.max(0,(-ty/scale-oy)/u);
      const right=Math.min(cw,((map.clientWidth-tx)/scale-ox)/u),bottom=Math.min(ch,((map.clientHeight-ty)/scale-oy)/u);
      if(right<=left||bottom<=top)continue;
      const x0=Math.max(0,Math.floor(left/pxPerLevelX/size)),y0=Math.max(0,Math.floor(top/pxPerLevelY/size));
      const x1=Math.min(level.cols-1,Math.floor(right/pxPerLevelX/size)),y1=Math.min(level.rows-1,Math.floor(bottom/pxPerLevelY/size));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++) {
        const key=regionKey+'/'+z+'/'+x+'/'+y;needed.add(key);
        const localX=x*size*pxPerLevelX*u,localY=y*size*pxPerLevelY*u;
        const worldW=Math.min(size,level.width-x*size)*pxPerLevelX*u,worldH=Math.min(size,level.height-y*size)*pxPerLevelY*u;
        const priority=Math.hypot((ox+localX+worldW/2)*scale+tx-map.clientWidth/2,(oy+localY+worldH/2)*scale+ty-map.clientHeight/2);
        let entry=tileCache.get(key);
        if(!entry) {
          const img=document.createElement('img');img.className='map-image map-tile';img.alt='';img.draggable=false;img.decoding='async';img.hidden=true;
          img.style.left=localX+'px';img.style.top=localY+'px';img.style.width=worldW+'px';img.style.height=worldH+'px';img.style.zIndex=z+1;
          const url=config.tiles.base+'/'+z+'/'+x+'-'+y+'.webp';img.dataset.tileUrl=url;
          entry={key,region:regionKey,url,img,state:'queued',worldX:ox+localX,worldY:oy+localY,worldW,worldH};
          tileCache.set(key,entry);layer.append(img);
        }
        entry.priority=priority;entry.lastUsed=performance.now();
      }
    }
    wantedTiles=needed;
    for(const entry of [...tileCache.values()]) {
      if(!needed.has(entry.key)&&(entry.state==='queued'||entry.state==='loading')){disposeTile(entry);continue;}
      entry.img.hidden=entry.state!=='ready'||entry.region!==region||!tileOnScreen(entry);
    }
    const unused=[...tileCache.values()].filter(e=>!needed.has(e.key)&&e.state==='ready').sort((a,b)=>a.lastUsed-b.lastUsed);
    while(tileCache.size>MAX_CACHED_TILES&&unused.length)disposeTile(unused.shift());
    pumpTiles();updateImageStatus();
  }
  window.addEventListener('online',()=>{
    for(const entry of [...tileCache.values()])if(entry.state==='error')disposeTile(entry);
    scheduleMap();
  });
  const number = id => '#' + String(id).padStart(3,'0');
  const svg = body => '<svg viewBox="0 0 24 24" aria-hidden="true">'+body+'</svg>';
  function icon(type) {
    const key = types[type].icon;
    if(key==='travel') return svg('<path d="m13 2-8 12h6l-1 8 9-13h-7Z"/>');
    if(key==='barn') return svg('<path d="m3 10 9-7 9 7v11H3Z"/><path d="M8 21V11h8v10M8 15h8m-8-4 8 10m0-10L8 21"/>');
    if(key==='camera') return svg('<path d="M3 7h5l2-3h4l2 3h5v13H3Z"/><circle cx="12" cy="13" r="4"/>');
    return key;
  }
  for(const [id,type,x,y] of points) {
    const key=types[type].region,config=mapConfigs[key];
    const [imageX,imageY]=imagePoint(key,x,y),[cx,cy]=config.crop,[ox,oy]=config.position;
    const p = {id,type,x:ox+(imageX-cx)*config.unit,y:oy+(imageY-cy)*config.unit,region:key};
    byId.set(id,p);
    const button = document.createElement('button');
    button.className = 'marker';button.dataset.id=id;button.style.setProperty('--color',types[type].color);
    button.innerHTML = icon(type);button.addEventListener('click',e=>{
      e.stopPropagation();if(suppressClick)return;
      setCollected(id,!collected.has(id));
    });
    p.el=button;$('markers').append(button);
  }
  function updateSaveStatus(ok,reason='') {
    storageOK=ok;
    $('save-status').classList.toggle('error-state',!ok);
    $('save-status').replaceChildren();
    $('save-status').append(document.createElement('i'),document.createTextNode(ok?'进度自动保存在此浏览器':reason || '浏览器无法保存，请导出进度备份'));
  }
  function loadProgress() {
    try {
      const next=new Set();
      for(const id of byId.keys()) if(localStorage.getItem(PREFIX+id)==='1')next.add(id);
      collected.clear();next.forEach(id=>collected.add(id));
      return true;
    } catch {
      updateSaveStatus(false);
      notify('无法读取浏览器存储；请允许本地存储后刷新。');
      return false;
    }
  }
  function setCollected(id,value) {
    try {
      localStorage.setItem(PREFIX+id,value?'1':'0');
      updateSaveStatus(true);
    } catch {
      updateSaveStatus(false,'保存失败，本次标记未更改');
      notify('进度保存失败。请检查浏览器存储空间或隐私设置。');
      return false;
    }
    if(value)collected.add(id);else collected.delete(id);
    render();
    clearTimeout(toastTimer);$('toast').hidden=true;undo=null;
    return true;
  }
  function notify(message,canUndo=false) {
    clearTimeout(toastTimer);$('toast-text').textContent=message;
    $('undo-button').hidden=!canUndo;$('toast').hidden=false;
    toastTimer=setTimeout(()=>{$('toast').hidden=true;},6500);
  }
  function regionPoints() {return [...byId.values()].filter(p=>p.region===region);}
  function matches(p) {
    if(p.region!==region)return false;
    if(!enabledTypes.has(p.type))return false;
    if(status==='todo'&&collected.has(p.id)||status==='done'&&!collected.has(p.id))return false;
    return true;
  }
  function buildCategories() {
    $('categories').replaceChildren();
    for(const [key,t] of Object.entries(types)) {
      if(t.region!==region)continue;
      const id=Number(key),button=document.createElement('button');button.className='category';
      button.dataset.type=id;button.style.setProperty('--color',t.color);
      button.innerHTML='<span class="category-icon">'+icon(id)+'</span><span class="category-name"></span><span class="category-count"><b>0</b> / '+t.total+'</span><span class="category-check" aria-hidden="true">✓</span>';
      button.querySelector('.category-name').textContent=t.short;
      button.addEventListener('click',()=>{
        if(enabledTypes.has(id))enabledTypes.delete(id);else enabledTypes.add(id);
        render();
      });$('categories').append(button);
    }
  }
  function render() {
    const done=collected.size,percent=done===0?0:done===points.length?100:(done/points.length*100).toFixed(1),current=regionPoints();
    $('total-done').textContent=done;$('total-percent').textContent=percent+'%';$('total-bar').style.width=percent+'%';
    $('remaining').textContent='未收集 '+(points.length-done)+' 个';
    let visible=0;
    for(const p of byId.values()) {
      const checked=collected.has(p.id),show=matches(p);visible+=Number(show);p.el.hidden=!show;
      p.el.classList.toggle('done',checked);
      p.el.setAttribute('aria-label',types[p.type].name+' '+number(p.id)+'，'+(checked?'已收集，点击取消':'未收集，点击收集'));
      p.el.setAttribute('aria-pressed',String(checked));p.el.title=types[p.type].name+' '+number(p.id)+(checked?' · 已收集':' · 未收集');
      p.el.innerHTML=checked?'✓':icon(p.type);
    }
    for(const button of $('categories').children) {
      const type=Number(button.dataset.type),count=points.filter(p=>p[1]===type&&collected.has(p[0])).length;
      button.setAttribute('aria-pressed',String(enabledTypes.has(type)));
      button.setAttribute('aria-label',types[type].name+'，已收集 '+count+' / '+types[type].total+'，'+(enabledTypes.has(type)?'点击隐藏':'点击显示'));
      button.querySelector('b').textContent=count;
    }
    const activeTypes=Object.entries(types).filter(([,t])=>t.region===region).map(([k])=>Number(k));
    $('toggle-types').textContent=activeTypes.every(t=>enabledTypes.has(t))?'全部隐藏':'全部显示';
    $('visible-count').textContent=visible;$('mobile-count').textContent=visible;
    $('region-progress').textContent=current.filter(p=>collected.has(p.id)).length+' / '+current.length+' 已收集';
    for(const b of $('status-filter').children)b.setAttribute('aria-pressed',String(b.dataset.status===status));
    scheduleMap();
  }
  function scheduleMap() {
    if(renderRequest)return;
    renderRequest=requestAnimationFrame(()=>{renderRequest=0;drawMap();});
  }
  function clampPosition() {
    const [x,y,w,h]=regions[region].box;
    tx=Math.max(60-(x+w)*scale,Math.min(map.clientWidth-60-x*scale,tx));
    ty=Math.max(60-(y+h)*scale,Math.min(map.clientHeight-60-y*scale,ty));
  }
  function drawMap() {
    clampPosition();
    const markerSize=Math.max(14,Math.min(26,scale*35+5));
    map.style.setProperty('--marker-size',markerSize+'px');
    for(const [key,{layer}] of layers) {
      const [x,y]=regions[key].box;
      layer.style.transform='translate('+(x*scale+tx)+'px,'+(y*scale+ty)+'px) scale('+scale+')';
    }
    for(const p of byId.values())if(!p.el.hidden)p.el.style.transform='translate('+(p.x*scale+tx)+'px,'+(p.y*scale+ty)+'px) translate(-50%,-50%)';
    $('zoom-level').textContent=Math.round(scale*100)+'%';
    updateTiles();
  }
  function fitMap() {
    const [x,y,w,h]=regions[region].box;
    const pad=map.clientWidth<500?26:40;
    fitScale=Math.min((map.clientWidth-pad*2)/w,(map.clientHeight-pad*2-25)/h);
    scale=Math.max(.1,fitScale);tx=(map.clientWidth-w*scale)/2-x*scale;ty=(map.clientHeight-25-h*scale)/2-y*scale;
    scheduleMap();
  }
  function zoom(factor,x=map.clientWidth/2,y=map.clientHeight/2) {
    const next=Math.min(8,Math.max(Math.min(fitScale*.65,.15),scale*factor));
    const ratio=next/scale;tx=x-(x-tx)*ratio;ty=y-(y-ty)*ratio;scale=next;scheduleMap();
  }
  function changeRegion(next) {
    region=next;
    for(const b of $('regions').children)b.setAttribute('aria-pressed',String(b.dataset.region===region));
    updateLayers();buildCategories();fitMap();render();
  }
  function syncSidebar() {const mobile=innerWidth<=760,open=$('sidebar').classList.contains('open');$('sidebar').inert=mobile&&!open;document.querySelector('.main').inert=mobile&&open;if(!mobile)$('sidebar-scrim').hidden=true;}
  function closeSidebar() {$('sidebar').classList.remove('open');$('sidebar-scrim').hidden=true;$('mobile-filters').setAttribute('aria-expanded','false');syncSidebar();}
  window.addEventListener('resize',syncSidebar);syncSidebar();
  $('regions').addEventListener('click',e=>{const b=e.target.closest('[data-region]');if(b)changeRegion(b.dataset.region);});
  $('status-filter').addEventListener('click',e=>{const b=e.target.closest('[data-status]');if(b){status=b.dataset.status;render();}});
  $('toggle-types').addEventListener('click',()=>{const active=Object.entries(types).filter(([,t])=>t.region===region).map(([k])=>Number(k));const hide=active.every(t=>enabledTypes.has(t));active.forEach(t=>hide?enabledTypes.delete(t):enabledTypes.add(t));render();});
  $('zoom-in').addEventListener('click',()=>zoom(1.3));$('zoom-out').addEventListener('click',()=>zoom(1/1.3));$('fit-map').addEventListener('click',fitMap);
  $('dim-map').addEventListener('click',()=>{const dim=map.classList.toggle('dim');$('dim-map').setAttribute('aria-pressed',String(dim));});
  $('mobile-filters').setAttribute('aria-expanded','false');$('mobile-filters').addEventListener('click',()=>{$('sidebar').classList.add('open');$('sidebar-scrim').hidden=false;$('mobile-filters').setAttribute('aria-expanded','true');syncSidebar();});
  $('close-sidebar').addEventListener('click',closeSidebar);$('sidebar-scrim').addEventListener('click',closeSidebar);
  $('close-toast').addEventListener('click',()=>{$('toast').hidden=true;});
  $('undo-button').addEventListener('click',()=>{
    if(!undo)return;const changes=undo;undo=null;
    let ok=true;for(const [id,value] of changes)if(!setCollected(id,value))ok=false;
    if(ok)notify('已撤销上次操作');
  });
  map.addEventListener('wheel',e=>{
    if(e.target.closest('.map-tools'))return;
    e.preventDefault();const rect=map.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0015),e.clientX-rect.left,e.clientY-rect.top);
  },{passive:false});
  const pointers=new Map();let gesture=null,suppressClick=false;
  function startGesture() {
    const ps=[...pointers.values()],r=map.getBoundingClientRect();
    if(ps.length===1)gesture={x:ps[0].x,y:ps[0].y,tx,ty,moved:false};
    if(ps.length>=2){const [a,b]=ps;gesture={cx:(a.x+b.x)/2-r.left,cy:(a.y+b.y)/2-r.top,distance:Math.hypot(a.x-b.x,a.y-b.y),scale,tx,ty,moved:true};suppressClick=true;}
  }
  map.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.target.closest('button'))return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});map.setPointerCapture(e.pointerId);startGesture();
  });
  map.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId)||!gesture)return;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});const ps=[...pointers.values()];
    if(ps.length===1){const dx=e.clientX-gesture.x,dy=e.clientY-gesture.y;if(Math.hypot(dx,dy)>4)gesture.moved=true;tx=gesture.tx+dx;ty=gesture.ty+dy;}
    else{const [a,b]=ps,r=map.getBoundingClientRect(),distance=Math.hypot(a.x-b.x,a.y-b.y),cx=(a.x+b.x)/2-r.left,cy=(a.y+b.y)/2-r.top;scale=Math.min(8,Math.max(.1,gesture.scale*distance/Math.max(gesture.distance,1)));const ratio=scale/gesture.scale;tx=cx-(gesture.cx-gesture.tx)*ratio;ty=cy-(gesture.cy-gesture.ty)*ratio;}
    if(gesture.moved){map.classList.add('dragging');suppressClick=true;}scheduleMap();
  });
  function finishPointer(e) {
    if(!pointers.has(e.pointerId))return;
    pointers.delete(e.pointerId);if(pointers.size)startGesture();else{gesture=null;map.classList.remove('dragging');setTimeout(()=>{suppressClick=false;},0);}
  }
  map.addEventListener('pointerup',finishPointer);map.addEventListener('pointercancel',finishPointer);
  map.addEventListener('dblclick',e=>{if(e.target.closest('button'))return;const r=map.getBoundingClientRect();zoom(1.5,e.clientX-r.left,e.clientY-r.top);});
  document.addEventListener('keydown',e=>{
    if(e.target.closest('input,textarea,select')||document.querySelector('dialog[open]'))return;
    if(e.key==='Escape'){closeSidebar();return;}
    if(e.target.closest('button'))return;
    const actions={'+':()=>zoom(1.3),'=':()=>zoom(1.3),'-':()=>zoom(1/1.3),'0':fitMap,ArrowLeft:()=>{tx+=80;},ArrowRight:()=>{tx-=80;},ArrowUp:()=>{ty+=80;},ArrowDown:()=>{ty-=80;}};
    if(actions[e.key]){e.preventDefault();actions[e.key]();scheduleMap();}
  });
  function backupObject() {return {app:'fh3-local-map',version:1,exportedAt:new Date().toISOString(),source:window.FH3_DATA.source,total:points.length,collected:[...collected].sort((a,b)=>a-b)};}
  function openBackup(mode) {
    backupMode=mode;$('backup-title').textContent=mode==='export'?'导出收集进度':'导入收集进度';
    $('backup-intro').textContent=mode==='export'?'下载备份后，可在其他浏览器或电脑上导入。当前已收集 '+collected.size+' / '+points.length+'。':'选择之前导出的 JSON 文件，或粘贴备份内容。导入前会校验全部编号。';
    $('import-file-row').hidden=mode!=='import';$('replace-row').hidden=mode!=='import';$('replace-progress').checked=false;
    $('backup-content').readOnly=mode==='export';$('backup-content').value=mode==='export'?JSON.stringify(backupObject(),null,2):'';
    $('backup-content').placeholder=mode==='import'?'粘贴 FH3 收集地图导出的 JSON 备份…':'';
    $('backup-submit').textContent=mode==='export'?'下载 JSON 备份':'合并进度';$('backup-error').hidden=true;$('import-file').value='';
    $('backup-dialog').showModal();
  }
  $('export-button').addEventListener('click',()=>openBackup('export'));$('import-button').addEventListener('click',()=>openBackup('import'));
  $('close-backup').addEventListener('click',()=>$('backup-dialog').close());$('cancel-backup').addEventListener('click',()=>$('backup-dialog').close());
  $('replace-progress').addEventListener('change',()=>{$('backup-submit').textContent=$('replace-progress').checked?'替换进度':'合并进度';});
  $('import-file').addEventListener('change',async()=>{
    const file=$('import-file').files[0];if(!file)return;
    if(file.size>1024*1024){backupError('文件过大，请选择本地图导出的 JSON 备份（最大 1 MB）。');return;}
    try{$('backup-content').value=await file.text();$('backup-error').hidden=true;}catch{backupError('文件读取失败，请重试或粘贴内容。');}
  });
  function backupError(message){$('backup-error').textContent=message;$('backup-error').hidden=false;}
  $('backup-submit').addEventListener('click',()=>{
    if(backupMode==='export'){
      const blob=new Blob([$('backup-content').value],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download='FH3-收集进度-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);return;
    }
    let data;
    try{
      if($('backup-content').value.length>1024*1024)throw new Error('备份内容过大。');
      data=JSON.parse($('backup-content').value);
      if(!data||data.app!=='fh3-local-map'||data.version!==1||!Array.isArray(data.collected))throw new Error('备份格式不匹配。请选择 FH3 收集地图导出的版本 1 备份。');
      if(data.collected.length>points.length||new Set(data.collected).size!==data.collected.length||data.collected.some(id=>!Number.isInteger(id)||!byId.has(id)))throw new Error('备份包含重复或无效的要素编号，未导入任何进度。');
    }catch(e){backupError(e instanceof SyntaxError?'JSON 格式无效，请粘贴完整备份内容。':e.message);return;}
    const incoming=new Set(data.collected),changes=new Map(),replace=$('replace-progress').checked;
    // Refresh before a bulk action; individual keys avoid overwriting concurrent edits to other points.
    if(!loadProgress()){backupError('无法读取当前进度，请先允许浏览器存储后重试。');return;}
    for(const id of byId.keys()){
      const value=incoming.has(id)||(replace?false:collected.has(id));
      if(value!==collected.has(id))changes.set(id,collected.has(id));
    }
    try{
      for(const [id] of changes)localStorage.setItem(PREFIX+id,incoming.has(id)?'1':'0');
    }catch{
      let restored=true;for(const [id,old] of changes){try{localStorage.setItem(PREFIX+id,old?'1':'0');}catch{restored=false;}}
      loadProgress();render();updateSaveStatus(false);
      backupError(restored?'保存失败，已恢复原进度。请检查浏览器存储后重试。':'浏览器存储异常，无法完整恢复。请先导出当前进度并检查存储设置。');return;
    }
    loadProgress();updateSaveStatus(true);undo=changes;render();$('backup-dialog').close();
    notify('已'+(replace?'替换':'合并')+'备份，更新 '+changes.size+' 个标记',changes.size>0);
  });
  window.addEventListener('storage',e=>{
    if(e.key===null||e.key.startsWith(PREFIX)){
      loadProgress();render();
    }
  });
  window.addEventListener('focus',()=>{loadProgress();render();});
  new ResizeObserver(()=>{
    const size=[map.clientWidth,map.clientHeight];
    if(!lastMapSize){lastMapSize=size;return;}
    tx+=(size[0]-lastMapSize[0])/2;ty+=(size[1]-lastMapSize[1])/2;lastMapSize=size;scheduleMap();
  }).observe(map);
  loadProgress();updateLayers();buildCategories();fitMap();zoom(innerWidth>760?1.8:1.4);render();
})();
