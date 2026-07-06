import * as NTMSolver from "./solver.js";
window.NTMSolver = NTMSolver;

const CW = 600, CH = 600;
const cvs = document.getElementById("scene"), ctx = cvs.getContext("2d");
const tip = document.getElementById("tip");
const NS = "http://www.w3.org/2000/svg";

let SYSTEMS = [], REGIONS = [], currentRegion = "", systemId = null, S = null, solution = null, BM = {x:0,y:0,z:0};
let THR = 18, seed = 0, zoom = 1, camScale = 1, camCtr = {x:0,y:0,z:0};
// Camera orientation as a 3x3 rotation matrix (row-major), applied to
// world->view.  Using an accumulated matrix instead of yaw/pitch Euler angles
// removes gimbal lock: horizontal drags always spin around the current screen-
// up axis and vertical drags always tilt around the current screen-right axis,
// so every orientation is reachable smoothly (important for laying planar
// systems flat).  Initialised to a pleasant tilted-overhead view below.
let camRot = [[1,0,0],[0,1,0],[0,0,1]];
let view2d = false, mode = null, last = null, dials = [];
let solutionRequestSeq = 0, thresholdTimer = null;
let draggedRecipe = null, recipeRequestSeq = 0;

// --- static-site data layer -------------------------------------------------
// Replaces the Flask API.  index.json lists regions; each region has a summaries
// shard (for the dropdown) and a full systems shard (raw body positions).  The
// per-system solve runs in the browser via window.NTMSolver (solver.js).
const DATA_BASE = "data";
let INDEX = null;                 // {regions:[{name,slug,systems}], ...}
const _regionSlug = {};           // region name -> slug
const _summaryCache = {};         // slug -> [summary,...]
const _systemsCache = {};         // slug -> {id: rawSystemRecord}
const _geometryCache = {};        // global system id -> geometry object
let _currentSlug = null;

async function loadIndex(){
  if(INDEX) return INDEX;
  const res = await fetch(`${DATA_BASE}/index.json`);
  INDEX = await res.json();
  for(const r of INDEX.regions) _regionSlug[r.name] = r.slug;
  return INDEX;
}
async function loadSummaries(slug){
  if(_summaryCache[slug]) return _summaryCache[slug];
  const res = await fetch(`${DATA_BASE}/summaries/${slug}.json`);
  const data = await res.json();
  _summaryCache[slug] = data.systems || [];
  return _summaryCache[slug];
}
async function loadSystemsShard(slug){
  if(_systemsCache[slug]) return _systemsCache[slug];
  const res = await fetch(`${DATA_BASE}/systems/${slug}.json`);
  const data = await res.json();
  const byId = {};
  for(const s of (data.systems||[])) byId[s._id] = s;
  _systemsCache[slug] = byId;
  return byId;
}
// Resolve + cache the threshold-independent geometry for a system id.
async function geometryFor(id){
  if(_geometryCache[id]) return _geometryCache[id];
  // The system's raw record lives in its region shard; _currentSlug is loaded.
  let raw = (_systemsCache[_currentSlug] || {})[id];
  if(!raw){
    // Fall back: find which region holds this id via summaries already loaded,
    // else scan region shards (rare — only if id isn't in the active region).
    for(const slug of Object.keys(_systemsCache)){
      if(_systemsCache[slug][id]){ raw = _systemsCache[slug][id]; break; }
    }
  }
  if(!raw) throw new Error(`system ${id} not found in loaded shards`);
  const G = window.NTMSolver.buildGeometry(raw, id);
  _geometryCache[id] = G;
  return G;
}

