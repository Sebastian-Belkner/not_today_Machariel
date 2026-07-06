// solver.js — client-side port of solver.py.
// Replaces the Flask /api/solution, /api/clearance, /api/recipe endpoints.
// Given a system's raw body positions it generates the buildable pool, the
// hit-and-run reachable cloud, per-point clearances, and the picked bookmarks —
// the same computation the Python worker did, run in the browser on demand.
//
// Numerics note: results need not be bit-identical to the Python backend, only
// statistically equivalent. We use a seeded PRNG so a given (system, seed) is
// deterministic and re-pick is reproducible.

const PALETTE = ['#d1495b', '#2e86ab', '#8a5a44', '#3fa34d', '#8e44ad', '#e07b00'];
const RAD2DEG = 180.0 / Math.PI;
export const MAX_CLOUD_POINTS = 4800;

// ---- seeded RNG (mulberry32) + Gaussian (Box-Muller) ----------------------
function strHash(str){
  let h = 1779033703 ^ str.length;
  for(let i=0;i<str.length;i++){
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class RNG {
  constructor(seedStr){ this._r = mulberry32(strHash(String(seedStr))); this._spare = null; }
  random(){ return this._r(); }
  randint(n){ return Math.floor(this._r() * n); }
  gauss(){
    if(this._spare !== null){ const s = this._spare; this._spare = null; return s; }
    let u=0, v=0, s=0;
    do { u = this._r()*2-1; v = this._r()*2-1; s = u*u+v*v; } while(s>=1 || s===0);
    const m = Math.sqrt(-2*Math.log(s)/s);
    this._spare = v*m;
    return u*m;
  }
  choice(arr){ return arr[this.randint(arr.length)]; }
}

// ---- vector helpers (tuple [x,y,z]) ---------------------------------------
const sub = (a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const nrm = a=>Math.sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]);
function lerp3(a,b,t){ return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]), a[2]+t*(b[2]-a[2])]; }

function frac(f, a, b){
  const pct = Math.round(f*100);
  if(f < 0.02) return `just off ${a} (≈150 km toward ${b})`;
  if(f > 0.98) return `almost at ${b}`;
  return `${pct}% from ${a} toward ${b}`;
}

// ---- parse a raw system record into working geometry ----------------------
// Mirrors from_json(): named = sun + planets + gates (NOT moons); verts adds moons.
export function fromRaw(sys){
  const sun = (sys.sun || [0,0,0]).map(Number);
  const planets = (sys.planets||[]).map((p,i)=>({name:p.name||`P${i+1}`, pos:[+p.x,+p.y,+p.z]}));
  const moons   = (sys.moons||[]).map((m,i)=>({name:m.name||`Moon${i+1}`, pos:[+m.x,+m.y,+m.z]}));
  const gates   = (sys.gates||[]).map((g,i)=>({name:g.name||`Gate${i+1}`, pos:[+g.x,+g.y,+g.z], color:PALETTE[i%PALETTE.length]}));
  const named = [{name:'Sun', pos:sun},
    ...planets.map(p=>({name:p.name,pos:p.pos})),
    ...gates.map(g=>({name:g.name,pos:g.pos}))];
  const verts = [sun, ...planets.map(p=>p.pos), ...moons.map(m=>m.pos), ...gates.map(g=>g.pos)];
  return {
    name: sys.name||'', region: sys.region||'', security: sys.security ?? null,
    sun, planets, moons, gates, named, verts, hullEq: sys.hull || null,
  };
}

// ---- buildable bookmark pool (build_pool) ---------------------------------
function buildPool(S, rng, secondGen=1600){
  const N = S.named;
  const pool = [];
  for(let i=0;i<N.length;i++){
    for(let j=i+1;j<N.length;j++){
      const A=N[i], B=N[j];
      let f=0.05;
      while(f<0.96){
        pool.push({point:lerp3(A.pos,B.pos,f), gen:1,
          steps:[`Warp ${A.name} → ${B.name}; bookmark ${frac(f,A.name,B.name)}  ➔ BM*`]});
        f += 1/12;
      }
    }
  }
  const rnd = ()=>N[rng.randint(N.length)];
  for(let k=0;k<secondGen;k++){
    let A=rnd(), B=rnd(); while(B===A) B=rnd();
    let C=rnd(), D=rnd(); while(D===C) D=rnd();
    const s = 0.08 + rng.random()*0.84;
    const u = 0.08 + rng.random()*0.84;
    const b = 0.15 + rng.random()*0.70;
    const p1 = lerp3(A.pos,B.pos,s);
    const p2 = lerp3(C.pos,D.pos,u);
    const p  = lerp3(p1,p2,b);
    pool.push({point:p, gen:2, steps:[
      `Warp ${A.name} → ${B.name}; bookmark ${frac(s,A.name,B.name)}  ➔ BM1`,
      `Warp ${C.name} → ${D.name}; bookmark ${frac(u,C.name,D.name)}  ➔ BM2`,
      `Warp BM1 → BM2; bookmark ${frac(b,'BM1','BM2')}  ➔ BM*`]});
  }
  return pool;
}

