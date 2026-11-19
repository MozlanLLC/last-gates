// Последние Врата — 3D-рендер (проба). Логика игры остаётся в index.html, здесь только отрисовка.
import * as THREE from 'three';
import {GLTFLoader} from './lib/loaders/GLTFLoader.js';
import {clone as skClone} from './lib/utils/SkeletonUtils.js';

const R = window.R3D = {ready:false,on:true,hide(){if(cv.style.display!=='none')cv.style.display='none';},frame(){},proj(){return null;},mh(){return 2.4;}};
const cv = document.getElementById('c3d');
const A = './3d/assets/';
const K = 0.1;               // 1 px игры = 0.1 юнита, тайл 40 px = 4 юнита
const G = () => window.__game.w3();

const renderer = new THREE.WebGLRenderer({canvas:cv, antialias:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 1.5));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.FogExp2(0x07080d, 0.018);
const camera = new THREE.PerspectiveCamera(36, 2, 0.5, 220);
const hemi = new THREE.HemisphereLight(0x6a78a8, 0x1a1410, 0.55); scene.add(hemi);
const moon = new THREE.DirectionalLight(0x8fa8ff, 0.55); moon.castShadow = true;
moon.shadow.mapSize.set(1024,1024); Object.assign(moon.shadow.camera,{left:-26,right:26,top:26,bottom:-26,near:1,far:90}); moon.shadow.bias=-0.0006; moon.shadow.normalBias=0.03;
scene.add(moon); scene.add(moon.target);
const heroLight = new THREE.PointLight(0xffc896, 60, 30, 1.6); scene.add(heroLight);
const TORCH_N = 6, torchLights = [];
for(let i=0;i<TORCH_N;i++){const l=new THREE.PointLight(0xff9a50, 0, 22, 1.7); scene.add(l); torchLights.push(l);}
const FX_N = 4, fxLights = [];
for(let i=0;i<FX_N;i++){const l=new THREE.PointLight(0xffffff, 0, 14, 1.8); scene.add(l); fxLights.push(l);}

function resize(){const w=window.innerWidth,h=window.innerHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
window.addEventListener('resize', resize); resize();

// ---------- загрузка ресурсов
const loader = new GLTFLoader();
const M = {};      // gltf по имени
async function ld(name, path){ M[name] = await loader.loadAsync(A+path); return M[name]; }
const HERO_MODEL = {human:'Knight', barb:'Barbarian', elf:'Rogue', delf:'Rogue_Hooded', dwarf:'Knight', beast:'Barbarian'};
const WEAP = {sword:'sword_1handed', gsword:'sword_2handed', axe:'axe_1handed', gaxe:'axe_2handed', dagger:'dagger', spear:'staff', bow:'crossbow_2handed', wand:'wand', staff:'staff'};
const TWOH = {gsword:1, gaxe:1, spear:1, staff:1, bow:1};
const CLIPS = {};
async function loadAll(){
  const g = G(), race = g.C ? g.C.race : 'human';
  const list = [
    ['anims','anims.glb'], ['hero', HERO_MODEL[race]+'.glb'],
    ['sk_min','Skeleton_Minion.glb'], ['sk_war','Skeleton_Warrior.glb'], ['sk_rog','Skeleton_Rogue.glb'], ['sk_mag','Skeleton_Mage.glb'],
    ['floor','d_floor_tile_large.glb'], ['floor2','d_floor_tile_large_rocks.glb'], ['floor3','d_floor_dirt_large.glb'], ['wall','d_wall.glb'], ['wallc','d_wall_cracked.glb'],
    ['torch','d_torch_mounted.glb'], ['chest','d_chest.glb'], ['chestg','d_chest_gold.glb'], ['barrel','d_barrel_large.glb'], ['crates','d_crates_stacked.glb'], ['pillar','d_pillar.glb'],
    ['spikes','d_floor_tile_big_spikes.glb'], ['rubble','d_rubble_large.glb'], ['candle','d_candle_triple.glb'], ['banner','d_banner_red.glb'], ['bones','d_sword_shield_broken.glb'],
  ];
  for(const w of new Set(Object.values(WEAP).concat(['shield_round','Skeleton_Blade','Skeleton_Axe','Skeleton_Staff','Skeleton_Crossbow','Skeleton_Shield_Small_A']))) list.push(['w_'+w, 'w/'+w+'.gltf']);
  await Promise.all(list.map(([n,p]) => ld(n,p).catch(e => console.warn('3D: нет', p, e))));
  for(const c of M.anims.animations) CLIPS[c.name] = c;
  M.anims.scene.traverse(()=>{});
}

// ---------- утилиты
function prep(obj, cast=true, recv=true){obj.traverse(o=>{if(o.isMesh){o.castShadow=cast;o.receiveShadow=recv;if(o.material&&o.material.map)o.material.map.anisotropy=4;}});return obj;}
function instFrom(gltf, cap){ // массив InstancedMesh, геометрия запечена в мировые координаты модели
  const arr=[]; gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(o=>{ if(o.isMesh){ const geo=o.geometry.clone(); geo.applyMatrix4(o.matrixWorld); const im=new THREE.InstancedMesh(geo,o.material,cap); im.count=0; im.castShadow=true; im.receiveShadow=true; im.frustumCulled=false; arr.push(im); }});
  return arr;
}
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), UP = new THREE.Vector3(0,1,0);
function setInst(arr, i, x, y, z, ry, sx=1, sy=1, sz=1){ tmpQ.setFromAxisAngle(UP, ry); tmpS.set(sx,sy,sz); tmpP.set(x,y,z); tmpM.compose(tmpP,tmpQ,tmpS); for(const im of arr) im.setMatrixAt(i, tmpM); }
function finishInst(arr, n){ for(const im of arr){ im.count=n; im.instanceMatrix.needsUpdate=true; } }
const colCache = {};
function col(c){ if(!c) return new THREE.Color(0xffffff); if(colCache[c]) return colCache[c]; let r; if(c[0]==='#') r=new THREE.Color(c); else if(c.startsWith('rgb')) { const m=c.match(/[\d.]+/g); r=new THREE.Color(m[0]/255,m[1]/255,m[2]/255); } else if(/^\d/.test(c)) { const m=c.split(','); r=new THREE.Color(m[0]/255,m[1]/255,m[2]/255); } else r=new THREE.Color(c); return colCache[c]=r; }