const sub = (a,b) => ({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
const dot = (a,b) => a.x*b.x + a.y*b.y + a.z*b.z;
const nrm = a => Math.hypot(a.x,a.y,a.z);
const unit = a => {const n = nrm(a) || 1; return {x:a.x/n, y:a.y/n, z:a.z/n};};
const lineAngle = (d,u) => {
  const c = Math.abs(dot(unit(d), unit(u)));
  return Math.acos(Math.min(1, Math.max(-1, c)));
};

function othersOf(k){ return S.gates.filter((_,m) => m !== k); }
function clearanceLocal(p, g, others){
  const d = sub(g.pos, p);
  let m = Infinity;
  for (const o of others){
    const a = lineAngle(d, sub(o.pos, g.pos));
    if (a < m) m = a;
  }
  return m * 180 / Math.PI;
}
function localClearanceInfo(p){
  let mn = Infinity;
  const per_gate = S.gates.map((g,k) => {
    const cl = clearanceLocal(p, g, othersOf(k));
    mn = Math.min(mn, cl);
    return {gateIndex:k, name:g.name, color:g.color, clearance:cl, ok:cl >= THR};
  });
  return {minClearance:mn, per_gate};
}

// --- rotation-matrix helpers (row-major 3x3) -----------------------------
function matVec(M, v){
  return {
    x: M[0][0]*v.x + M[0][1]*v.y + M[0][2]*v.z,
    y: M[1][0]*v.x + M[1][1]*v.y + M[1][2]*v.z,
    z: M[2][0]*v.x + M[2][1]*v.y + M[2][2]*v.z,
  };
}
function matMul(A, B){
  const C = [[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<3;i++) for(let j=0;j<3;j++){
    let s=0; for(let k=0;k<3;k++) s += A[i][k]*B[k][j];
    C[i][j]=s;
  }
  return C;
}
// Rotation about a unit axis (Rodrigues), angle in radians.
function axisAngle(ax, ay, az, ang){
  const n = Math.hypot(ax,ay,az) || 1; ax/=n; ay/=n; az/=n;
  const c = Math.cos(ang), s = Math.sin(ang), t = 1-c;
  return [
    [t*ax*ax + c,    t*ax*ay - s*az, t*ax*az + s*ay],
    [t*ax*ay + s*az, t*ay*ay + c,    t*ay*az - s*ax],
    [t*ax*az - s*ay, t*ay*az + s*ax, t*az*az + c   ],
  ];
}
// Re-orthonormalise to fight float drift after many drag compositions.
function orthonormalize(M){
  let x = {x:M[0][0], y:M[0][1], z:M[0][2]};
  let y = {x:M[1][0], y:M[1][1], z:M[1][2]};
  const nx = nrm(x)||1; x = {x:x.x/nx, y:x.y/nx, z:x.z/nx};
  let dxy = x.x*y.x + x.y*y.y + x.z*y.z;
  y = {x:y.x - dxy*x.x, y:y.y - dxy*x.y, z:y.z - dxy*x.z};
  const ny = nrm(y)||1; y = {x:y.x/ny, y:y.y/ny, z:y.z/ny};
  const z = {x:x.y*y.z - x.z*y.y, y:x.z*y.x - x.x*y.z, z:x.x*y.y - x.y*y.x};
  return [[x.x,x.y,x.z],[y.x,y.y,y.z],[z.x,z.y,z.z]];
}

function rot(p){
  const q = sub(p, camCtr);
  const r = matVec(camRot, q);
  return {x:r.x, y:r.y, depth:r.z};   // screen x,y; depth = toward viewer(+)
}
function project(p){
  const r = rot(p);
  return {sx:CW/2 + r.x*camScale*zoom, sy:CH/2 - r.y*camScale*zoom, depth:r.depth};
}
function screenDeltaToWorld(dmx,dmy){
  // Inverse-rotate a screen-plane delta back into world space (camRot is
  // orthonormal, so inverse = transpose).  Screen +y is up, canvas +y is down.
  const sc = camScale*zoom || 1;
  const v = {x:dmx/sc, y:-dmy/sc, z:0};
  return {
    x: camRot[0][0]*v.x + camRot[1][0]*v.y + camRot[2][0]*v.z,
    y: camRot[0][1]*v.x + camRot[1][1]*v.y + camRot[2][1]*v.z,
    z: camRot[0][2]*v.x + camRot[1][2]*v.y + camRot[2][2]*v.z,
  };
}
function computeCam(){
  const pts = [S.sun, ...S.planets.map(p=>p.pos), ...S.moons.map(m=>m.pos), ...S.gates.map(g=>g.pos)];
  let c = {x:0,y:0,z:0};
  pts.forEach(p => {c.x+=p.x; c.y+=p.y; c.z+=p.z;});
  c.x /= pts.length; c.y /= pts.length; c.z /= pts.length;
  camCtr = c;
  let R = 0;
  pts.forEach(p => {R = Math.max(R, nrm(sub(p,c)));});
  camScale = (Math.min(CW,CH)/2 - 40) / (R || 1);
}

// Build a rotation matrix from a desired yaw then pitch (used only to reproduce
// the old pleasant default view as a starting matrix).
function yawPitchMatrix(yaw, pitch){
  const cy=Math.cos(yaw), sy=Math.sin(yaw), cp=Math.cos(pitch), sp=Math.sin(pitch);
  const Ryaw   = [[cy,-sy,0],[sy,cy,0],[0,0,1]];
  const Rpitch = [[1,0,0],[0,cp,-sp],[0,sp,cp]];
  return matMul(Rpitch, Ryaw);
}
function defaultView(){ camRot = yawPitchMatrix(0.6, -1.05); }
function topDownView(){ camRot = [[1,0,0],[0,1,0],[0,0,1]]; }

// Principal axes of the current system's body cloud (about camCtr), ascending
// by spread.  The first axis is the thinnest direction -- for a planar system
// that's the plane normal.  Pure JS power-iteration on the 3x3 covariance;
// small and dependency-free.
function systemPrincipalAxes(){
  const pts = [S.sun, ...S.planets.map(p=>p.pos), ...S.moons.map(m=>m.pos), ...S.gates.map(g=>g.pos)]
                .map(p => sub(p, camCtr));
  let sxx=0,sxy=0,sxz=0,syy=0,syz=0,szz=0;
  for(const p of pts){ sxx+=p.x*p.x; sxy+=p.x*p.y; sxz+=p.x*p.z; syy+=p.y*p.y; syz+=p.y*p.z; szz+=p.z*p.z; }
  const n = pts.length||1;
  const C = [[sxx/n,sxy/n,sxz/n],[sxy/n,syy/n,syz/n],[sxz/n,syz/n,szz/n]];
  const mul = (M,v)=>({x:M[0][0]*v.x+M[0][1]*v.y+M[0][2]*v.z,
                       y:M[1][0]*v.x+M[1][1]*v.y+M[1][2]*v.z,
                       z:M[2][0]*v.x+M[2][1]*v.y+M[2][2]*v.z});
  const norm = v=>{const l=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/l,y:v.y/l,z:v.z/l};};
  function dominant(M, seed){
    let v = norm(seed);
    for(let i=0;i<80;i++){ let w=mul(M,v); const l=Math.hypot(w.x,w.y,w.z); if(l<1e-20) break; v={x:w.x/l,y:w.y/l,z:w.z/l}; }
    const Mv=mul(M,v); const lam=v.x*Mv.x+v.y*Mv.y+v.z*Mv.z;
    return {v, lam};
  }
  // largest eigenpair
  const e1 = dominant(C, {x:1,y:1,z:1});
  // deflate and get the second
  const a=e1.lam, u=e1.v;
  const D = [[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<3;i++) for(let j=0;j<3;j++){
    const ui=[u.x,u.y,u.z][i], uj=[u.x,u.y,u.z][j];
    D[i][j] = C[i][j] - a*ui*uj;
  }
  const e2 = dominant(D, {x:u.y-u.z, y:u.z-u.x, z:u.x-u.y});
  // third = cross(e1,e2)
  const e3 = {x:u.y*e2.v.z-u.z*e2.v.y, y:u.z*e2.v.x-u.x*e2.v.z, z:u.x*e2.v.y-u.y*e2.v.x};
  // ascending spread: [thin, mid, long]
  return {thin: e3, mid: e2.v, long: u};
}

// Orient the system so its plane faces the viewer: map the thin principal axis
// (plane normal) to the screen normal (+z toward viewer) and the long axis to
// screen-right.  For a planar system this lays it flat so you see its surface.
function layFlat(){
  if(!S) return;
  const {thin, mid, long} = systemPrincipalAxes();
  const norm = v=>{const l=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/l,y:v.y/l,z:v.z/l};};
  let zc = norm(thin);                       // world dir we want pointing at viewer
  let xc = norm(long);                       // world dir we want going right
  // Gram-Schmidt xc against zc, then yc = zc x xc.
  const d = xc.x*zc.x + xc.y*zc.y + xc.z*zc.z;
  xc = norm({x:xc.x-d*zc.x, y:xc.y-d*zc.y, z:xc.z-d*zc.z});
  const yc = {x:zc.y*xc.z-zc.z*xc.y, y:zc.z*xc.x-zc.x*xc.z, z:zc.x*xc.y-zc.y*xc.x};
  // camRot rows are the view axes expressed in world coords: row0=right(xc),
  // row1=up(yc), row2=toward-viewer(zc).
  camRot = orthonormalize([[xc.x,xc.y,xc.z],[yc.x,yc.y,yc.z],[zc.x,zc.y,zc.z]]);
  tick();
}

function disc(x,y,r,fill,stroke,sw){
  ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fillStyle=fill; ctx.fill();
  if(stroke){ctx.lineWidth=sw||1; ctx.strokeStyle=stroke; ctx.stroke();}
}
function star(x,y,R,fill,stroke){
  ctx.beginPath();
  for(let i=0;i<10;i++){
    const a = Math.PI/2 + i*Math.PI/5, rr = i%2 ? R*.42 : R;
    const px = x + rr*Math.cos(a), py = y - rr*Math.sin(a);
    i ? ctx.lineTo(px,py) : ctx.moveTo(px,py);
  }
  ctx.closePath(); ctx.fillStyle=fill; ctx.fill();
  if(stroke){ctx.lineWidth=1.2; ctx.strokeStyle=stroke; ctx.stroke();}
}
// The sun gets its own glyph -- a glowing disc with short radiating rays -- so
// it's clearly not one of the star-shaped bookmark markers.
function sunSymbol(x,y,R,fill){
  const g = ctx.createRadialGradient(x,y,R*0.4,x,y,R*1.9);
  g.addColorStop(0,"rgba(232,163,23,0.45)");
  g.addColorStop(1,"rgba(232,163,23,0)");
  ctx.fillStyle=g;
  ctx.beginPath(); ctx.arc(x,y,R*1.9,0,6.2832); ctx.fill();
  ctx.strokeStyle=fill; ctx.lineWidth=1.6; ctx.lineCap="round";
  for(let i=0;i<8;i++){
    const a=i*Math.PI/4;
    ctx.beginPath();
    ctx.moveTo(x+Math.cos(a)*R*1.25, y+Math.sin(a)*R*1.25);
    ctx.lineTo(x+Math.cos(a)*R*1.7,  y+Math.sin(a)*R*1.7);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(x,y,R,0,6.2832);
  ctx.fillStyle=fill; ctx.fill();
  ctx.lineWidth=1.2; ctx.strokeStyle="#0f1419"; ctx.stroke();
}
function sq(x,y,s,fill){
  ctx.fillStyle=fill; ctx.fillRect(x-s,y-s,2*s,2*s);
  ctx.lineWidth=.8; ctx.strokeStyle="#0f1419"; ctx.strokeRect(x-s,y-s,2*s,2*s);
}
function roundedLabel(text,x,y){
  ctx.save();
  ctx.font = "bold 12px sans-serif";
  const padX = 7, w = ctx.measureText(text).width + 2*padX, h = 20;
  const bx = Math.min(CW-w-4, Math.max(4, x)), by = Math.min(CH-h-4, Math.max(4, y));
  ctx.fillStyle = "rgba(15,20,25,0.82)";
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, 6);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, bx+padX, by+14);
  ctx.restore();
}
function distanceFromSun(p){ return S && S.sun ? nrm(sub(p, S.sun)) : 0; }

// --- reachable convex hull -------------------------------------------------
// Build the 3D convex hull of the reachable cloud once per solution and cache
// the triangular faces (as world-space vertex triples).  Each frame we project,
// back-face-cull, depth-sort and paint them with low alpha so overlapping faces
// build up into a solid translucent blue volume -- the filled equivalent of the
// old point swarm.  Brute-force triple-face hull (same method as the backend's
// _brute_face_hull); the reachable cloud's hull has few vertices so it's cheap.
let _reachHullKey = null;
let _reachHullFaces = null;

function reachHullFaces(){
  if(!solution || !solution.reachCloud) return null;
  const cloud = solution.reachCloud;
  // Cheap cache key: identity + length is enough since a new solution replaces
  // the whole object.
  const key = (solution.meta ? solution.meta.timingMs + ':' : '') + cloud.length;
  if(key === _reachHullKey) return _reachHullFaces;
  _reachHullKey = key;
  _reachHullFaces = computeHullFaces(cloud);
  return _reachHullFaces;
}

// Returns array of {a,b,c} world-space triangles, or null if degenerate.
function computeHullFaces(cloudRaw){
  // Dedupe and drop provably-interior points (support-probe prune) so the
  // O(m^3) face test runs on a small vertex set.
  const seen = new Set();
  const pts = [];
  for(const p of cloudRaw){
    const x=+p.x, y=+p.y, z=+p.z;
    const k = x.toFixed(3)+','+y.toFixed(3)+','+z.toFixed(3);
    if(!seen.has(k)){ seen.add(k); pts.push([x,y,z]); }
  }
  if(pts.length < 4) return null;

  const V = hullVertexCandidates(pts);
  if(V.length < 4) return null;

  const ext = hullExtent(V);
  const areaEps = 1e-12*ext*ext, sideEps = 1e-7*ext;
  const faces = [];
  const n = V.length;
  for(let i=0;i<n-2;i++){
    const [ax,ay,az]=V[i];
    for(let j=i+1;j<n-1;j++){
      const [bx,by,bz]=V[j];
      const abx=bx-ax, aby=by-ay, abz=bz-az;
      for(let k=j+1;k<n;k++){
        const [cx,cy,cz]=V[k];
        const acx=cx-ax, acy=cy-ay, acz=cz-az;
        let nx=aby*acz-abz*acy, ny=abz*acx-abx*acz, nz=abx*acy-aby*acx;
        const nn=Math.hypot(nx,ny,nz);
        if(nn<=areaEps) continue;
        nx/=nn; ny/=nn; nz/=nn;
        const d=-(nx*ax+ny*ay+nz*az);
        let mx=-Infinity, mn=Infinity;
        for(const [x,y,z] of V){ const s=nx*x+ny*y+nz*z+d; if(s>mx)mx=s; if(s<mn)mn=s; }
        // Keep only support planes (all points on one side) -> hull faces.
        if(mx<=sideEps || mn>=-sideEps){
          faces.push({a:V[i], b:V[j], c:V[k]});
        }
      }
    }
  }
  return faces.length ? faces : null;
}

function hullExtent(V){
  let xs=V.map(p=>p[0]), ys=V.map(p=>p[1]), zs=V.map(p=>p[2]);
  return Math.max(
    Math.max(...xs)-Math.min(...xs),
    Math.max(...ys)-Math.min(...ys),
    Math.max(...zs)-Math.min(...zs), 1);
}

// Keep only points that are extreme in at least one probe direction; interior
// points cannot be hull vertices.  Over-prunes slightly but the reachable hull
// is convex and smooth so the fixed probe set captures its true vertices.
function hullVertexCandidates(pts){
  if(pts.length<=8) return pts;
  const probe=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const s=1/Math.sqrt(3);
  for(const sx of [1,-1]) for(const sy of [1,-1]) for(const sz of [1,-1]) probe.push([sx*s,sy*s,sz*s]);
  let seed=0x5eb;
  const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
  for(let i=0;i<48;i++){
    let x=rnd()*2-1, y=rnd()*2-1, z=rnd()*2-1;
    const m=Math.hypot(x,y,z)||1; probe.push([x/m,y/m,z/m]);
  }
  const keep=new Set();
  for(const [dx,dy,dz] of probe){
    let bi=0, bv=-Infinity;
    for(let i=0;i<pts.length;i++){
      const v=pts[i][0]*dx+pts[i][1]*dy+pts[i][2]*dz;
      if(v>bv){ bv=v; bi=i; }
    }
    keep.add(bi);
  }
  return [...keep].sort((a,b)=>a-b).map(i=>pts[i]);
}

function drawReachHull(faces){
  // The reachable hull is convex, so its projection is a convex polygon every
  // frame.  Collect the projected face vertices, take their 2D convex hull, and
  // fill that single outline with a soft radial gradient -- no visible facets.
  const seen=new Set();
  const pts=[];
  for(const f of faces){
    for(const v of [f.a,f.b,f.c]){
      // Dedup on the shared 3D vertex, NOT the rounded screen projection.
      // Integer-rounding the projection merges distinct corners that land near
      // each other and shaves the hull's sharp extremities flat.
      const k=v[0]+','+v[1]+','+v[2];
      if(!seen.has(k)){ seen.add(k); const q=project({x:v[0],y:v[1],z:v[2]}); pts.push([q.sx,q.sy]); }
    }
  }
  const poly=convexHull2D(pts);
  if(poly.length<3) return;

  // Centroid + radius for the radial gradient.
  let cx=0, cy=0;
  for(const p of poly){ cx+=p[0]; cy+=p[1]; }
  cx/=poly.length; cy/=poly.length;
  let R=0;
  for(const p of poly){ R=Math.max(R, Math.hypot(p[0]-cx,p[1]-cy)); }
  R=Math.max(R,1);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0][0],poly[0][1]);
  for(let i=1;i<poly.length;i++) ctx.lineTo(poly[i][0],poly[i][1]);
  ctx.closePath();

  const g=ctx.createRadialGradient(cx,cy,0,cx,cy,R);
  g.addColorStop(0.0,"rgba(143,184,222,0.34)");
  g.addColorStop(0.6,"rgba(143,184,222,0.20)");
  g.addColorStop(1.0,"rgba(143,184,222,0.04)");
  ctx.fillStyle=g;
  ctx.fill();
  // Faint smooth rim so the boundary reads without hard facet edges.
  ctx.lineJoin="round";
  ctx.strokeStyle="rgba(143,184,222,0.28)";
  ctx.lineWidth=1;
  ctx.stroke();
  ctx.restore();
}

