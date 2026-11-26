// f32 emulation of the plan-4.8 planar projection in the fragment shader:
//   uv = dot(wp - o, u/|u|^2)   (wp = interpolated f32 world position, o = f32 frame origin)
// vs. per-vertex UVs computed in f64 at export, interpolated in f32.
// Tile repeat 300 mm, 1024 texels per repeat (plan: 1024x1024 display pattern).
const f=Math.fround, REP=300, TEX=1024;
function run(label, x0, y0, cx) {
  // A wall face in the plane y = y0, 3640 mm long, 2400 mm high; u = +x direction.
  const P=[[x0,y0,0],[x0+3640,y0,0],[x0+3640,y0,2400]];
  const Pf=P.map(p=>p.map(f));                          // f32 vertex positions (MDSP stores f32 world coords)
  const footX=0;                                         // foot of the perpendicular from the world origin (u component)
  const oSnap=f(footX+Math.round((cx-footX)/REP)*REP);   // snapped by whole repeats toward the house centre
  const oFoot=f(footX);
  const inv=f(1/REP);
  const uvV=P.map(p=>f((p[0]-oSnap)/REP));               // per-vertex UVs from f64 geometry
  let maxErr={snap:0,foot:0,vert:0}, maxJump={snap:0,foot:0,vert:0}, prev=null; const distinct={snap:new Set(),foot:new Set(),vert:new Set()};
  for (let i=0;i<=1000;i++){                           // 10 mm span sampled every 0.01 mm at z = 1200
    const x=x0+1000+i*0.01, z=1200;
    // barycentrics in f64 (exact screen sampling); interpolation done in f32: a0 + b1*(a1-a0) + b2*(a2-a0)
    const b2=z/2400, b1=(x-x0)/3640-b2, b0=1-b1-b2;
    const wpx=f(f(Pf[0][0]+f(f(b1)*f(Pf[1][0]-Pf[0][0])))+f(f(b2)*f(Pf[2][0]-Pf[0][0])));
    const ref=(b0*Pf[0][0]+b1*Pf[1][0]+b2*Pf[2][0]-oSnap)/REP;  // exact uv on the drawn (f32) triangle
    const refFoot=(b0*Pf[0][0]+b1*Pf[1][0]+b2*Pf[2][0]-oFoot)/REP;
    const snap=f(f(wpx-oSnap)*inv), foot=f(wpx*inv);
    const vert=f(f(uvV[0]+f(f(b1)*f(uvV[1]-uvV[0])))+f(f(b2)*f(uvV[2]-uvV[0])));
    const refV=(b0*P[0][0]+b1*P[1][0]+b2*P[2][0]-oSnap)/REP;   // exact uv on the f64 geometry
    const cur={snap,foot,vert};
    maxErr.snap=Math.max(maxErr.snap,Math.abs(snap-ref)*TEX);
    maxErr.foot=Math.max(maxErr.foot,Math.abs((foot-refFoot)-Math.round(foot-refFoot))*TEX);
    maxErr.vert=Math.max(maxErr.vert,Math.abs(vert-refV)*TEX);
    for (const k in cur){distinct[k].add(cur[k]); if(prev) maxJump[k]=Math.max(maxJump[k],Math.abs(cur[k]-prev[k])*TEX);}
    prev=cur;
  }
  const r=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,+v.toFixed(3)]));
  console.log(`${label}: wall at x0=${x0}, y0=${y0}, house centre x=${cx}, snapped o.x=${oSnap}`);
  console.log(`  max |uv error| in texels      `, r(maxErr));
  console.log(`  max jump between samples 0.01 mm apart (texels; exact = ${(0.01/REP*TEX).toFixed(3)})`, r(maxJump));
  console.log(`  distinct uv values over a 10 mm span (1001 samples)`, Object.fromEntries(Object.entries(distinct).map(([k,v])=>[k,v.size])));
}

for (const x of [1e5,1e6,2.1e6,4.2e6]) run('x='+x, x, x, x+1820);