// ---------- уровень
let lvl = null;
function clearLevel(){ if(!lvl) return; scene.remove(lvl.group); lvl.group.traverse(o=>{ if(o.isInstancedMesh) o.dispose(); }); lvl=null; }
function buildLevel(g){
  clearLevel();
  const {map, MW, MH} = g, group = new THREE.Group(); scene.add(group);
  let nf=0, nw=0; for(let j=0;j<MH;j++) for(let i=0;i<MW;i++){ const v=map[j*MW+i]; if(v&&v!==4){ nf++; } }
  const fl=[instFrom(M.floor,nf), instFrom(M.floor2,nf), instFrom(M.floor3,nf)];
  const walls=instFrom(M.wall, nf*2), wallsC=instFrom(M.wallc, nf), low=instFrom(M.wall, nf), pil=instFrom(M.pillar, nf);
  for(const a of [...fl, walls, wallsC, low, pil]) for(const im of a) group.add(im);
  const water = new THREE.InstancedMesh(new THREE.PlaneGeometry(4,4).rotateX(-Math.PI/2), new THREE.MeshStandardMaterial({color:0x1d5a3a, emissive:0x0b2a18, roughness:0.15, metalness:0.2, transparent:true, opacity:0.85}), nf); water.count=0; water.receiveShadow=true; group.add(water);
  const torches=[], decor=[];
  lvl = {g, map, MW, MH, group, fl, walls, wallsC, low, pil, water, torches, seenSum:-1, tiles:[], decor, chests:new Map(), traps:new Map(), floor:g.floor};
  // дерево тайлов (рассчитывается один раз), видимость — по seen
  const solid=(i,j)=>i<0||j<0||i>=MW||j>=MH||!map[j*MW+i]||map[j*MW+i]===4;
  for(let j=0;j<MH;j++) for(let i=0;i<MW;i++){ const v=map[j*MW+i]; if(!v||v===4) continue;
    const t={i,j,v,h:g.hsh(i,j),w:[]};
    if(solid(i,j-1)) t.w.push(['n', map[(j-1)*MW+i]===4]);
    if(solid(i,j+1)) t.w.push(['s', false]);
    if(solid(i-1,j)) t.w.push(['w', false]);
    if(solid(i+1,j)) t.w.push(['e', false]);
    if(solid(i,j-1) && g.hsh(i+5,j-1+11)>0.84) t.torch=1;
    if(t.w.length>=2 && t.h>0.9 && v===1) t.deco = t.h>0.95 ? 'barrel' : 'crates';
    lvl.tiles.push(t); }
  updateTiles(g, true);
}
function updateTiles(g, force){
  const seen=g.seen; let sum=0; for(const t of lvl.tiles) if(seen[t.j*lvl.MW+t.i]) sum++;
  if(!force && sum===lvl.seenSum) return; lvl.seenSum=sum;
  const n=[0,0,0]; let nw=0, nwc=0, nl=0, np=0, nwa=0; lvl.torches.length=0;
  for(const d of lvl.decor) lvl.group.remove(d); lvl.decor.length=0;
  for(const t of lvl.tiles){ if(!seen[t.j*lvl.MW+t.i]) continue;
    const x=t.i*4+2, z=t.j*4+2;
    if(t.v===2){ tmpQ.identity(); tmpM.compose(tmpP.set(x,0.02,z),tmpQ,tmpS.set(1,1,1)); lvl.water.setMatrixAt(nwa++, tmpM); setInst(lvl.fl[2], n[2]++, x, -0.25, z, 0); continue; }
    const k = t.h<0.12 ? 1 : t.h>0.93 ? 2 : 0;
    setInst(lvl.fl[k], n[k]++, x, 0, z, Math.floor(t.h*4)*Math.PI/2);
    for(const [d, cracked] of t.w){
      if(d==='n'){ if(cracked) setInst(lvl.wallsC, nwc++, x, 0, z-2, 0); else setInst(lvl.walls, nw++, x, 0, z-2, 0); }
      else if(d==='s') setInst(lvl.low, nl++, x, 0, z+2, Math.PI, 1, 0.22, 1);
      else if(d==='w') setInst(lvl.walls, nw++, x-2, 0, z, Math.PI/2, 1, 0.75, 1);
      else setInst(lvl.walls, nw++, x+2, 0, z, -Math.PI/2, 1, 0.75, 1);
    }
    if(t.w.some(w=>w[0]==='n') && t.w.some(w=>w[0]==='w')) setInst(lvl.pil, np++, x-2, 0, z-2, 0, 0.7, 1.05, 0.7);
    if(t.w.some(w=>w[0]==='n') && t.w.some(w=>w[0]==='e')) setInst(lvl.pil, np++, x+2, 0, z-2, 0, 0.7, 1.05, 0.7);
    if(t.torch){ const o=M.torch.scene.clone(); o.position.set(x, 2.4, z-1.5); prep(o,false,false); lvl.group.add(o); lvl.decor.push(o); lvl.torches.push({x, z:z-1.0, ph:t.h*20}); }
    if(t.deco){ const src = t.deco==='barrel' ? M.barrel : M.crates; if(src){ const o=src.scene.clone(); const sx=t.w.some(w=>w[0]==='w')?-1.1:1.1, sz=t.w.some(w=>w[0]==='n')?-1.1:1.1; o.position.set(x+sx, 0, z+sz); o.rotation.y=t.h*6; o.scale.setScalar(0.75); prep(o); lvl.group.add(o); lvl.decor.push(o); } }
  }
  for(let q=0;q<3;q++) finishInst(lvl.fl[q], n[q]);
  finishInst(lvl.walls, nw); finishInst(lvl.wallsC, nwc); finishInst(lvl.low, nl); finishInst(lvl.pil, np);
  lvl.water.count=nwa; lvl.water.instanceMatrix.needsUpdate=true;
}