// Andrew's monotone chain: 2D convex hull, counter-clockwise, O(n log n).
function convexHull2D(points){
  if(points.length<3) return points.slice();
  const pts=points.slice().sort((a,b)=> a[0]-b[0] || a[1]-b[1]);
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  // Strict < 0 (not <= 0): retain collinear boundary points rather than popping
  // them.  Popping collinear points can clip a true sharp corner when three
  // near-collinear projected points straddle a vertex.
  const lower=[];
  for(const p of pts){
    while(lower.length>=2 && cross(lower[lower.length-2],lower[lower.length-1],p)<0) lower.pop();
    lower.push(p);
  }
  const upper=[];
  for(let i=pts.length-1;i>=0;i--){
    const p=pts[i];
    while(upper.length>=2 && cross(upper[upper.length-2],upper[upper.length-1],p)<0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// --- allowed (green) concave silhouette ------------------------------------
// The allowed region is non-convex, so a convex hull would overstate it (claim
// unsafe positions as safe).  We build a concave outline (alpha-shape style) by
// starting from the convex hull and "denting" each edge inward toward the
// nearest interior point when the edge is much longer than the local point
// spacing.  This hugs concave pockets without ever extending beyond the actual
// allowed points.  Returns a screen-space polygon, or null if too few points.
function allowSilhouette(){
  if(!solution || !solution.allowCloud || solution.allowCloud.length < 8) return null;
  const pts = [];
  const seen = new Set();
  for(const p of solution.allowCloud){
    const q = project(p);
    const k = Math.round(q.sx)+','+Math.round(q.sy);
    if(!seen.has(k)){ seen.add(k); pts.push([q.sx,q.sy]); }
  }
  if(pts.length < 3) return null;

  // Characteristic spacing is computed ONCE per solution in WORLD space (see
  // allowWorldSpacing) and cached.  World spacing is camera-independent, and
  // project() is an affine map (rotation + uniform camScale*zoom), so we recover
  // the per-frame screen spacing by scaling.  This removes the previous O(n^2)
  // nearest-neighbour loop that ran every frame during drags.
  const spacing = allowWorldSpacing() * camScale * zoom;
  const maxEdge = Math.max(spacing * 4, 14);

  let poly = convexHull2D(pts);
  if(poly.length < 3) return null;

  // One denting pass: for each hull edge that's too long, find the interior
  // point closest to the edge midpoint (and inside the current outline's
  // neighbourhood) and splice it in, creating a concavity.  O(hullEdges * n);
  // hull edges are few, so this is cheap even at 4800 points.
  const inPoly = new Set(poly.map(p=>p[0]+','+p[1]));
  const result = [];
  for(let i=0;i<poly.length;i++){
    const a = poly[i], b = poly[(i+1)%poly.length];
    result.push(a);
    const elen = Math.hypot(b[0]-a[0], b[1]-a[1]);
    if(elen <= maxEdge) continue;
    const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2;
    let cand=null, cbest=Infinity;
    for(const p of pts){
      const key=p[0]+','+p[1];
      if(inPoly.has(key)) continue;
      const dm=(p[0]-mx)**2+(p[1]-my)**2;
      // Must be reasonably near the edge, else skip (avoids reaching across).
      if(dm < cbest && dm < (elen*elen)){ cbest=dm; cand=p; }
    }
    if(cand){ result.push(cand); inPoly.add(cand[0]+','+cand[1]); }
  }
  return result.length >= 3 ? result : poly;
}

// Median nearest-neighbour distance of the allowed cloud, in WORLD units,
// computed once per solution and cached.  Camera-independent, so it never needs
// recomputing during rotation/drag.  Sampled (<=200 probes) to bound cost.
let _allowSpacingKey = null;
let _allowSpacingWorld = 6;
function allowWorldSpacing(){
  const cloud = solution.allowCloud;
  const key = (solution.meta ? solution.meta.timingMs + ':' : '') + cloud.length;
  if(key === _allowSpacingKey) return _allowSpacingWorld;
  _allowSpacingKey = key;

  const P = cloud.map(p=>[+p.x,+p.y,+p.z]);
  const step = P.length > 200 ? Math.ceil(P.length/200) : 1;
  const nn = [];
  for(let i=0;i<P.length;i+=step){
    const a=P[i];
    let best=Infinity;
    for(let j=0;j<P.length;j++){
      if(j===i) continue;
      const dx=a[0]-P[j][0], dy=a[1]-P[j][1], dz=a[2]-P[j][2];
      const d=dx*dx+dy*dy+dz*dz;
      if(d>0 && d<best) best=d;
    }
    if(isFinite(best)) nn.push(Math.sqrt(best));
  }
  nn.sort((x,y)=>x-y);
  _allowSpacingWorld = nn.length ? nn[Math.floor(nn.length/2)] : 6;
  return _allowSpacingWorld;
}

function drawAllowSilhouette(poly){
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(poly[0][0],poly[0][1]);
  for(let i=1;i<poly.length;i++) ctx.lineTo(poly[i][0],poly[i][1]);
  ctx.closePath();

  let cx=0, cy=0;
  for(const p of poly){ cx+=p[0]; cy+=p[1]; }
  cx/=poly.length; cy/=poly.length;
  let R=0;
  for(const p of poly){ R=Math.max(R, Math.hypot(p[0]-cx,p[1]-cy)); }
  R=Math.max(R,1);

  const g=ctx.createRadialGradient(cx,cy,0,cx,cy,R);
  g.addColorStop(0.0,"rgba(63,163,77,0.34)");
  g.addColorStop(0.6,"rgba(63,163,77,0.22)");
  g.addColorStop(1.0,"rgba(63,163,77,0.06)");
  ctx.fillStyle=g;
  ctx.fill();
  ctx.lineJoin="round";
  ctx.strokeStyle="rgba(63,163,77,0.40)";
  ctx.lineWidth=1;
  ctx.stroke();
  ctx.restore();
}

// --- animated warp-step arrows ---------------------------------------------
// When a recipe is snapped (draggedRecipe), its `legs` describe the warps you
// perform in-game: each leg is {from,to,bm} in world space.  We draw them as
// arrows that animate on in sequence, so you can watch the build order.  The
// arrow runs from `from` to the bookmark landing point `bm` (where you actually
// stop and bookmark), not all the way to `to`.
let warpAnim = {active:false, t0:0, recipe:null};
const WARP_LEG_MS = 650;      // draw time per leg
const WARP_GAP_MS = 180;      // pause between legs

function startWarpAnim(recipe){
  if(!recipe || !recipe.legs || !recipe.legs.length){ warpAnim.active = false; return; }
  warpAnim = {active:true, t0:performance.now(), recipe};
  requestAnimationFrame(warpTick);
}
function warpTick(){
  if(!warpAnim.active) return;
  render();
  const legs = warpAnim.recipe.legs.length;
  const total = legs*WARP_LEG_MS + (legs-1)*WARP_GAP_MS;
  if(performance.now() - warpAnim.t0 < total + 400){
    requestAnimationFrame(warpTick);
  } else {
    warpAnim.active = false;
    render();  // final static frame with fully drawn arrows
  }
}
// Progress in [0,1] for leg i at time now; <=0 not started, >=1 fully drawn.
function legProgress(i, now){
  const start = i*(WARP_LEG_MS+WARP_GAP_MS);
  return Math.max(0, Math.min(1, (now - start)/WARP_LEG_MS));
}

function drawWarpArrows(recipe){
  if(!recipe || !recipe.legs || !recipe.legs.length) return;
  const now = warpAnim.active ? (performance.now() - warpAnim.t0) : Infinity;
  const legs = recipe.legs;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for(let i=0;i<legs.length;i++){
    const prog = legProgress(i, now);
    if(prog <= 0) continue;
    const L = legs[i];
    const a = project({x:L.from.x, y:L.from.y, z:L.from.z});
    const dest = project({x:L.to.x, y:L.to.y, z:L.to.z});   // destination object (planet/gate/BM)
    const b = project({x:L.bm.x,   y:L.bm.y,   z:L.bm.z});   // bookmark landing point along the line
    // Animate the full warp line growing from `from` toward the destination.
    const tipx = a.sx + (dest.sx-a.sx)*prog;
    const tipy = a.sy + (dest.sy-a.sy)*prog;

    // shaft: full line from source to the destination celestial you warp to
    ctx.strokeStyle = "rgba(90,100,115,0.45)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(tipx, tipy);
    ctx.stroke();

    // arrowhead at the destination once the leg is basically complete
    if(prog > 0.98){
      const ang = Math.atan2(dest.sy-a.sy, dest.sx-a.sx);
      const hl = 11, hw = Math.PI/7;
      ctx.fillStyle = "rgba(90,100,115,0.55)";
      ctx.beginPath();
      ctx.moveTo(dest.sx, dest.sy);
      ctx.lineTo(dest.sx - hl*Math.cos(ang-hw), dest.sy - hl*Math.sin(ang-hw));
      ctx.lineTo(dest.sx - hl*Math.cos(ang+hw), dest.sy - hl*Math.sin(ang+hw));
      ctx.closePath();
      ctx.fill();

      // numbered badge at the bookmark landing point (sits partway along the line)
      const bx = b.sx, by = b.sy;
      ctx.beginPath(); ctx.arc(bx, by, 9, 0, 6.2832);
      ctx.fillStyle = "#111"; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#fff"; ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(i+1), bx, by);
      ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
    }
  }
  ctx.restore();
}

function render(){
  ctx.clearRect(0,0,CW,CH);
  if(!S || !solution) return;
  const info = localClearanceInfo(BM);
  const items = [];

  // The reachable (blue) region is drawn as a filled convex-hull silhouette in
  // drawReachHull() below, not as individual points.  When the hull is
  // degenerate (<4 points / near-planar) we fall back to the point swarm.
  const reachFaces = reachHullFaces();
  if(!reachFaces){
    for(const p of solution.reachCloud){const q=project(p); items.push({d:q.depth,t:"r",x:q.sx,y:q.sy});}
  }

  // The allowed (green) region is NOT convex -- it is the intersection of the
  // per-gate clearance cones, so it can have concave pockets.  We draw it as a
  // concave (alpha-shape) silhouette that hugs the actual points, so it never
  // bulges outward and claims unsafe space as safe.  Degenerate sets (<3 points)
  // fall back to the dot swarm.
  const allowPoly = allowSilhouette();
  if(!allowPoly){
    for(const p of solution.allowCloud){const q=project(p); items.push({d:q.depth,t:"a",x:q.sx,y:q.sy});}
  }

  const bmq = project(BM), sunq = project(S.sun);
  items.push({d:sunq.depth,t:"sun",x:sunq.sx,y:sunq.sy});
  S.moons.forEach(m => {const q=project(m.pos); items.push({d:q.depth,t:"moon",x:q.sx,y:q.sy});});
  S.planets.forEach(p => {const q=project(p.pos); items.push({d:q.depth,t:"planet",x:q.sx,y:q.sy});});
  S.gates.forEach(g => {const q=project(g.pos); items.push({d:q.depth,t:"gate",x:q.sx,y:q.sy,g});});
  solution.per_gate.forEach(pg => {const q=project(pg.point); items.push({d:q.depth,t:"kn",x:q.sx,y:q.sy,col:pg.color});});
  items.push({d:bmq.depth,t:"bm",x:bmq.sx,y:bmq.sy});
  items.sort((a,b) => a.d-b.d);

  if(reachFaces) drawReachHull(reachFaces);
  if(allowPoly) drawAllowSilhouette(allowPoly);

  const evaluable = S.gates && S.gates.length >= 2;
  S.gates.forEach((g,k) => {
    const q = project(g.pos), c = info.per_gate.find(x => x.gateIndex === k);
    const col = !evaluable ? "#9aa5b1" : (c.ok ? "#2e8b57" : "#c0392b");
    ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(bmq.sx,bmq.sy); ctx.lineTo(q.sx,q.sy); ctx.stroke(); ctx.setLineDash([]);
  });

  // Animated warp-step arrows for the snapped recipe (drawn over the map but
  // under the celestial markers/labels below).
  if(draggedRecipe) drawWarpArrows(draggedRecipe);

  const gateLabels = [];
  for(const it of items){
    if(it.t === "r") disc(it.x,it.y,1.3,"rgba(143,184,222,0.26)");
    else if(it.t === "a") disc(it.x,it.y,2.0,"rgba(63,163,77,0.50)");
    else if(it.t === "sun") sunSymbol(it.x,it.y,9,"#e8a317");
    else if(it.t === "moon") disc(it.x,it.y,3,"#b39ddb","#fff",.6);
    else if(it.t === "planet") disc(it.x,it.y,7,"#7b4fb0","#fff",1.4);
    else if(it.t === "kn") { ctx.globalAlpha = 0.55; star(it.x,it.y,8,it.col,"#0f1419"); ctx.globalAlpha = 1; }
    else if(it.t === "gate") {sq(it.x,it.y,8,it.g.color); gateLabels.push({x:it.x,y:it.y,text:it.g.name,col:it.g.color});}
    else if(it.t === "bm") star(it.x,it.y,15,"#111","#fff");
  }
  drawGateLabels(gateLabels);
  roundedLabel("drag me", bmq.sx + 18, bmq.sy - 10);
  drawOrientationBall();
}

// Small orientation gnomon in the top-left corner.  It applies the current
// camera rotation matrix to the three world axes, so you can see how a drag is
// turning the view.  With the trackball-style matrix camera there are no poles
// or gimbal lock, so the gnomon simply shows the live orientation.  Axis
// directions here are rotation-only (independent of camCtr/zoom).
// Place gate labels so they don't overlap each other (Jita's four gates project
// on top of one another otherwise).  Greedy: for each label try a ring of
// candidate offsets around its gate at growing radius, take the first whose text
// box clears every already-placed box, and draw a faint leader line when the
// label had to move away from the marker.
function drawGateLabels(labels){
  if(!labels.length) return;
  ctx.save();
  ctx.font = "bold 13px sans-serif";
  const h = 15, pad = 3;
  const placed = [];
  const overlaps = (a,b) =>
    a.x < b.x+b.w+4 && a.x+a.w+4 > b.x && a.y < b.y+b.h+3 && a.y+a.h+3 > b.y;

  // Candidate label offsets (dx,dy) relative to the marker, ordered near->far:
  // an 8-way ring at growing radius.  dy is the text baseline; the box top is
  // baseline-h.  First ring (radius 0) keeps the original right-up default.
  const dirs = [];
  for(const rad of [0, 14, 26, 40, 56]){
    for(let k=0;k<8;k++){
      const ang = k*Math.PI/4;
      dirs.push([11 + Math.cos(ang)*rad, -8 + Math.sin(ang)*rad]);
    }
  }

  for(const L of labels){
    const w = ctx.measureText(L.text).width;
    let chosen = null;
    for(const [dx,dy] of dirs){
      const box = {x:L.x+dx, y:L.y+dy-h+2, w:w, h:h};
      // keep inside canvas
      if(box.x < 2 || box.x+box.w > CW-2 || box.y < 2 || box.y+box.h > CH-2) continue;
      if(placed.every(p => !overlaps(box,p))){ chosen = {dx,dy,box}; break; }
    }
    if(!chosen){
      // Fallback: default spot even if it overlaps (better than dropping it).
      chosen = {dx:11, dy:-8, box:{x:L.x+11, y:L.y-8-h+2, w:w, h:h}};
    }
    placed.push(chosen.box);
    const tx = L.x + chosen.dx, ty = L.y + chosen.dy;
    // leader line if the label was nudged well away from the marker
    const far = Math.hypot(chosen.dx-11, chosen.dy+8) > 10;
    if(far){
      ctx.beginPath();
      ctx.moveTo(L.x, L.y);
      ctx.lineTo(tx - 2, ty - 4);
      ctx.lineWidth = 0.8; ctx.strokeStyle = L.col; ctx.globalAlpha = 0.5; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // subtle halo so text stays readable over clouds
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(251,252,254,0.9)";
    ctx.strokeText(L.text, tx, ty);
    ctx.fillStyle = L.col;
    ctx.fillText(L.text, tx, ty);
  }
  ctx.restore();

  // Keep the per-gate 3D clearance spheres in sync with the camera.
  if(dials.length) drawGateSpheres();
}

function drawOrientationBall(){
  const cx = 46, cy = 46, R = 30;              // corner centre + radius
  // Rotate a unit world vector by the current camera matrix (no translation/zoom).
  const rotDir = (vx, vy, vz) => {
    const r = matVec(camRot, {x:vx, y:vy, z:vz});
    return {x:r.x, y:r.y, depth:r.z};          // depth = toward viewer (+ = front)
  };
  const axes = [
    {v:[1,0,0], col:"#d1495b", lab:"X"},
    {v:[0,1,0], col:"#3fa34d", lab:"Y"},
    {v:[0,0,1], col:"#2e86ab", lab:"Z"},
  ];

  ctx.save();
  // backing sphere
  ctx.beginPath(); ctx.arc(cx, cy, R+6, 0, 6.2832);
  ctx.fillStyle = "rgba(15,20,25,0.06)"; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = "rgba(15,20,25,0.18)"; ctx.stroke();

  // Build both ends of each axis (+ and -) and depth-sort so far ends draw first.
  const spokes = [];
  for(const a of axes){
    const p = rotDir(a.v[0], a.v[1], a.v[2]);
    const m = rotDir(-a.v[0], -a.v[1], -a.v[2]);
    spokes.push({...p, col:a.col, lab:a.lab, pos:true});
    spokes.push({...m, col:a.col, lab:a.lab, pos:false});
  }
  spokes.sort((s1,s2) => s1.depth - s2.depth);

  const sx = d => cx + d.x*R;
  const sy = d => cy - d.y*R;   // flip y to match the map's screen convention
  for(const s of spokes){
    const front = s.depth >= 0;
    const ex = sx(s), ey = sy(s);
    // spoke line from centre
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey);
    ctx.lineWidth = front ? 2.2 : 1.2;
    ctx.strokeStyle = s.col;
    ctx.globalAlpha = front ? 1.0 : 0.35;
    ctx.stroke();
    // tip dot + label only on the positive ends
    if(s.pos){
      ctx.beginPath(); ctx.arc(ex, ey, front ? 3.2 : 2.2, 0, 6.2832);
      ctx.fillStyle = s.col; ctx.fill();
      ctx.globalAlpha = front ? 1.0 : 0.4;
      ctx.fillStyle = s.col;
      ctx.font = "bold 10px sans-serif";
      ctx.fillText(s.lab, ex + (s.x>=0?4:-9), ey + (s.y>=0?-3:9));
    }
  }
  ctx.globalAlpha = 1.0;
  // centre pip
  ctx.beginPath(); ctx.arc(cx, cy, 1.8, 0, 6.2832);
  ctx.fillStyle = "#0f1419"; ctx.fill();

  ctx.restore();
}

function updateReadout(){
  if(!S) return;
  const evaluable = S.gates && S.gates.length >= 2;
  const kpi = document.getElementById("kpi");
  if(!evaluable){
    kpi.textContent = "n/a";
    kpi.className = "kpi";
    document.getElementById("gateclear").innerHTML = S.gates.map(g =>
      `<div style="color:#8a4b12"><b>${escapeHtml(g.name)}</b>: not evaluated</div>`
    ).join("");
    updateDials(localClearanceInfo(BM));
    return;
  }
  const info = localClearanceInfo(BM);
  const mn = info.minClearance;
  kpi.textContent = `${mn.toFixed(0)}°`;
  kpi.className = "kpi " + (mn >= THR ? "ok" : "bad");
  document.getElementById("gateclear").innerHTML = info.per_gate.map(g =>
    `<div style="color:${g.ok ? '#2e8b57' : '#c0392b'}"><b>${escapeHtml(g.name)}</b>: ${g.clearance.toFixed(0)}°</div>`
  ).join("");
  updateDials(info);
}

function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));}