// ---- clearance (per gate) --------------------------------------------------
function gateDirs(S){
  const gp = S.gates.map(g=>g.pos);
  const dirs = [];
  for(let k=0;k<gp.length;k++){
    const row=[];
    for(let m=0;m<gp.length;m++){
      if(m===k) continue;
      const v=sub(gp[m],gp[k]); const n=nrm(v)||1;
      row.push([v[0]/n,v[1]/n,v[2]/n]);
    }
    dirs.push(row);
  }
  return {gatePos:gp, dirs};
}
function clearanceToGate(p, gpos, otherDirs){
  const dx=gpos[0]-p[0], dy=gpos[1]-p[1], dz=gpos[2]-p[2];
  const n=Math.sqrt(dx*dx+dy*dy+dz*dz);
  if(n<0.05) return -1.0;
  if(!otherDirs.length) return -1.0;
  const inv=1/n, ux=dx*inv, uy=dy*inv, uz=dz*inv;
  let mc=0;
  for(const [ox,oy,oz] of otherDirs){ const c=Math.abs(ux*ox+uy*oy+uz*oz); if(c>mc) mc=c; }
  return Math.acos(Math.min(1,Math.max(-1,mc)))*RAD2DEG;
}
function minClearance(p, gatePos, dirs){
  if(!gatePos.length) return -1.0;
  let mn=Infinity;
  for(let k=0;k<gatePos.length;k++){ const cl=clearanceToGate(p,gatePos[k],dirs[k]); if(cl<mn) mn=cl; }
  return mn;
}

