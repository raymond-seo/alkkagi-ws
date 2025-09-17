// server/engine.js — 서버 전용 물리(드로잉/DOM 없음)
export const BOARD = { W: 360, H: 640 };

class Vec {
  constructor(x=0,y=0){ this.x=x; this.y=y; }
  add(v){ this.x+=v.x; this.y+=v.y; return this; }
  mul(s){ this.x*=s; this.y*=s; return this; }
  len(){ return Math.hypot(this.x,this.y); }
  set(x,y){ this.x=x; this.y=y; return this; }
  copy(){ return new Vec(this.x,this.y); }
  normalize(){ const l=this.len()||1; this.x/=l; this.y/=l; return this; }
}

class Puck {
  constructor(id,team,x,y,r=18){
    this.id=id; this.team=team;
    this.p=new Vec(x,y);
    this.v=new Vec(0,0);
    this.r=r; this.out=false;
  }
}

export class AlkkagiEngine {
  constructor(){
    this.w = BOARD.W; this.h = BOARD.H;
    this.friction = 0.992;
    this.dt = 1; // 고정 틱
    this.pucks = [];
    this.turn = "cat";
    this.reset();
  }

  reset(){
    this.pucks = [];
    const cols = 3, gap = 52, offY=120;
    // 고양이(상단)
    for(let i=0;i<5;i++){
      const x = this.w*0.5 + (i%cols -1)*gap;
      const y = offY + Math.floor(i/cols)*gap;
      this.pucks.push(new Puck("C"+i,"cat",x,y));
    }
    // 강아지(하단)
    for(let i=0;i<5;i++){
      const x = this.w*0.5 + (i%cols -1)*gap;
      const y = this.h - offY - Math.floor(i/cols)*gap;
      this.pucks.push(new Puck("D"+i,"dog",x,y));
    }
    this.turn='cat';
  }

  anyMoving(){
    const eps = 0.02;
    return this.pucks.some(p => !p.out && (Math.abs(p.v.x) > eps || Math.abs(p.v.y) > eps));
  }

  update(){
    // 이동/감속/OUT
    for(const p of this.pucks){
      if (p.out) continue;
      p.p.add(p.v.copy().mul(this.dt));
      p.v.mul(this.friction);
      if (Math.abs(p.v.x) < 0.01) p.v.x = 0;
      if (Math.abs(p.v.y) < 0.01) p.v.y = 0;

      if (p.p.x < -p.r || p.p.x > this.w + p.r || p.p.y < -p.r || p.p.y > this.h + p.r){
        p.out = true;
        p.v.set(0,0);
      }
    }
    // 충돌
    for(let i=0;i<this.pucks.length;i++){
      for(let j=i+1;j<this.pucks.length;j++){
        const A=this.pucks[i], B=this.pucks[j];
        if (A.out||B.out) continue;
        const dx=B.p.x-A.p.x, dy=B.p.y-A.p.y;
        const dist=Math.hypot(dx,dy);
        const min=A.r+B.r;
        if (dist>0 && dist<min){
          const nx=dx/dist, ny=dy/dist;
          const overlap=min-dist;
          A.p.x -= nx*overlap/2; A.p.y -= ny*overlap/2;
          B.p.x += nx*overlap/2; B.p.y += ny*overlap/2;
          const rvx=B.v.x-A.v.x, rvy=B.v.y-A.v.y;
          const sep = rvx*nx + rvy*ny;
          if (sep<0){
            const imp = -(1.0)*sep;
            A.v.x -= imp*nx; A.v.y -= imp*ny;
            B.v.x += imp*nx; B.v.y += imp*ny;
          }
        }
      }
    }
  }

  applyImpulseById(pieceId, vec){
    const p = this.pucks.find(x=>x.id===pieceId && !x.out);
    if (!p) return false;
    p.v.x += vec.x; p.v.y += vec.y;
    return true;
  }

  computeToRest(maxSteps=8000){
    let steps=0;
    while(this.anyMoving() && steps<maxSteps){
      this.update();
      steps++;
    }
    if (this.anyMoving()){
      for (const p of this.pucks){ p.v.set(0,0); }
    }
    return steps;
  }

  getAliveCounts(){
    const cat = this.pucks.filter(p=>p.team==='cat'&&!p.out).length;
    const dog = this.pucks.filter(p=>p.team==='dog'&&!p.out).length;
    return {cat,dog};
  }

  snapshot(nextTurn=null){
    return {
      pucks: this.pucks.map(p=>({
        id:p.id, team:p.team,
        x:+p.p.x.toFixed(3),
        y:+p.p.y.toFixed(3),
        out: !!p.out
      })),
      turn: nextTurn ?? this.turn
    };
  }

  applySnapshot(s){
    this.pucks = s.pucks.map(pp=>{
      const p = new Puck(pp.id, pp.team, pp.x, pp.y);
      p.out = !!pp.out;
      return p;
    });
    this.turn = s.turn;
    for(const p of this.pucks) p.v.set(0,0);
  }
}