// ---------- персонажи
const ATT = {}; // weapons cache
function weapon(name){ const g=M['w_'+name]; if(!g) return null; const o=g.scene.clone(); prep(o); return o; }
function slot(model, name){ let s=null; model.traverse(o=>{ if(o.name===name) s=o; }); return s; }
function clearSlots(model){ for(const sn of ['handslot.r','handslot.l']){ const s=slot(model,sn); if(s) for(const c of [...s.children]) s.remove(c); } }
function makeChar(srcName, tint, scale){
  const src=M[srcName]; const model=skClone(src.scene); prep(model);
  if(tint){ const tc=col(tint); model.traverse(o=>{ if(o.isMesh){ o.material=o.material.clone(); o.material.color.lerp(tc, 0.35); } }); }
  model.scale.setScalar(scale||1); clearSlots(model);
  const mixer=new THREE.AnimationMixer(model); const acts={};
  const ch={model, mixer, acts, cur:null, once:null};
  ch.play=(name, opts={})=>{ const clip=CLIPS[name]; if(!clip) return; let a=acts[name]; if(!a){ a=mixer.clipAction(clip); acts[name]=a; }
    if(opts.once){ a.reset(); a.setLoop(THREE.LoopOnce,1); a.clampWhenFinished=!!opts.clamp; a.timeScale=opts.ts||1; a.fadeIn(0.08).play(); if(ch.cur&&ch.cur!==a) ch.cur.fadeOut(0.08); ch.once={a, end:performance.now()/1000 + clip.duration/(opts.ts||1)*(opts.cut||0.95), name}; ch.cur=a; return; }
    if(ch.once && performance.now()/1000 < ch.once.end) { ch.want=name; ch.wantTs=opts.ts||1; return; }
    if(ch.cur===a){ a.timeScale=opts.ts||1; return; }
    a.reset(); a.setLoop(THREE.LoopRepeat); a.timeScale=opts.ts||1; a.fadeIn(0.18).play(); if(ch.cur) ch.cur.fadeOut(0.18); ch.cur=a; ch.once=null; };
  return ch;
}
// герой
let heroCh=null, heroW='', heroPrev={x:0,y:0,swing:null,scd:{},dT:0,hp:0,state:''};
function heroWeapons(g){
  const C=g.C, w=C.eq.w&&g.B[C.eq.w.b]?g.B[C.eq.w.b].fam:'', o=C.eq.o&&g.B[C.eq.o.b]?(g.B[C.eq.o.b].fam||g.B[C.eq.o.b].slot):'', key=w+'|'+o+'|'+(C.eq.o?C.eq.o.b:'');
  if(key===heroW) return; heroW=key; clearSlots(heroCh.model);
  const r=slot(heroCh.model,'handslot.r'), l=slot(heroCh.model,'handslot.l');
  if(w&&WEAP[w]){ const m=weapon(WEAP[w]); if(m&&r) r.add(m); }
  if(C.eq.o){ const b=g.B[C.eq.o.b]; const isSh = b.slot==='o' && !b.fam; const m = isSh ? weapon('shield_round') : (b.fam&&WEAP[b.fam] ? weapon(WEAP[b.fam]) : null); if(m&&l) l.add(m); }
}
function heroAttackClip(g){ const C=g.C, w=C.eq.w&&g.B[C.eq.w.b]?g.B[C.eq.w.b].fam:''; const dual = C.eq.o && g.B[C.eq.o.b].fam;
  if(!w) return 'Unarmed_Melee_Attack_Punch_A'; if(w==='bow') return '2H_Ranged_Shoot'; if(w==='wand'||w==='staff') return 'Spellcast_Shoot';
  if(dual) return 'Dualwield_Melee_Attack_Chop'; if(TWOH[w]) return Math.random()<0.5?'2H_Melee_Attack_Chop':'2H_Melee_Attack_Slice';
  return Math.random()<0.5?'1H_Melee_Attack_Chop':'1H_Melee_Attack_Slice_Diagonal'; }
// монстры
const monMap = new Map(), dying = [];
function monKind(g, m){ const T=g.TYPES[m.type]||{}; if(m.type==='mimic') return 'mimic'; if(m.ai==='slime') return 'slime';
  if(m.ai==='boss'||m.ai==='guard') return 'war'; if(m.ai==='sling') return (T.proj==='void'||T.proj==='ice'||T.heal||T.summon||T.aura)?'mag':'rog'; return 'min'; }