// ---- convex-hull half-space equations (no scipy) --------------------------
function hullExtent(verts){
  if(!verts.length) return 1;
  const xs=verts.map(v=>v[0]), ys=verts.map(v=>v[1]), zs=verts.map(v=>v[2]);
  return Math.max(Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys),
                  Math.max(...zs)-Math.min(...zs), 1);
}
function hullVertexCandidates(pts, dirs=64){
  const n=pts.length;
  if(n<=8) return pts;
  const probe=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const s=1/Math.sqrt(3);
  for(const sx of [1,-1]) for(const sy of [1,-1]) for(const sz of [1,-1]) probe.push([sx*s,sy*s,sz*s]);
  const r=mulberry32(0x5eb);
  while(probe.length<dirs){
    const x=r()*2-1, y=r()*2-1, z=r()*2-1, m=Math.sqrt(x*x+y*y+z*z);
    if(m>1e-9) probe.push([x/m,y/m,z/m]);
  }
  const keep=new Set();
  for(const [dx,dy,dz] of probe){
    let bi=0,bv=-Infinity;
    for(let i=0;i<n;i++){ const v=pts[i][0]*dx+pts[i][1]*dy+pts[i][2]*dz; if(v>bv){bv=v;bi=i;} }
    keep.add(bi);
  }
  return [...keep].sort((a,b)=>a-b).map(i=>pts[i]);
}
function bruteFaceHull(pts){
  const n=pts.length;
  if(n<4) return [];
  const extent=Math.max(
    Math.max(...pts.map(p=>p[0]))-Math.min(...pts.map(p=>p[0])),
    Math.max(...pts.map(p=>p[1]))-Math.min(...pts.map(p=>p[1])),
    Math.max(...pts.map(p=>p[2]))-Math.min(...pts.map(p=>p[2])), 1);
  const areaEps=1e-12*extent*extent, sideEps=1e-9*extent;
  const planes=[]; const keys=new Set();
  for(let i=0;i<n-2;i++){
    const [ax,ay,az]=pts[i];
    for(let j=i+1;j<n-1;j++){
      const [bx,by,bz]=pts[j];
      const abx=bx-ax,aby=by-ay,abz=bz-az;
      for(let k=j+1;k<n;k++){
        const [cx,cy,cz]=pts[k];
        const acx=cx-ax,acy=cy-ay,acz=cz-az;
        let nx=aby*acz-abz*acy, ny=abz*acx-abx*acz, nz=abx*acy-aby*acx;
        const nn=Math.sqrt(nx*nx+ny*ny+nz*nz);
        if(nn<=areaEps) continue;
        nx/=nn; ny/=nn; nz/=nn;
        let d=-(nx*ax+ny*ay+nz*az);
        let mx=-Infinity, mn=Infinity;
        for(const [x,y,z] of pts){ const val=nx*x+ny*y+nz*z+d; if(val>mx)mx=val; if(val<mn)mn=val; }
        if(mx<=sideEps){ /* inside <=0 already */ }
        else if(mn>=-sideEps){ nx=-nx;ny=-ny;nz=-nz;d=-d; }
        else continue;
        const key=`${nx.toFixed(8)},${ny.toFixed(8)},${nz.toFixed(8)},${(d/extent).toFixed(8)}`;
        if(keys.has(key)) continue;
        keys.add(key); planes.push([nx,ny,nz,d]);
      }
    }
  }
  return planes;
}
function hullEquations(verts){
  const pts=[]; const seen=new Set();
  for(const v of verts){
    const key=`${v[0].toFixed(3)},${v[1].toFixed(3)},${v[2].toFixed(3)}`;
    if(!seen.has(key)){ seen.add(key); pts.push(v); }
  }
  if(pts.length<4) return [];
  const extent0=hullExtent(pts);
  let candidates=hullVertexCandidates(pts);
  for(let iter=0; iter<8; iter++){
    const planes=bruteFaceHull(candidates);
    if(!planes.length){
      if(candidates.length<pts.length){ candidates=pts; continue; }
      return [];
    }
    const sideEps=1e-9*extent0;
    const seenC=new Set(candidates.map(p=>p.join(',')));
    const missing=[];
    for(const p of pts){
      if(seenC.has(p.join(','))) continue;
      const [x,y,z]=p;
      if(planes.some(([a,b,c,d])=>a*x+b*y+c*z+d>sideEps)) missing.push(p);
    }
    if(!missing.length) return planes;
    candidates=candidates.concat(missing);
  }
  return bruteFaceHull(pts);
}
function insideHull(eq, p, extent){
  const eps=1e-6*(extent||1);
  const [x,y,z]=p;
  for(const [a,b,c,d] of eq){ if(a*x+b*y+c*z+d>eps) return false; }
  return true;
}

