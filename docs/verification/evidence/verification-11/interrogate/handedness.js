// Image coords (s,t): s grows to the image's right, t grows DOWN the image (plan 4.8: "画像のvは下向きに増える").
// A face point is o + s*u + t*v. Seen from the front (eye on the +n side), the image reads
// correctly iff image-right x image-down == -n (right x down = -(right x up) = -toward-eye).
// So (u x v).n < 0 => reads correctly; > 0 => mirror image.
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const Z=[0,0,1];
const check=(name,n,u,v)=>{const s=dot(cross(u,v),n);console.log(`${name.padEnd(58)} n=${JSON.stringify(n)} u=${JSON.stringify(u)} v=${JSON.stringify(v)} -> ${s<0?'reads correctly':'MIRRORED'}`)};
console.log('--- plan.md 4.8 rules (as written) ---');
for (const n of [[0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[Math.SQRT1_2,Math.SQRT1_2,0]]) check('wall: u = z x n, v = +z',n,cross(Z,n),Z);
check('floor top: u = +x, v = +y',[0,0,1],[1,0,0],[0,1,0]);
check('ceiling (underside): u = +x, v = -y',[0,0,-1],[1,0,0],[0,-1,0]);
console.log('--- prototype frames actually rendered (room.rs @7e8a02037, pattern-a/b) ---');
check('floor face 5: u=[0,240,0] v=[480,0,0]',[0,0,1],[0,240,0],[480,0,0]);
check('south wall inner face 3 (n=+y): u=[600,0,0] v=+z',[0,1,0],[600,0,0],[0,0,600]);
check('east wall inner face 0 (n=-x): u=[0,600,0] v=+z',[-1,0,0],[0,600,0],[0,0,600]);
check('north wall inner face 2 (n=-y): u=[-600,0,0] v=+z',[0,-1,0],[-600,0,0],[0,0,600]);
check('west wall inner face 1 (n=+x): u=[0,-600,0] v=+z',[1,0,0],[0,-600,0],[0,0,600]);
console.log('--- prototype triplanar (viewport-maps.wgsl: scaled.yz on x-facing, scaled.xz on y-facing) ---');
check('column side facing +x: yz projection',[1,0,0],[0,1,0],[0,0,1]);
check('column side facing -x: yz projection',[-1,0,0],[0,1,0],[0,0,1]);
check('column side facing +y: xz projection',[0,1,0],[1,0,0],[0,0,1]);
check('column side facing -y: xz projection',[0,-1,0],[1,0,0],[0,0,1]);
console.log('--- walls: is the image upright? (image-down must point to world -z) ---');
for (const [name,v] of [['plan wall v = +z',[0,0,1]],['prototype wall v = [0,0,600]',[0,0,600]]]) console.log(`${name.padEnd(40)} image top row at ${dot(v,Z)>0?'the FLOOR side (upside down)':'the ceiling side (upright)'}`);