function makeMon(g, m){
  const k=monKind(g,m), sc=Math.max(0.7, m.r/13) * (m.boss?1.15:1);
  let ch;
  if(k==='slime'){ const mat=new THREE.MeshStandardMaterial({color:col(m.col), roughness:0.25, metalness:0.05, transparent:true, opacity:0.82, emissive:col(m.col).clone().multiplyScalar(0.25)});
    const mesh=new THREE.Mesh(new THREE.SphereGeometry(1,20,14), mat); mesh.castShadow=true; const grp=new THREE.Group(); grp.add(mesh); mesh.position.y=0.8; mesh.scale.set(1,0.75,1);
    const eyeM=new THREE.MeshBasicMaterial({color:0x111111}); for(const sx of [-0.3,0.3]){ const e=new THREE.Mesh(new THREE.SphereGeometry(0.12,8,6),eyeM); e.position.set(sx,1.05,0.75); grp.add(e); }
    grp.scale.setScalar(sc*0.9); ch={model:grp, slime:mesh, mixer:null, play(){}}; }
  else if(k==='mimic'){ const o=M.chestg.scene.clone(); prep(o); o.scale.setScalar(1.3); const grp=new THREE.Group(); grp.add(o); ch={model:grp, mimic:o, mixer:null, play(){}}; }
  else { const src={min:'sk_min',war:'sk_war',rog:'sk_rog',mag:'sk_mag'}[k]; ch=makeChar(src, m.col, sc);
    const r=slot(ch.model,'handslot.r'), l=slot(ch.model,'handslot.l');
    const wp={min:'Skeleton_Blade',war:'Skeleton_Axe',rog:'Skeleton_Crossbow',mag:'Skeleton_Staff'}[k]; const wm=weapon(wp); if(wm&&r) r.add(wm);
    if(k==='war'){ const s=weapon('Skeleton_Shield_Small_A'); if(s&&l) l.add(s); } }
  ch.kind=k; ch.prev={x:m.x,y:m.y,state:m.state}; ch.t0=performance.now()/1000;
  if(m.elite||m.boss){ const ring=new THREE.Mesh(new THREE.RingGeometry(1.1,1.35,32).rotateX(-Math.PI/2), new THREE.MeshBasicMaterial({color:m.boss?0xffc53d:0xc79bff, transparent:true, opacity:0.7, blending:THREE.AdditiveBlending, depthWrite:false})); ring.position.y=0.06; ring.scale.setScalar(sc*1.1); ch.model.add(ring); ch.ring=ring; }
  scene.add(ch.model); if(ch.mixer) ch.play('Idle'); if(lvl && performance.now()/1000-lvl.t0>1.5 && ch.mixer) ch.play('Spawn_Ground_Skeletons',{once:true, ts:2.2, cut:0.9});
  return ch;
}
// ---------- объекты
const simple = new Map();
const gemGeo=new THREE.OctahedronGeometry(0.32), beamGeo=new THREE.CylinderGeometry(0.18,0.18,7,10,1,true).translate(0,3.5,0), orbGeo=new THREE.SphereGeometry(0.45,18,12), shotGeo=new THREE.SphereGeometry(0.22,10,8);
function dropObj(dr, g){ const c=col(g.QC[dr.it.q]); const grp=new THREE.Group(); const gem=new THREE.Mesh(gemGeo,new THREE.MeshStandardMaterial({color:c, emissive:c, emissiveIntensity:0.9, roughness:0.2, metalness:0.6})); gem.position.y=0.6; gem.castShadow=true; grp.add(gem); grp.userData.gem=gem;
  if(dr.it.q>=2){ const b=new THREE.Mesh(beamGeo,new THREE.MeshBasicMaterial({color:c, transparent:true, opacity:dr.it.q>=4?0.35:0.22, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide})); b.scale.set(dr.it.q>=4?1.4:1, dr.it.q>=3?1.3:1, dr.it.q>=4?1.4:1); grp.add(b); }
  scene.add(grp); return grp; }
function orbObj(ob, g){ const e=g.ESS[ob.kind], c=e&&e.cls?col(g.CLSR[e.cls]):/^b\d+$/.test(ob.kind)?col('#ffc53d'):col('#f4f7ff'); const m=new THREE.Mesh(orbGeo,new THREE.MeshStandardMaterial({color:c, emissive:c, emissiveIntensity:1.6, roughness:0.1})); m.position.y=1.2; const grp=new THREE.Group(); grp.add(m); grp.userData.c=c; scene.add(grp); return grp; }
const portalMat=new THREE.MeshBasicMaterial({color:0xb79bff, transparent:true, opacity:0.75, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide});
function ringObj(c){ const grp=new THREE.Group(); const t=new THREE.Mesh(new THREE.TorusGeometry(1.6,0.18,10,40), new THREE.MeshStandardMaterial({color:c, emissive:c, emissiveIntensity:1.5})); t.position.y=2; grp.add(t);
  const d=new THREE.Mesh(new THREE.CircleGeometry(1.5,32), new THREE.MeshBasicMaterial({color:c, transparent:true, opacity:0.45, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide})); d.position.y=2; grp.add(d); grp.userData.t=t; grp.userData.d=d;
  const base=new THREE.Mesh(new THREE.RingGeometry(1.5,2.1,32).rotateX(-Math.PI/2), new THREE.MeshBasicMaterial({color:c, transparent:true, opacity:0.5, blending:THREE.AdditiveBlending, depthWrite:false})); base.position.y=0.05; grp.add(base); scene.add(grp); return grp; }
