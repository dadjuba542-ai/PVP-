(() => {
  const style = document.createElement('style');
  style.textContent = `
    #pvp-entry{position:fixed;inset:0;z-index:110;display:grid;place-items:center;background:rgba(4,8,11,.82);color:#e8e4da;font-family:system-ui,sans-serif}
    #pvp-entry.hidden{display:none}#pvp-entry .card{width:min(440px,calc(100vw - 32px));padding:28px;background:#14191d;border:1px solid #5b6263;box-shadow:0 24px 90px #000b}
    #pvp-entry h1{margin:0 0 8px;font-size:34px}#pvp-entry p{color:#b5bbb8;line-height:1.5}#pvp-entry label{display:block;margin:18px 0 5px;font-size:13px;color:#ffb347}
    #pvp-entry input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #777;background:#0b0d0f;color:white;font:16px system-ui}
    #pvp-entry button{margin-top:22px;width:100%;padding:13px;background:#ffb347;color:#101213;border:0;font-weight:800;font-size:17px;cursor:pointer}
    #pvp-status{position:fixed;z-index:85;top:12px;left:12px;padding:9px 12px;background:#0b0d0fcc;color:#fff;font:13px system-ui;pointer-events:none}
    #pvp-score{position:fixed;z-index:85;top:52px;left:12px;padding:9px 12px;background:#0b0d0fcc;color:#fff;font:13px/1.6 system-ui;min-width:175px;pointer-events:none}
    #pvp-feed{position:fixed;z-index:85;top:12px;right:12px;max-width:45vw;color:#ffb347;text-align:right;text-shadow:0 2px 4px black;font:14px system-ui;pointer-events:none}
    #pvp-dead{position:fixed;z-index:90;inset:0;display:none;place-items:center;background:#28090077;color:#fff;text-align:center;font:800 42px system-ui;pointer-events:none}
    #pvp-dead.on{display:grid}#pvp-dead small{display:block;font:18px system-ui;margin-top:10px}
    .h-obj,.h-marks,.h-cmarks{display:none!important}
  `;
  document.head.append(style);
  const entry = document.createElement('div');
  entry.id = 'pvp-entry';
  entry.innerHTML = `<div class="card"><h1>几猫 · 港区对决</h1><p>随机位置出生，自由混战。最多 8 人，同一房间码即可加入。</p><label>昵称</label><input id="pvp-name" maxlength="16" autocomplete="nickname"><label>房间码</label><input id="pvp-room" maxlength="12" autocomplete="off"><button id="pvp-join" disabled>正在加载游戏…</button><p id="pvp-message">等待场景就绪</p><p>WASD 移动 · 鼠标射击 · R 换弹 · Shift 冲刺 · Esc 释放鼠标</p></div>`;
  document.body.append(entry);
  const status = document.createElement('div'); status.id='pvp-status'; status.textContent='尚未连接'; document.body.append(status);
  const score = document.createElement('div'); score.id='pvp-score'; document.body.append(score);
  const feed = document.createElement('div'); feed.id='pvp-feed'; document.body.append(feed);
  const dead = document.createElement('div'); dead.id='pvp-dead'; dead.innerHTML='阵亡<small>3 秒后随机位置重生</small>'; document.body.append(dead);
  const nameInput = document.getElementById('pvp-name');
  const roomInput = document.getElementById('pvp-room');
  const button = document.getElementById('pvp-join');
  const message = document.getElementById('pvp-message');
  nameInput.value = localStorage.getItem('pvp-name') || '队员' + Math.floor(Math.random()*100);
  roomInput.value = new URLSearchParams(location.search).get('room') || 'PORT';
  let G, socket, myId, room, currentPlayers = [], lastState = 0;
  const remote = new Map();
  const V = (x,y,z) => new G.THREE.Vector3(x,y,z);
  const send = data => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
  function say(text) {
    const line = document.createElement('div'); line.textContent=text; feed.prepend(line);
    setTimeout(() => line.remove(), 4500);
  }
  function makeAvatar(id) {
    const T=G.THREE, group=new T.Group();
    const orange=new T.MeshStandardMaterial({color:0xff9e35,roughness:.55,metalness:.18});
    const dark=new T.MeshStandardMaterial({color:0x1a252c,roughness:.75});
    const skin=new T.MeshStandardMaterial({color:0xd6ccc0,roughness:.8});
    const add=(geo,mat,x,y,z)=>{const mesh=new T.Mesh(geo,mat);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;group.add(mesh);};
    add(new T.BoxGeometry(.64,.82,.3),orange,0,1.06,0);
    add(new T.SphereGeometry(.22,10,8),skin,0,1.64,0);
    add(new T.BoxGeometry(.67,.13,.2),dark,0,1.83,0);
    add(new T.BoxGeometry(.2,.7,.23),dark,-.48,1.01,0);
    add(new T.BoxGeometry(.2,.7,.23),dark,.48,1.01,0);
    add(new T.BoxGeometry(.2,.78,.23),dark,-.18,.4,0);
    add(new T.BoxGeometry(.2,.78,.23),dark,.18,.4,0);
    add(new T.BoxGeometry(.15,.14,.65),dark,.33,1.14,-.43);
    group.userData.targetPos = new T.Vector3();
    G.scene.add(group); remote.set(id,group); return group;
  }
  function resetAt(pos) {
    G.player.reset({pos:V(...pos),yaw:Math.random()*Math.PI*2});
    G.player.enabled=true; G.player.alive=true; G.player.health=100;
    G.weapon.reset?.(); G.weapon.setVisible?.(true);
    G.input.setGameplay?.(true);
    dead.classList.remove('on');
  }
  function installPvp() {
    G.game.menus?.show('none');
    // The original title camera fades the entire rendered scene to black.
    // Its game loop is replaced below, so that fade must be cleared here.
    G.render.post.fade=0;
    G.render.post.saturation=1;
    G.hud.show?.(false);
    G.weapon.setVisible?.(false);
    G.player.enabled=false;
    G.input.setGameplay?.(false);
    G.enemies.update=()=>{};
    G.game={state:'title',update(){G.render.post.fade=0;return this.state==='playing';}};
    const originalShot=G.combat.playerShot.bind(G.combat);
    G.combat.playerShot=(origin,dir,opts={})=>{
      const wall=G.physics.raycast(origin,dir,opts.range||300);
      let best=null, limit=wall?.dist ?? (opts.range||300);
      for(const [id, avatar] of remote){
        if(!avatar.visible) continue;
        const center=avatar.position.clone().add(V(0,1.0,0));
        const along=center.sub(origin).dot(dir);
        if(along<=0 || along>=limit) continue;
        const closest=origin.clone().addScaledVector(dir,along);
        const miss=Math.hypot(closest.x-avatar.position.x,closest.z-avatar.position.z);
        if(miss<.48 && Math.abs(closest.y-avatar.position.y-1.0)<.85){best={id,dist:along,point:closest};limit=along;}
      }
      send({type:'shot',target:best?.id||null,origin:origin.toArray(),dir:dir.toArray()});
      if(best){
        G.combat.stats.shots++; G.combat.stats.hits++;
        return {point:best.point,dist:best.dist,surface:'enemy',enemy:null};
      }
      return originalShot(origin,dir,opts);
    };
  }
  function onMessage(msg) {
    if(msg.type==='error'){message.textContent=msg.text;button.disabled=false;return;}
    if(msg.type==='welcome'){
      myId=msg.id;room=msg.room;
      entry.classList.add('hidden'); G.game.state='playing';
      G.audio?.resume?.(); G.hud.show?.(true);
      resetAt(msg.pos); G.input.requestLock?.();
      status.textContent=`房间 ${room} · 已连接`;
      history.replaceState(null,'',`?room=${encodeURIComponent(room)}`);
      say('已加入房间，开始对决！'); return;
    }
    if(msg.type==='snapshot'){
      currentPlayers=msg.players;
      const ids=new Set();
      for(const p of msg.players){
        if(p.id===myId){G.player.health=p.hp;continue;}
        ids.add(p.id);
        const fresh=!remote.has(p.id), avatar=remote.get(p.id)||makeAvatar(p.id);
        avatar.userData.targetPos.set(...p.pos);
        if(fresh) avatar.position.copy(avatar.userData.targetPos);
        avatar.userData.targetYaw=p.yaw;
        avatar.visible=p.alive;
      }
      for(const [id, avatar] of remote) if(!ids.has(id)){G.scene.remove(avatar);remote.delete(id);}
      const sorted=[...msg.players].sort((a,b)=>b.kills-a.kills||a.deaths-b.deaths);
      score.innerHTML='<b>击杀 / 阵亡</b><br>'+sorted.map(p=>`${p.id===myId?'▶ ':''}${escapeText(p.name)}　${p.kills} / ${p.deaths}`).join('<br>');
      status.textContent=`房间 ${room} · ${msg.players.length}/8 人`;
      return;
    }
    if(msg.type==='hurt'){
      G.player.health=msg.hp;
      G.player.addShake?.(.25);
      if(!msg.hp){G.player.alive=false;G.player.enabled=false;G.input.setGameplay?.(false);dead.classList.add('on');}
      return;
    }
    if(msg.type==='respawn'){resetAt(msg.pos);say('已重生');return;}
    if(msg.type==='hit'){say('命中 '+(currentPlayers.find(p=>p.id===msg.target)?.name||'对手'));return;}
    if(msg.type==='kill'){say(`${msg.killer} 击败 ${msg.victim}`);return;}
    if(msg.type==='notice'||msg.type==='left'){say(msg.text);return;}
    if(msg.type==='fire'&&Array.isArray(msg.origin)&&Array.isArray(msg.dir)){
      const a=V(...msg.origin),b=V(...msg.dir).multiplyScalar(30).add(a);
      G.fx.tracer?.(a,b);
    }
  }
  function escapeText(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function frame(time) {
    if(G && myId && socket?.readyState===WebSocket.OPEN){
      if(time-lastState>50){lastState=time;send({type:'state',pos:G.player.pos.toArray(),yaw:G.player.yaw,pitch:G.player.pitch});}
      for(const avatar of remote.values()){
        avatar.position.lerp(avatar.userData.targetPos,.28);
        avatar.rotation.y=avatar.userData.targetYaw||0;
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  const ready=setInterval(()=>{
    if(!window.__ready || !window.__G?.game) return;
    clearInterval(ready);G=window.__G;installPvp();button.disabled=false;button.textContent='加入房间';message.textContent='房间准备就绪';
  },100);
  button.addEventListener('click',()=>{
    if(!G) return;
    G.audio?.resume?.();
    G.input.setGameplay?.(true);
    G.input.requestLock?.();
    localStorage.setItem('pvp-name',nameInput.value.trim());
    button.disabled=true;message.textContent='正在连接房间…';
    socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
    socket.onopen=()=>send({type:'join',name:nameInput.value,room:roomInput.value});
    socket.onmessage=e=>{try{onMessage(JSON.parse(e.data));}catch(err){console.error('PVP message',err);}};
    socket.onclose=()=>{myId=null;status.textContent='连接已断开';entry.classList.remove('hidden');button.disabled=false;button.textContent='重新连接';message.textContent='连接已断开，可重新加入';G.game.state='title';G.player.enabled=false;G.input.setGameplay?.(false);};
    socket.onerror=()=>{message.textContent='连接失败，请确认服务端仍在运行';};
  });
})();