function secValue(sec){
  if(sec === null || sec === undefined || sec === "") return null;
  const v = Number(sec);
  return Number.isFinite(v) ? v : null;
}
function secLabel(sec){
  const v = secValue(sec);
  return v === null ? "sec --" : `sec ${v.toFixed(1)}`;
}
function secClass(sec){
  const v = secValue(sec);
  if(v === null) return "unknown";
  if(v >= 0.5) return "high";
  if(v > 0.0) return "low";
  return "null";
}
function setSecurityBadge(sec){
  const b = document.getElementById("secbadge");
  if(!b) return;
  b.textContent = secLabel(sec);
  b.className = `secbadge ${secClass(sec)}`;
}

function fmtClr(v){
  // Clearance may be null (undefined metric, e.g. single-gate systems).
  return (v === null || v === undefined || !isFinite(v)) ? "n/a" : `${v.toFixed(0)}°`;
}

function renderRecipes(){
  const el = document.getElementById("recipes");
  let h = "<h3>How to build these bookmarks</h3>";
  h += '<div style="color:#52606d;margin-bottom:6px">k = N — one bookmark per gate:</div>';
  for(const pg of solution.per_gate){
    const tag = pg.nvalid ? "" : ' <span style="color:#c0392b">(no option clears threshold — best available)</span>';
    h += `<div class="g"><span class="gt" style="color:${pg.color}">${escapeHtml(pg.name)}</span> — ${fmtClr(pg.bestClearance)}${tag}<ol>`;
    for(const s of pg.steps) h += `<li>${escapeHtml(s)}</li>`;
    h += "</ol></div>";
  }
  if(draggedRecipe){
    const dok = draggedRecipe.minClearance !== null && draggedRecipe.minClearance >= THR;
    const genLabel = draggedRecipe.gen === 2 ? "two-warp" : (draggedRecipe.gen === 1 ? "single-warp" : "recipe");
    const clrNote = draggedRecipe.evaluable === false
      ? "(clearance not evaluated for this system)"
      : (dok ? "(serves all gates)" : '<span style="color:#c0392b">(does not clear threshold for all gates)</span>');
    h += `<div class="k1"><div class="gt">k = 1 — nearest buildable bookmark to your dragged position — ${genLabel}, min ${fmtClr(draggedRecipe.minClearance)} ` +
         clrNote + "</div><ol>";
    for(const s of draggedRecipe.steps) h += `<li>${escapeHtml(s)}</li>`;
    h += "</ol></div>";
  } else {
    const sc = solution.single.minClearance;
    const ok = sc !== null && sc >= THR;
    const clrNote = solution.evaluable === false
      ? "(clearance not evaluated for this system)"
      : (ok ? "(serves all gates)" : '<span style="color:#c0392b">(does not clear threshold for all gates — best available)</span>');
    h += `<div class="k1"><div class="gt">k = 1 — single shared bookmark — min ${fmtClr(sc)} ` +
         clrNote + "</div><ol>";
    for(const s of solution.single.steps) h += `<li>${escapeHtml(s)}</li>`;
    h += "</ol></div>";
  }
  el.innerHTML = h;
}