let portalO=null, downO=null;
// снаряды
const SH_N=160; const shotMesh=new THREE.InstancedMesh(shotGeo,new THREE.MeshBasicMaterial({color:0xffffff}),SH_N); shotMesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(SH_N*3),3); shotMesh.frustumCulled=false; scene.add(shotMesh);
// частицы
const P_N=900, pGeo=new THREE.BufferGeometry(), pPos=new Float32Array(P_N*3), pCol=new Float32Array(P_N*3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos,3)); pGeo.setAttribute('color', new THREE.BufferAttribute(pCol,3));
const pTex=(()=>{const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');const gr=x.createRadialGradient(16,16,0,16,16,16);gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(0.4,'rgba(255,255,255,0.6)');gr.addColorStop(1,'rgba(255,255,255,0)');x.fillStyle=gr;x.fillRect(0,0,32,32);return new THREE.CanvasTexture(c);})();
const points=new THREE.Points(pGeo,new THREE.PointsMaterial({size:0.45, map:pTex, vertexColors:true, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false})); points.frustumCulled=false; scene.add(points);
// пыль в воздухе
const D_N=260, dGeo=new THREE.BufferGeometry(), dPos=new Float32Array(D_N*3), dSeed=[]; for(let i=0;i<D_N;i++){dSeed.push([Math.random()*60-30,Math.random()*6+0.5,Math.random()*60-30,Math.random()*6.3]);}
dGeo.setAttribute('position', new THREE.BufferAttribute(dPos,3));
const dust=new THREE.Points(dGeo,new THREE.PointsMaterial({size:0.12, map:pTex, color:0xffd9b0, transparent:true, opacity:0.55, blending:THREE.AdditiveBlending, depthWrite:false})); dust.frustumCulled=false; scene.add(dust);
// зоны, кольца
const discGeo=new THREE.CircleGeometry(1,40).rotateX(-Math.PI/2), ringGeo=new THREE.RingGeometry(0.92,1,48).rotateX(-Math.PI/2);
const pool={disc:[], ring:[]}; let used={disc:0, ring:0};
function poolGet(kind){ let a=pool[kind][used[kind]]; if(!a){ a=new THREE.Mesh(kind==='disc'?discGeo:ringGeo, new THREE.MeshBasicMaterial({transparent:true, depthWrite:false, blending:THREE.AdditiveBlending})); a.position.y=0.07; scene.add(a); pool[kind].push(a); } used[kind]++; a.visible=true; return a; }
function poolEnd(){ for(const k in pool){ for(let i=used[k];i<pool[k].length;i++) pool[k][i].visible=false; used[k]=0; } }
const boltMat=new THREE.LineBasicMaterial({color:0xd8e4ff, transparent:true, blending:THREE.AdditiveBlending}); const boltGeo=new THREE.BufferGeometry(); boltGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64*2*3),3)); const bolts=new THREE.LineSegments(boltGeo,boltMat); bolts.frustumCulled=false; scene.add(bolts);