// ---- symmetric 3x3 eigendecomposition (for hull-frame whitening) ----------
function sym3eig(a){
  const axx=a[0][0], axy=a[0][1], axz=a[0][2], ayy=a[1][1], ayz=a[1][2], azz=a[2][2];
  const p1=axy*axy+axz*axz+ayz*ayz;
  if(p1<=1e-30){
    const vals=[[axx,[1,0,0]],[ayy,[0,1,0]],[azz,[0,0,1]]].sort((u,v)=>u[0]-v[0]);
    return {vals:vals.map(v=>v[0]), vecs:vals.map(v=>v[1])};
  }
  const q=(axx+ayy+azz)/3;
  const b00=axx-q, b11=ayy-q, b22=azz-q;
  const p2=b00*b00+b11*b11+b22*b22+2*p1;
  const p=Math.sqrt(p2/6);
  const ip=1/p;
  const m00=b00*ip,m11=b11*ip,m22=b22*ip,m01=axy*ip,m02=axz*ip,m12=ayz*ip;
  const detB=m00*(m11*m22-m12*m12)-m01*(m01*m22-m12*m02)+m02*(m01*m12-m11*m02);
  const r=Math.max(-1,Math.min(1,detB/2));
  const phi=Math.acos(r)/3;
  const e1=q+2*p*Math.cos(phi);
  const e3=q+2*p*Math.cos(phi+2*Math.PI/3);
  const e2=3*q-e1-e3;
  const eigvals=[e1,e2,e3].sort((x,y)=>x-y);
  function eigvec(lam){
    const r0=[axx-lam,axy,axz], r1=[axy,ayy-lam,ayz], r2=[axz,ayz,azz-lam];
    const cross=(u,v)=>[u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    const cands=[cross(r0,r1),cross(r0,r2),cross(r1,r2)];
    let best=cands[0], bl=best[0]**2+best[1]**2+best[2]**2;
    for(const c of cands){ const l=c[0]**2+c[1]**2+c[2]**2; if(l>bl){bl=l;best=c;} }
    const n=Math.sqrt(bl);
    if(n<1e-18) return null;
    return [best[0]/n,best[1]/n,best[2]/n];
  }
  const vecs=eigvals.map(eigvec);
  const basis=vecs.filter(v=>v);
  for(let i=0;i<vecs.length;i++){
    if(!vecs[i]){
      for(const s of [[1,0,0],[0,1,0],[0,0,1]]){
        let w=[...s];
        for(const bb of basis){ const d=w[0]*bb[0]+w[1]*bb[1]+w[2]*bb[2]; w=[w[0]-d*bb[0],w[1]-d*bb[1],w[2]-d*bb[2]]; }
        const n=Math.sqrt(w[0]**2+w[1]**2+w[2]**2);
        if(n>1e-9){ vecs[i]=[w[0]/n,w[1]/n,w[2]/n]; break; }
      }
      if(!vecs[i]) vecs[i]=[0,0,1];
      basis.push(vecs[i]);
    }
  }
  return {vals:eigvals, vecs};
}
function hullFrame(verts){
  const pts=verts; const n=pts.length;
  if(n===0) return {center:[0,0,0], axes:[[1,0,0],[0,1,0],[0,0,1]], scales:[1,1,1]};
  const cx=pts.reduce((s,p)=>s+p[0],0)/n, cy=pts.reduce((s,p)=>s+p[1],0)/n, cz=pts.reduce((s,p)=>s+p[2],0)/n;
  let sxx=0,sxy=0,sxz=0,syy=0,syz=0,szz=0;
  for(const p of pts){ const dx=p[0]-cx,dy=p[1]-cy,dz=p[2]-cz;
    sxx+=dx*dx;sxy+=dx*dy;sxz+=dx*dz;syy+=dy*dy;syz+=dy*dz;szz+=dz*dz; }
  const inv=1/n;
  const cov=[[sxx*inv,sxy*inv,sxz*inv],[sxy*inv,syy*inv,syz*inv],[sxz*inv,syz*inv,szz*inv]];
  const {vals,vecs}=sym3eig(cov);
  const stds=vals.map(ev=>Math.sqrt(Math.max(0,ev)));
  const smax=Math.max(...stds)||1;
  const floor=smax*1e-3;
  return {center:[cx,cy,cz], axes:vecs, scales:stds.map(s=>Math.max(s,floor))};
}
function whitenedDir(rng, axes, scales){
  while(true){
    const g0=rng.gauss()*scales[0], g1=rng.gauss()*scales[1], g2=rng.gauss()*scales[2];
    const a0=axes[0],a1=axes[1],a2=axes[2];
    const x=g0*a0[0]+g1*a1[0]+g2*a2[0];
    const y=g0*a0[1]+g1*a1[1]+g2*a2[1];
    const z=g0*a0[2]+g1*a1[2]+g2*a2[2];
    const n=Math.sqrt(x*x+y*y+z*z);
    if(n>1e-18) return [x/n,y/n,z/n];
  }
}

// ---- hit-and-run cloud -----------------------------------------------------
function hitAndRunCloud(S, rng, want, burnIn=80, thin=4){
  const verts=S.verts;
  let eq = S.hullEq || hullEquations(verts);
  if(!eq.length || want<=0) return [];
  const extent=hullExtent(verts);
  let x = verts.length ? [verts.reduce((s,v)=>s+v[0],0)/verts.length,
                          verts.reduce((s,v)=>s+v[1],0)/verts.length,
                          verts.reduce((s,v)=>s+v[2],0)/verts.length] : [0,0,0];
  const {axes,scales}=hullFrame(verts);
  if(!insideHull(eq,x,extent)){
    let found=false;
    for(let t=0;t<200;t++){
      // random convex combo of up to 4 vertices
      const k=Math.min(4,verts.length);
      const chosen=[]; const used=new Set();
      while(chosen.length<k){ const idx=rng.randint(verts.length); if(!used.has(idx)){used.add(idx);chosen.push(verts[idx]);} }
      const w=chosen.map(()=>-Math.log(Math.max(1e-12,rng.random())));
      const tot=w.reduce((a,b)=>a+b,0)||1;
      const trial=[0,0,0];
      for(let c=0;c<chosen.length;c++){ trial[0]+=w[c]*chosen[c][0]/tot; trial[1]+=w[c]*chosen[c][1]/tot; trial[2]+=w[c]*chosen[c][2]/tot; }
      if(insideHull(eq,trial,extent)){ x=trial; found=true; break; }
    }
    if(!found) return [];
  }
  const out=[];
  const steps=burnIn + want*Math.max(1,thin);
  const small=1e-14;
  for(let step=0; step<steps; step++){
    const [dx,dy,dz]=whitenedDir(rng,axes,scales);
    let lo=-Infinity, hi=Infinity, ok=true;
    const [x0,y0,z0]=x;
    for(const [a,b,c,d] of eq){
      const val=a*x0+b*y0+c*z0+d;
      const den=a*dx+b*dy+c*dz;
      if(Math.abs(den)<small){ if(val>1e-8*extent){ ok=false; break; } continue; }
      const t=-val/den;
      if(den>0){ if(t<hi) hi=t; } else { if(t>lo) lo=t; }
    }
    if(!ok || !isFinite(lo) || !isFinite(hi) || hi<=lo) continue;
    const margin=Math.min((hi-lo)*1e-9, 1e-9*extent);
    if(hi-lo>2*margin){ lo+=margin; hi-=margin; }
    const t=lo+rng.random()*(hi-lo);
    x=[x0+t*dx, y0+t*dy, z0+t*dz];
    if(step>=burnIn && ((step-burnIn)%Math.max(1,thin)===0)){
      out.push(x);
      if(out.length>=want) break;
    }
  }
  return out;
}

// ---- public: build threshold-independent geometry once per system --------
export function buildGeometry(sys, systemId){
  const S = fromRaw(sys);
  const {gatePos, dirs} = gateDirs(S);
  const pool = buildPool(S, new RNG(`pool:${systemId}`));
  const candidatePoints = pool.map(c=>c.point);

  // candidate clearances [candidateIndex][gateIndex] + per-candidate min
  const candidateClearances = [];
  const candidateMin = [];
  for(const p of candidatePoints){
    const row = gatePos.map((gp,k)=>clearanceToGate(p,gp,dirs[k]));
    candidateClearances.push(row);
    candidateMin.push(row.length?Math.min(...row):-1.0);
  }
  let singleBest=0;
  for(let i=1;i<candidateMin.length;i++) if(candidateMin[i]>candidateMin[singleBest]) singleBest=i;

  // cloud: seed with true hull vertices, then hit-and-run interior samples
  const rng = new RNG(`cloud-hit-run-v5:${systemId}`);
  let cloudPts = hitAndRunCloud(S, rng, MAX_CLOUD_POINTS);
  const vseeds=[]; const seen=new Set();
  for(const v of S.verts){
    const key=`${v[0].toFixed(3)},${v[1].toFixed(3)},${v[2].toFixed(3)}`;
    if(!seen.has(key)){ seen.add(key); vseeds.push(v); }
  }
  cloudPts = vseeds.concat(cloudPts).slice(0, MAX_CLOUD_POINTS);
  const cloud = cloudPts.map(p=>({p, cl:minClearance(p,gatePos,dirs)}));

  return {S, systemId, pool, candidatePoints, candidateClearances, candidateMin,
          singleBest, cloud, gatePos, gateDirs:dirs};
}

// ---- public: full solution for a threshold + seed (replaces /api/solution)-
export function getSolution(G, threshold=18, seed=0){
  const S=G.S;
  const gateCount=S.gates.length;
  const evaluable=gateCount>=2;
  const candCount=G.pool.length;
  const rng=new RNG(`pick:${G.systemId}:${threshold}:${seed}`);

  const perGate=[];
  for(let k=0;k<S.gates.length;k++){
    if(!candCount) continue;
    const vals=G.candidateClearances.map(row=>row[k]);
    let besti=0; for(let i=1;i<vals.length;i++) if(vals[i]>vals[besti]) besti=i;
    const valid = evaluable ? vals.map((cl,i)=>cl>=threshold?i:-1).filter(i=>i>=0) : [];
    const chosenI = valid.length ? rng.choice(valid) : besti;
    const chosen=G.pool[chosenI];
    perGate.push({gateIndex:k, name:S.gates[k].name, color:S.gates[k].color,
      point:xyz(chosen.point), bestClearance: evaluable?round2(vals[besti]):null,
      nvalid:valid.length, steps:chosen.steps});
  }

  let single;
  if(candCount){
    const si=G.singleBest;
    single={point:xyz(G.pool[si].point), minClearance:evaluable?round2(G.candidateMin[si]):null, steps:G.pool[si].steps};
  } else {
    single={point:{x:0,y:0,z:0}, minClearance:null, steps:[]};
  }

  const reachable=G.cloud.map(({p})=>xyz4(p));
  const allowed = evaluable ? G.cloud.filter(({cl})=>cl>=threshold).map(({p})=>xyz4(p)) : [];
  const bestAchievable = evaluable ? round2(Math.max(0,...G.cloud.map(c=>c.cl))) : null;
  const current = clearancesAt(G, single.point, threshold);

  return {
    system: publicSystem(S),
    solution: {
      threshold, seed, evaluable, single, per_gate:perGate,
      reachCloud:reachable, allowCloud:allowed, current,
      meta:{planets:S.planets.length, moons:S.moons.length, gates:gateCount,
        evaluable, cloudReachable:reachable.length, cloudAllowed:allowed.length,
        bestAchievable, poolCandidates:candCount, timingMs:0, cloudSampler:'js_hit_and_run'},
    },
  };
}

// ---- public: clearance at an arbitrary point (replaces /api/clearance) ----
export function clearancesAt(G, point, threshold=18){
  const p=[+point.x,+point.y,+point.z];
  const S=G.S;
  const evaluable=S.gates.length>=2;
  const perGate=[]; let mn=Infinity;
  for(let k=0;k<S.gates.length;k++){
    const cl=clearanceToGate(p,G.gatePos[k],G.gateDirs[k]);
    const e={gateIndex:k, name:S.gates[k].name, color:S.gates[k].color};
    if(evaluable && cl>=0){ mn=Math.min(mn,cl); e.clearance=round2(cl); e.ok=cl>=threshold; }
    else { e.clearance=null; e.ok=null; }
    perGate.push(e);
  }
  const minClr = (evaluable && isFinite(mn)) ? round2(mn) : null;
  return {minClearance:minClr, evaluable, per_gate:perGate};
}

// ---- public: snap dragged point to nearest recipe (replaces /api/recipe) --
export function nearestRecipe(G, point, threshold=18){
  const pool=G.pool, cand=G.candidatePoints;
  if(!pool.length) return {point:xyz([+point.x,+point.y,+point.z]), steps:[], gen:0,
    minClearance:null, evaluable:G.S.gates.length>=2, per_gate:[], offset:0};
  const px=+point.x, py=+point.y, pz=+point.z;
  let besti=0, bestd=Infinity;
  for(let i=0;i<cand.length;i++){
    const dx=cand[i][0]-px, dy=cand[i][1]-py, dz=cand[i][2]-pz;
    const d2=dx*dx+dy*dy+dz*dz;
    if(d2<bestd){ bestd=d2; besti=i; }
  }
  const chosen=pool[besti];
  const clr=clearancesAt(G, xyz(chosen.point), threshold);
  return {point:xyz(chosen.point), steps:chosen.steps, gen:chosen.gen||0,
    minClearance:clr.minClearance, evaluable:clr.evaluable, per_gate:clr.per_gate,
    offset:round4(Math.sqrt(bestd))};
}

// ---- shaping helpers -------------------------------------------------------
function round2(v){ return Math.round(v*100)/100; }
function round4(v){ return Math.round(v*1e4)/1e4; }
function xyz(p){ return {x:round5(p[0]), y:round5(p[1]), z:round5(p[2])}; }
function xyz4(p){ return {x:round4(p[0]), y:round4(p[1]), z:round4(p[2])}; }
function round5(v){ return Math.round(v*1e5)/1e5; }
function publicSystem(S){
  return {name:S.name, region:S.region, security:S.security, sun:xyz(S.sun),
    planets:S.planets.map(p=>({name:p.name,pos:xyz(p.pos)})),
    moons:S.moons.map(m=>({name:m.name,pos:xyz(m.pos)})),
    gates:S.gates.map(g=>({name:g.name,pos:xyz(g.pos),color:g.color}))};
}
export function systemSummary(i, sys){
  return {id:i, name:sys.name||`system-${i}`, region:sys.region||'',
    security:sys.security??null, gates:(sys.gates||[]).length,
    planets:(sys.planets||[]).length, moons:(sys.moons||[]).length};
}

// ---- global bridge (so app.js can stay a classic script) ------------------
if (typeof window !== 'undefined') {
  window.NTMSolver = {
    fromRaw, buildGeometry, getSolution, clearancesAt, nearestRecipe,
    systemSummary, MAX_CLOUD_POINTS,
  };
}