function eln(t,a){
  const e = document.createElementNS(NS,t);
  for(const k in a) e.setAttribute(k,a[k]);
  return e;
}
function buildDials(){
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  dials = [];
  if(!S || S.gates.length < 2){
    grid.innerHTML = '<div class="hint">Need at least two gates to draw clearance dials.</div>';
    return;
  }

  S.gates.forEach((g,k) => {
    const others = othersOf(k);
    const box = document.createElement("div"); box.className = "dial";
    const title = document.createElement("div"); title.className = "dtitle"; title.style.color = g.color;
    box.appendChild(title);
    const D = 164;
    const cv = document.createElement("canvas");
    cv.width = D; cv.height = D; cv.style.width = D+"px"; cv.style.height = D+"px";
    box.appendChild(cv); grid.appendChild(box);

    // Unit directions from this gate toward every other gate — the axes whose
    // surrounding cones are UNSAFE.  A warp-in direction is safe when its angle
    // to all of these exceeds the threshold.
    const axes = others.map(o => unit(sub(o.pos, g.pos)));
    dials.push({gateIndex:k, g, others, axes, cv, ctx:cv.getContext("2d"), D, title});
  });
  drawGateSpheres();
}

// Draw the safe-direction region as a shaded area on a small 3D sphere, one per
// gate, oriented by the same camera rotation as the main map.  Green = warp-in
// directions that clear the threshold against every gate-to-gate line; the black
// marker is the current bookmark's direction.
function drawGateSpheres(){
  if(!S || !dials.length) return;
  const thrCos = Math.cos(THR*Math.PI/180);
  dials.forEach(d => {
    const ctx = d.ctx, D = d.D, R = D/2 - 12, cx = D/2, cy = D/2;
    ctx.clearRect(0,0,D,D);

    // Rotate a world direction by the shared camera matrix; screen y flipped.
    const rot = v => { const r = matVec(camRot, {x:v.x,y:v.y,z:v.z}); return {x:r.x,y:r.y,z:r.z}; };

    // backing disc (the sphere silhouette)
    ctx.beginPath(); ctx.arc(cx,cy,R,0,6.2832);
    ctx.fillStyle = "rgba(15,20,25,0.05)"; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(15,20,25,0.18)"; ctx.stroke();

    // Sample the sphere surface; shade safe points green. Only draw the front
    // hemisphere (rotated z >= 0) so it reads as a solid ball.
    const step = 8;                       // degrees between samples
    for(let plat=-80; plat<=80; plat+=step){
      const la = plat*Math.PI/180, cla = Math.cos(la), sla = Math.sin(la);
      for(let plon=0; plon<360; plon+=step){
        const lo = plon*Math.PI/180;
        const w = {x:cla*Math.cos(lo), y:sla, z:cla*Math.sin(lo)};   // world dir
        // safe test against the true 3D axes (undirected: abs of dot)
        let safe = true;
        for(const a of d.axes){
          const c = Math.abs(w.x*a.x + w.y*a.y + w.z*a.z);
          if(c > thrCos){ safe = false; break; }   // within THR of a gate line -> unsafe
        }
        const r = rot(w);
        if(r.z < 0) continue;                        // back hemisphere hidden
        const ex = cx + r.x*R, ey = cy - r.y*R;
        const shade = 0.35 + 0.65*r.z;               // fade toward the rim
        if(safe){
          ctx.fillStyle = `rgba(63,163,77,${0.5*shade})`;
          ctx.fillRect(ex-2.2, ey-2.2, 4.4, 4.4);
        }
      }
    }

    // gate-to-gate axis tips (the unsafe centers) as small colored dots
    for(const a of d.axes){
      for(const s of [1,-1]){
        const r = rot({x:a.x*s, y:a.y*s, z:a.z*s});
        if(r.z < 0) continue;
        ctx.beginPath(); ctx.arc(cx + r.x*R, cy - r.y*R, 2.6, 0, 6.2832);
        ctx.fillStyle = "rgba(209,73,91,0.9)"; ctx.fill();
      }
    }

    // current bookmark direction marker
    const bmDir = unit(sub(BM, d.g.pos));
    const cl = clearanceLocal(BM, d.g, d.others);
    const col = cl >= THR ? "#2e8b57" : "#c0392b";
    const rb = rot(bmDir);
    const bx = cx + rb.x*R, by = cy - rb.y*R;
    // draw a small ring; filled if on the front, hollow if it's around the back
    ctx.beginPath(); ctx.arc(bx, by, 5, 0, 6.2832);
    if(rb.z >= 0){ ctx.fillStyle = col; ctx.fill(); ctx.lineWidth=1.4; ctx.strokeStyle="#fff"; ctx.stroke(); }
    else { ctx.lineWidth=1.6; ctx.strokeStyle=col; ctx.stroke(); }

    d.title.textContent = `${d.g.name} — ${cl.toFixed(0)}°`;
  });
}
function updateDials(info){
  if(!S || !dials.length) return;
  // The sphere draw recomputes clearance and the marker from BM directly, so we
  // just trigger a redraw.  (info is accepted for call-site compatibility.)
  drawGateSpheres();
}