// ---------- кадр
let lastT=performance.now()/1000, camX=0, camZ=0, trapObjs=new Map();
const EFFC={fire:'#ff7a3d', ice:'#8fd3ff', pois:'#8fd14f', void:'#b07cff', bleed:'#e01e37'};
R.hide = ()=>{ if(cv.style.display!=='none') cv.style.display='none'; };
R.mh = m=>{ const ch=monMap.get(m); return ch ? 2.3*(ch.model.scale.x||1) + (ch.kind==='slime'?-0.6:0) : 2.4; };
R.proj = (x,y,h)=>{ tmpP.set(x*K, h||0, y*K).project(camera); if(tmpP.z>1) return null; const g=G(); return [(tmpP.x+1)/2*g.VW, (1-tmpP.y)/2*g.VH]; };
R.frame = ()=>{
  const g=G(); if(cv.style.display==='none') cv.style.display='block';
  const now=performance.now()/1000, dt=Math.min(0.05, now-lastT); lastT=now;
  if(!lvl || lvl.map!==g.map){ buildLevel(g); lvl.t0=now; for(const [m,ch] of monMap){ scene.remove(ch.model); } monMap.clear(); for(const d of dying) scene.remove(d.model); dying.length=0; for(const [,o] of simple) scene.remove(o); simple.clear(); for(const [,o] of trapObjs) scene.remove(o); trapObjs.clear(); for(const [,o] of lvl.chests) scene.remove(o); }
  if(!lvl.tk || now-lvl.tk>0.25){ lvl.tk=now; updateTiles(g,false); }
  const h=g.hero, hx=h.x*K, hz=h.y*K;
  // камера
  camX += (hx-camX)*Math.min(1,dt*8); camZ += (hz-camZ)*Math.min(1,dt*8); if(Math.abs(hx-camX)>20){camX=hx;camZ=hz;}
  const sh=g.shake? (Math.random()-0.5)*g.shake*0.03 : 0;
  camera.position.set(camX+sh, 21, camZ+19+sh); camera.lookAt(camX, 1.0, camZ+0.4);
  moon.position.set(camX-12, 30, camZ-8); moon.target.position.set(camX,0,camZ); moon.target.updateMatrixWorld();
  // герой
  if(!heroCh){ heroCh=makeChar('hero', g.C.race==='beast'?'#b08050':g.C.race==='delf'?'#8f80ad':null, g.C.race==='dwarf'?0.86:1); if(g.C.race==='dwarf') heroCh.model.scale.set(0.95,0.8,0.95); scene.add(heroCh.model); heroCh.play('Idle'); }
  heroWeapons(g);
  heroCh.model.position.set(hx, 0, hz); const fa=Math.atan2(h.fx, h.fy); heroCh.model.rotation.y = fa;
  const mv=Math.hypot(h.x-heroPrev.x, h.y-heroPrev.y)/Math.max(dt,0.001);
  if(g.swing && g.swing!==heroPrev.swing){ heroCh.play(heroAttackClip(g),{once:true, ts:1.9}); }
  else if(h.dT>0 && heroPrev.dT<=0) heroCh.play('Dodge_Forward',{once:true, ts:1.1});
  else { let cast=null; for(const k in h.scd){ if((h.scd[k]||0) > (heroPrev.scd[k]||0)+0.2) cast=k; } if(cast){ heroCh.play(cast==='whirl'?'2H_Melee_Attack_Spin':cast==='leap'||cast==='charge'?'1H_Melee_Attack_Jump_Chop':cast==='warcry'?'Cheer':'Spellcast_Shoot',{once:true, ts:cast==='whirl'?1.6:1.6}); } }
  if(g.state==='play' && h.hp < heroPrev.hp - h.mhp*0.06 && !(heroCh.once && now<heroCh.once.end)) heroCh.play('Hit_A',{once:true, ts:1.4});
  if(h.hp<=0 && heroPrev.hp>0) heroCh.play('Death_A',{once:true, clamp:true});
  if(h.hp>0) heroCh.play(mv>25 ? 'Running_A' : 'Idle', {ts: mv>25 ? Math.min(1.5, Math.max(0.8, mv/150)) : 1});
  if(heroCh.once && now>=heroCh.once.end && h.hp>0){ heroCh.once=null; const w=heroCh.want||'Idle'; heroCh.want=null; heroCh.play(w); }
  heroPrev={x:h.x,y:h.y,swing:g.swing,scd:Object.assign({},h.scd),dT:h.dT,hp:h.hp,state:g.state};
  heroCh.mixer.update(dt);
  heroLight.position.set(hx, 4.5, hz+0.5); heroLight.intensity = (g.dark?40:65)*(1+Math.sin(now*13)*0.03);
  // монстры
  const alive=new Set();
  for(const m of g.mons){ if(m.hp<=0) continue; alive.add(m); let ch=monMap.get(m); if(!ch){ ch=makeMon(g,m); monMap.set(m,ch); }
    const vis=g.seesM(m); ch.model.visible=vis; if(!vis) continue;
    const kb=(m.kbE!==undefined && g.elapsed-m.kbE<0.16)?(1-(g.elapsed-m.kbE)/0.16):0;
    ch.model.position.set((m.x+(m.kbx||0)*kb)*K, 0, (m.y+(m.kby||0)*kb)*K);
    const ang=m.ang!==undefined?m.ang:Math.atan2(h.y-m.y,h.x-m.x); ch.model.rotation.y = Math.atan2(Math.cos(ang), Math.sin(ang));
    const md=Math.hypot(m.x-ch.prev.x, m.y-ch.prev.y)/Math.max(dt,0.001);
    if(ch.slime){ const hop=m.state==='hop'; ch.slime.position.y = 0.8 + (hop? 1.4*Math.sin(Math.min(1,(0.28-m.t)/0.28)*Math.PI):0); const sq=m.state==='wind'?0.55:hop?0.95:0.75+0.05*Math.sin(now*4+m.x); ch.slime.scale.set(1+(0.75-sq)*0.6, sq, 1+(0.75-sq)*0.6); }
    else if(ch.mimic){ ch.mimic.position.y = Math.abs(Math.sin(now*9))*0.4; ch.mimic.rotation.z=Math.sin(now*12)*0.1; }
    else {
      if((m.state==='wind'||m.state==='rushw') && ch.prev.state!==m.state) ch.play(ch.kind==='war'?'2H_Melee_Attack_Chop':ch.kind==='rog'?'1H_Ranged_Shoot':ch.kind==='mag'?'Spellcast_Shoot':'1H_Melee_Attack_Chop',{once:true, ts:ch.kind==='war'?1.4:1.8});
      else if(m.cd>0 && ch.prev.cd!==undefined && m.cd>ch.prev.cd+0.3 && (ch.kind==='rog'||ch.kind==='mag')) ch.play(ch.kind==='rog'?'1H_Ranged_Shoot':'Spellcast_Shoot',{once:true, ts:1.8});
      if(m.flash>0.1 && !(ch.once&&now<ch.once.end)) ch.play('Hit_A',{once:true, ts:1.8, cut:0.7});
      ch.play(m.state==='rush'?'Running_A':m.state==='idle'?'Idle':md>12?(m.spd>110?'Running_A':'Walking_D_Skeletons'):'Idle', {ts: md>12?Math.min(1.6,Math.max(0.8,md/(m.spd>110?150:70))):1});
      if(ch.once && now>=ch.once.end){ ch.once=null; const w=ch.want||'Idle'; ch.want=null; ch.play(w,{ts:ch.wantTs||1}); }
      ch.mixer.update(dt);
    }
    if(ch.ring){ ch.ring.rotation.y += dt; ch.ring.material.opacity=0.5+0.25*Math.sin(now*4); }
    if(m.flash>0){ ch.model.traverse(o=>{ if(o.isMesh&&o.material&&o.material.emissive){ if(!o.userData.e0) o.userData.e0=o.material.emissive.clone(); o.material.emissive.setRGB(0.6,0.6,0.6); o.userData.fl=1; } }); }
    else if(ch.flOn!==false){ ch.model.traverse(o=>{ if(o.userData.fl){ o.material.emissive.copy(o.userData.e0); o.userData.fl=0; } }); }
    ch.prev={x:m.x,y:m.y,state:m.state,cd:m.cd};
  }
  for(const [m,ch] of monMap){ if(!alive.has(m)){ monMap.delete(m); if(ch.mixer && ch.model.visible){ ch.play(ch.kind==='mag'||ch.kind==='min'||ch.kind==='rog'||ch.kind==='war'?'Death_C_Skeletons':'Death_A',{once:true, clamp:true, ts:1.6}); dying.push({ch, model:ch.model, t:1.8}); } else if(ch.model.visible && (ch.slime||ch.mimic)){ dying.push({ch, model:ch.model, t:0.35, shrink:1}); } else scene.remove(ch.model); } }
  for(let i=dying.length-1;i>=0;i--){ const d=dying[i]; d.t-=dt; if(d.ch.mixer) d.ch.mixer.update(dt); if(d.shrink) d.model.scale.multiplyScalar(Math.max(0.5,1-dt*6)); else if(d.t<0.6) d.model.position.y -= dt*1.5; if(d.t<=0){ scene.remove(d.model); dying.splice(i,1); } }
  // сундуки
  for(const ch of g.chests){ let o=lvl.chests.get(ch); const sn=g.seen[Math.floor(ch.y/g.T)*g.MW+Math.floor(ch.x/g.T)];
    if(!o){ o=(ch.rich?M.chestg:M.chest).scene.clone(); prep(o); o.scale.setScalar(1.1); o.position.set(ch.x*K,0,ch.y*K); o.rotation.y=Math.PI; scene.add(o); lvl.chests.set(ch,o); }
    o.visible=!!sn && !ch.gone; if(ch.mimic && !ch.open){ o.scale.y=1.1+Math.sin(now*2.2)*0.025; } if(ch.open && !o.userData.op){ o.userData.op=1; o.traverse(q=>{ if(q.isMesh&&/lid|top/i.test(q.name)) q.rotation.x=-1.2; }); } }
  // ловушки
  for(const tp of g.traps){ const sn=g.seen[Math.floor(tp.y/g.T)*g.MW+Math.floor(tp.x/g.T)]; let o=trapObjs.get(tp);
    if(!o){ if(tp.k==='spike'){ o=M.spikes.scene.clone(); prep(o); o.scale.set(0.42,1,0.42); }
      else if(tp.k==='fire'){ o=new THREE.Mesh(new THREE.CylinderGeometry(1.3,1.3,0.12,24), new THREE.MeshStandardMaterial({color:0x2a1a14, emissive:0xff6a1a, emissiveIntensity:0.1, roughness:0.8})); o.receiveShadow=true; }
      else { o=new THREE.Group(); const r=M.rubble.scene.clone(); prep(r); r.scale.setScalar(0.5); r.visible=false; o.add(r); o.userData.r=r; }
      o.position.set(tp.x*K, 0, tp.y*K); scene.add(o); trapObjs.set(tp,o); }
    o.visible=!!sn;
    if(tp.k==='spike'){ const sp=o.children[0]; o.traverse(q=>{ if(q.isMesh && q!==o.children[0]) {} }); o.position.y = tp.up?0:tp.warn?-1.2:-1.75; }
    else if(tp.k==='fire'){ o.material.emissiveIntensity = tp.st===2?2.4+Math.sin(now*20)*0.4:tp.st===1?0.9:0.1; }
    else if(tp.k==='fall'){ o.userData.r.visible = tp.st>=2; } }
  // предметы и эссенции
  const keep=new Set();
  for(const dr of g.drops){ keep.add(dr); let o=simple.get(dr); if(!o){ o=dropObj(dr,g); simple.set(dr,o); } o.position.set(dr.x*K,0,dr.y*K); o.userData.gem.rotation.y=now*2; o.userData.gem.position.y=0.6+Math.sin(now*3+dr.x)*0.12; o.visible=!!g.seen[Math.floor(dr.y/g.T)*g.MW+Math.floor(dr.x/g.T)]; }
  for(const ob of g.orbs){ keep.add(ob); let o=simple.get(ob); if(!o){ o=orbObj(ob,g); simple.set(ob,o); } o.position.set(ob.x*K,0,ob.y*K); o.children[0].position.y=1.2+Math.sin(now*2.5)*0.2; }
  for(const [k,o] of simple){ if(!keep.has(k)){ scene.remove(o); simple.delete(k); } }
  // порталы
  if(!portalO){ portalO=ringObj(new THREE.Color(0x9b7bff)); downO=ringObj(new THREE.Color(0xff8a3d)); }
  portalO.position.set(g.portal.x*K,0,g.portal.y*K); portalO.userData.t.rotation.z=now; portalO.userData.d.material.opacity=0.35+0.15*Math.sin(now*3);
  downO.visible=!!g.down && !!g.seen[Math.floor(g.down.y/g.T)*g.MW+Math.floor(g.down.x/g.T)]; if(g.down){ downO.position.set(g.down.x*K,0,g.down.y*K); downO.userData.t.rotation.z=-now; const dc=g.closedF&&!g.down.rb?0x5a6078:g.down.home?0x5ee6d0:0xff8a3d; downO.userData.t.material.color.setHex(dc); downO.userData.t.material.emissive.setHex(dc); downO.userData.d.material.color.setHex(dc); }
  // свет: факелы + эффекты
  const tl=lvl.torches.map(t=>[t, (t.x-hx)**2+(t.z-hz)**2]).sort((a,b)=>a[1]-b[1]);
  for(let i=0;i<TORCH_N;i++){ const L=torchLights[i], t=tl[i]; if(t && t[1]<55*55){ L.position.set(t[0].x, 3, t[0].z); L.intensity = 38*(0.85+0.15*Math.sin(now*17+t[0].ph)*Math.sin(now*11+t[0].ph*2)); } else L.intensity=0; }
  const fl=[];
  for(const s of g.shots) if(s.magic||s.sk) fl.push([s.x*K, s.y*K, s.sk==='chainl'?'#c8d8ff':s.magic?'#b59bff':'#ffe08a', 14]);
  for(const s of g.eshots) fl.push([s.x*K, s.y*K, EFFC[s.eff]||'#ff6b6b', 10]);
  for(const ob of g.orbs) fl.push([ob.x*K, ob.y*K, '#'+simple.get(ob)?.userData.c.getHexString(), 16]);
  for(const dr of g.drops) if(dr.it.q>=3) fl.push([dr.x*K, dr.y*K, g.QC[dr.it.q], 12]);
  fl.push([g.portal.x*K, g.portal.y*K, '#9b7bff', 30]); if(g.down&&downO.visible) fl.push([g.down.x*K, g.down.y*K, '#ff8a3d', 26]);
  for(const tp of g.traps) if(tp.k==='fire'&&tp.st===2) fl.push([tp.x*K, tp.y*K, '#ff7a3d', 40]);
  fl.sort((a,b)=>((a[0]-hx)**2+(a[1]-hz)**2)-((b[0]-hx)**2+(b[1]-hz)**2));
  for(let i=0;i<FX_N;i++){ const L=fxLights[i], f=fl[i]; if(f){ L.position.set(f[0], 1.6, f[1]); L.color.copy(col(f[2])); L.intensity=f[3]; } else L.intensity=0; }
  // снаряды
  let ns=0; for(const s of g.shots){ if(ns>=SH_N) break; tmpM.compose(tmpP.set(s.x*K,1.3,s.y*K), tmpQ.identity(), tmpS.setScalar(s.magic||s.sk==='chainl'?1.3:0.8)); shotMesh.setMatrixAt(ns,tmpM); shotMesh.setColorAt(ns, col(s.sk==='chainl'?'#e0e8ff':s.magic?'#c8b4ff':'#ffe9b0')); ns++; }
  for(const s of g.eshots){ if(ns>=SH_N) break; tmpM.compose(tmpP.set(s.x*K,1.2,s.y*K), tmpQ.identity(), tmpS.setScalar(1)); shotMesh.setMatrixAt(ns,tmpM); shotMesh.setColorAt(ns, col(EFFC[s.eff]||'#ff8080')); ns++; }
  shotMesh.count=ns; shotMesh.instanceMatrix.needsUpdate=true; if(shotMesh.instanceColor) shotMesh.instanceColor.needsUpdate=true;
  // частицы
  let np=0; for(const p of g.parts){ if(np>=P_N) break; pPos[np*3]=p.x*K; pPos[np*3+1]=0.5+(p.h||0)+Math.max(0,(0.6-(p.t||0)))*1.2; pPos[np*3+2]=p.y*K; const c=col(p.col); pCol[np*3]=c.r; pCol[np*3+1]=c.g; pCol[np*3+2]=c.b; np++; }
  pGeo.setDrawRange(0,np); pGeo.attributes.position.needsUpdate=true; pGeo.attributes.color.needsUpdate=true;
  for(let i=0;i<D_N;i++){ const d=dSeed[i]; dPos[i*3]=camX+((d[0]+now*0.3*Math.sin(d[3])+90)%60-30); dPos[i*3+1]=d[1]+Math.sin(now*0.5+d[3])*0.4; dPos[i*3+2]=camZ+((d[2]+now*0.2+90)%60-30); } dGeo.attributes.position.needsUpdate=true;
  // зоны, кольца, опасности
  for(const z of g.ehz){ const d=poolGet('disc'); d.position.set(z.x*K,0.06,z.y*K); d.scale.setScalar(z.r*K); d.material.color.copy(col(EFFC[z.eff]||'#8fd14f')); d.material.opacity=z.arm>0?0.15+0.15*Math.sin(now*10):0.35; }
  for(const z of h.zones){ const d=poolGet('disc'); d.position.set(z.x*K,0.06,z.y*K); d.scale.setScalar(z.r*K); d.material.color.copy(col(z.k==='storm'?'#8ea2ff':'#ffe08a')); d.material.opacity=0.22; const r=poolGet('ring'); r.position.set(z.x*K,0.08,z.y*K); r.scale.setScalar(z.r*K); r.material.color.copy(col(z.k==='storm'?'#c8d8ff':'#ffe08a')); r.material.opacity=0.8; }
  for(const rg of g.rings){ const r=poolGet('ring'); r.position.set(rg.x*K,0.1,rg.y*K); r.scale.setScalar(Math.max(0.1,rg.r*K*(1-(rg.t||0)*0.8))); r.material.color.copy(col(rg.col?'rgb('+rg.col+')':'#e8f4ff')); r.material.opacity=Math.min(1,(rg.t||0)*3); }
  for(const f of g.fxs){ if(f.k==='ring'){ const fa=f.t/(f.T||f.t||1); const r=poolGet('ring'); r.position.set(f.x*K,0.12,f.y*K); r.scale.setScalar((f.r+(1-fa)*f.g)*K); r.material.color.copy(col('rgb('+f.c+')')); r.material.opacity=fa; } else if(f.k==='rune'){ const fa=f.t/(f.T||1); const r=poolGet('ring'); r.position.set(f.x*K,0.1,f.y*K); r.scale.setScalar(f.r*K*(1.6-0.6*fa)); r.material.color.copy(col('rgb('+f.c+')')); r.material.opacity=fa; } }
  poolEnd();
  let nb=0; const bp=boltGeo.attributes.position.array; for(const f of g.fxs){ if(f.k!=='bolt'||nb>=60) continue; let px=f.x1*K, pz=f.y1*K, py=f.y1===f.y2-180?8:1.5; const steps=5; for(let s=1;s<=steps&&nb<60;s++){ const t=s/steps, nx=(f.x1+(f.x2-f.x1)*t)*K+(s<steps?(Math.random()-0.5)*0.8:0), nz=(f.y1+(f.y2-f.y1)*t)*K+(s<steps?(Math.random()-0.5)*0.8:0), ny=s<steps?1.5+(Math.random()-0.5)*0.6:1.2; bp.set([px,py,pz,nx,ny,nz], nb*6); px=nx; py=ny; pz=nz; nb++; } }
  boltGeo.setDrawRange(0, nb*2); boltGeo.attributes.position.needsUpdate=true;
  // туман и мрак
  scene.fog.density = g.dark ? 0.03 : 0.016; hemi.intensity = g.dark ? 0.3 : 0.55;
  renderer.render(scene, camera);
};

loadAll().then(()=>{ R.ready=true; console.log('3D готов'); }).catch(e=>{ console.error('3D: ошибка загрузки', e); R.ready=false; });