async function fetchRegions(preferredRegion="The Forge"){
  const data = await loadIndex();
  REGIONS = data.regions || [];
  const sel = document.getElementById("regionsel");
  sel.innerHTML = "";
  for(const r of REGIONS){
    const o = document.createElement("option");
    o.value = r.name;
    o.textContent = `${r.name} · ${r.systems} systems`;
    sel.appendChild(o);
  }
  if(REGIONS.length){
    const preferred = REGIONS.find(r => r.name === preferredRegion) || REGIONS[0];
    currentRegion = preferred.name;
    sel.value = currentRegion;
  } else {
    currentRegion = "";
  }
}

async function fetchSystems(q="", preferredName=null, regionOverride=null){
  const region = regionOverride !== null ? regionOverride : currentRegion;
  const slug = _regionSlug[region];
  _currentSlug = slug || null;
  let items = slug ? (await loadSummaries(slug)).slice() : [];
  // Load the region's full body-position shard up front so a select is instant.
  if(slug) await loadSystemsShard(slug);
  const ql = q.trim().toLowerCase();
  if(ql) items = items.filter(x => (x.name + " " + (x.region||"")).toLowerCase().includes(ql));
  // Prefer Jita when visible, then by name.
  items.sort((a,b) => (a.name.trim().toLowerCase()==="jita"?0:1) - (b.name.trim().toLowerCase()==="jita"?0:1)
                       || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  SYSTEMS = items.slice(0, 2000);
  const sel = document.getElementById("syssel");
  sel.innerHTML = "";
  for(const s of SYSTEMS){
    const o = document.createElement("option");
    o.value = s.id;
    const regionPart = region ? "" : (s.region ? ` (${s.region})` : "");
    o.textContent = `${s.name}${regionPart} · ${secLabel(s.security)} · ${s.gates}g`;
    sel.appendChild(o);
  }
  if(SYSTEMS.length){
    const preferred = preferredName ? SYSTEMS.find(s => s.name.toLowerCase() === preferredName.toLowerCase()) : null;
    systemId = (preferred || SYSTEMS[0]).id;
    sel.value = systemId;
    const chosen = SYSTEMS.find(s => s.id === systemId);
    setSecurityBadge(chosen ? chosen.security : null);
    await loadSolution();
  } else {
    systemId = null;
    setSecurityBadge(null);
    document.getElementById("meta").textContent = "no matching systems";
  }
}

async function loadSolution(){
  if(systemId === null) return;
  const mySeq = ++solutionRequestSeq;
  document.getElementById("meta").textContent = "solving…";
  // Building geometry (cloud + pool) is the heavy step; yield to the event loop
  // so the "solving…" label paints before it runs, then bail if superseded.
  let data;
  try {
    const G = await geometryFor(systemId);
    if(mySeq !== solutionRequestSeq) return;
    const t0 = performance.now();
    data = window.NTMSolver.getSolution(G, THR, seed);
    data.solution.meta.timingMs = Math.round(performance.now() - t0);
  } catch(err){
    document.getElementById("meta").textContent = String(err.message || err);
    return;
  }
  if(mySeq !== solutionRequestSeq) return;
  S = data.system;
  solution = data.solution;
  BM = {...solution.single.point};
  draggedRecipe = null;
  computeCam();
  if(view2d){ topDownView(); } else { defaultView(); }
  buildDials();
  renderRecipes();
  updateReadout();
  const timing = solution.meta && solution.meta.timingMs !== undefined ? ` · ${solution.meta.timingMs} ms` : "";
  setSecurityBadge(S.security);
  document.getElementById("meta").textContent = `${S.name}${S.region ? " · "+S.region : ""} · ${secLabel(S.security)} · ${solution.meta.planets}p ${solution.meta.moons}m ${solution.meta.gates}g${timing}`;
  updateWarnBanner();
  render();
  // Show the warp-step arrows for the initial auto-picked bookmark, same as a
  // drag would.  fetchDraggedRecipe snaps to the nearest buildable recipe (which
  // for the single-solution point is itself) and animates its legs.
  fetchDraggedRecipe();
}

function updateWarnBanner(){
  const el = document.getElementById("warn");
  if(!el || !solution){ if(el) el.style.display = "none"; return; }
  const m = solution.meta || {};
  const gates = m.gates || 0;
  const evaluable = (solution.evaluable !== undefined) ? solution.evaluable : (gates >= 2);

  if(!evaluable){
    // Fewer than two gates: the gate-to-gate clearance metric is UNDEFINED, not
    // safe.  A threat can still camp the lone gate and catch an aligned warp-in;
    // this tool simply can't score that from gate-to-gate geometry.  Say so
    // plainly rather than implying the system is clear.
    el.innerHTML = gates === 1
      ? `<b>Single-gate system — not evaluated.</b> Clearance is measured between gates, so with only one gate this tool can't score it. This does <b>not</b> mean you're safe: a hostile can still camp the gate and catch an aligned warp-in. Pick an off-grid spot at your own judgement.`
      : `<b>No gates — not evaluated.</b> There are no gates to measure clearance against in this system.`;
    el.style.display = "block";
    return;
  }
  el.style.display = "none";
}

function tick(){ updateReadout(); render(); }

async function fetchDraggedRecipe(){
  if(systemId === null) return;
  const mySeq = ++recipeRequestSeq;
  let data;
  try {
    const G = await geometryFor(systemId);
    if(mySeq !== recipeRequestSeq) return;
    data = window.NTMSolver.nearestRecipe(G, {x:BM.x, y:BM.y, z:BM.z}, THR);
  } catch(err){ return; }
  if(mySeq !== recipeRequestSeq) return;       // a newer drag superseded this one
  if(!data.steps || !data.steps.length) return;
  draggedRecipe = data;
  if(data.point) BM = {x: data.point.x, y: data.point.y, z: data.point.z};  // snap to buildable landing
  renderRecipes();
  updateReadout();
  startWarpAnim(data);   // animate the warp-step arrows drawing on in sequence
  render();
}
function pickHit(mx,my){const q = project(BM); return Math.hypot(mx-q.sx,my-q.sy) < 16;}
function canvasMouse(e){
  const r = cvs.getBoundingClientRect();
  return {mx:(e.clientX-r.left)*(CW/r.width), my:(e.clientY-r.top)*(CH/r.height)};
}
function hideTip(){ if(tip) tip.style.display = "none"; }
function addHover(cands, label, kind, p, color, radius, details, priority=0){
  const q = project(p);
  cands.push({label, kind, p, color, radius, details, priority, sx:q.sx, sy:q.sy, d:0});
}
function hoverHit(mx,my){
  if(!S || !solution) return null;
  const cands = [];
  const evaluable = S.gates && S.gates.length >= 2;
  const info = localClearanceInfo(BM);
  const clr1 = v => (v === null || v === undefined || !isFinite(v)) ? "n/a" : `${v.toFixed(1)}°`;
  addHover(cands, "Shared bookmark", "draggable star", BM, "#111", 18,
    `Drag me. Min clearance ${evaluable ? clr1(info.minClearance) : "n/a (single-gate system)"}. Distance from sun ${distanceFromSun(BM).toFixed(2)} AU.`, 6);
  solution.per_gate.forEach(pg => addHover(cands, `${pg.name} bookmark`, "gate-specific bookmark", pg.point, pg.color, 13,
    `Recipe bookmark for ${pg.name}. Best clearance ${clr1(pg.bestClearance)}. Distance from sun ${distanceFromSun(pg.point).toFixed(2)} AU.`, 5));
  addHover(cands, "Sun", "star / system centre", S.sun, "#e8a317", 14, "System centre.", 1);
  S.planets.forEach((pl,i) => addHover(cands, pl.name || `Planet ${i+1}`, "planet", pl.pos, "#7b4fb0", 11,
    `Distance from sun ${distanceFromSun(pl.pos).toFixed(2)} AU.`, 2));
  S.moons.forEach((m,i) => addHover(cands, m.name || `Moon ${i+1}`, "moon", m.pos, "#b39ddb", 8,
    `Distance from sun ${distanceFromSun(m.pos).toFixed(2)} AU.`, 2));
  S.gates.forEach((g,k) => {
    const pg = info.per_gate.find(x => x.gateIndex === k);
    const clrTxt = evaluable && pg && isFinite(pg.clearance) ? `${pg.clearance.toFixed(1)}°` : "not evaluated";
    addHover(cands, g.name, "stargate", g.pos, g.color, 13,
      `Current shared-bookmark clearance: ${clrTxt}. Distance from sun ${distanceFromSun(g.pos).toFixed(2)} AU.`, 3);
  });
  let best = null;
  for(const c of cands){
    c.d = Math.hypot(mx-c.sx, my-c.sy);
    if(c.d <= c.radius && (!best || c.d - c.priority*1.5 < best.d - best.priority*1.5)) best = c;
  }
  return best;
}
function showTip(hit, clientX, clientY){
  if(!tip) return;
  if(!hit){ hideTip(); return; }
  const dotShape = hit.kind.includes("bookmark") || hit.kind.includes("star") ? "border-radius:0;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 56%,79% 91%,50% 70%,21% 91%,32% 56%,2% 35%,39% 35%);" : "";
  tip.innerHTML = `<span class="tipdot" style="background:${hit.color};${dotShape}"></span><b>${escapeHtml(hit.label)}</b><br><span class="tipmeta">${escapeHtml(hit.kind)} · ${escapeHtml(hit.details)}</span>`;
  tip.style.left = `${clientX + 14}px`;
  tip.style.top = `${clientY + 14}px`;
  tip.style.display = "block";
}

cvs.addEventListener("pointerdown", e => {
  if(!S || !solution) return;
  const {mx,my} = canvasMouse(e);
  hideTip();
  mode = pickHit(mx,my) ? "bm" : "orbit";
  last = {x:e.clientX,y:e.clientY};
  cvs.setPointerCapture(e.pointerId);
});
cvs.addEventListener("pointermove", e => {
  if(!S || !solution) return;
  if(!mode){
    const {mx,my} = canvasMouse(e);
    showTip(hoverHit(mx,my), e.clientX, e.clientY);
    return;
  }
  hideTip();
  const dx = e.clientX-last.x, dy = e.clientY-last.y;
  last = {x:e.clientX,y:e.clientY};
  if(mode === "orbit"){
    if(view2d) return;
    // Turntable feel, gimbal-lock-free: horizontal drag spins about the current
    // screen-vertical axis, vertical drag tilts about the current screen-
    // horizontal axis.  Both are applied in VIEW space (post-multiply on the
    // left), so they always act relative to what you currently see.
    const kx = dx*0.01, ky = dy*0.01;
    // In view space, screen-right = (1,0,0), screen-up = (0,1,0).
    // Horizontal drag -> rotate about view-up (0,1,0).
    // Vertical drag   -> rotate about view-right (1,0,0).
    let R = camRot;
    if(kx) R = matMul(axisAngle(0,1,0, kx), R);
    if(ky) R = matMul(axisAngle(1,0,0, ky), R);
    camRot = orthonormalize(R);
  } else {
    const d = screenDeltaToWorld(dx,dy);
    BM = {x:BM.x+d.x, y:BM.y+d.y, z:BM.z+d.z};
  }
  tick();
});
cvs.addEventListener("pointerup", () => {
  const wasDragging = mode === "bm";
  mode = null;
  if(wasDragging) fetchDraggedRecipe();
});
cvs.addEventListener("pointerleave", () => {
  const wasDragging = mode === "bm";
  mode = null; hideTip();
  if(wasDragging) fetchDraggedRecipe();
});
cvs.addEventListener("wheel", e => {e.preventDefault(); zoom*=Math.exp(-e.deltaY*0.0011); zoom=Math.max(0.2,Math.min(6,zoom)); tick();}, {passive:false});

document.getElementById("regionsel").addEventListener("change", async e => {
  currentRegion = e.target.value;
  seed = 0;
  document.getElementById("mask").value = "";
  await fetchSystems("", currentRegion === "The Forge" ? "Jita" : null, currentRegion);
});
document.getElementById("mask").addEventListener("input", e => fetchSystems(e.target.value, null, currentRegion));
document.getElementById("syssel").addEventListener("change", async e => {
  systemId=+e.target.value;
  seed=0;
  const chosen = SYSTEMS.find(s => s.id === systemId);
  setSecurityBadge(chosen ? chosen.security : null);
  await loadSolution();
});
document.getElementById("thr").addEventListener("input", e => {
  THR = +e.target.value;
  document.getElementById("thrv").textContent = `${THR}°`;
  clearTimeout(thresholdTimer);
  thresholdTimer = setTimeout(loadSolution, 220);
});
document.getElementById("thr").addEventListener("change", async e => {
  THR = +e.target.value;
  document.getElementById("thrv").textContent = `${THR}°`;
  clearTimeout(thresholdTimer);
  await loadSolution();
});
document.getElementById("repick").addEventListener("click", async () => {seed += 1; await loadSolution();});
document.getElementById("view2d").addEventListener("click", () => {
  view2d = !view2d;
  document.getElementById("view2d").textContent = view2d ? "3D view" : "2D view";
  if(view2d){ topDownView(); } else { defaultView(); }
  tick();
});
document.getElementById("layflat").addEventListener("click", () => {
  if(view2d){ view2d = false; document.getElementById("view2d").textContent = "2D view"; }
  layFlat();
});

async function init(){
  await fetchRegions("The Forge");
  await fetchSystems("", "Jita", currentRegion);
}
init();
