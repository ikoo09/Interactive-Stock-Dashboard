/*
 * CryptoScan Pro — 1D analysis engine
 * Keeps the existing UI and 1D timeframe. Replaces only the calculation layer.
 */
(() => {
  'use strict';
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n)); const finite=Number.isFinite;
  function sma(v,p){if(v.length<p)return null;let s=0;for(let i=v.length-p;i<v.length;i++)s+=v[i];return s/p;}
  function ema(v,p){if(v.length<p)return null;let s=0;for(let i=0;i<p;i++)s+=v[i];let r=s/p,k=2/(p+1);for(let i=p;i<v.length;i++)r=v[i]*k+r*(1-k);return r;}
  function rsi(v,p=14){if(v.length<=p)return 50;let g=0,l=0;for(let i=v.length-p;i<v.length;i++){let d=v[i]-v[i-1];if(d>=0)g+=d;else l-=d;}let ag=g/p,al=l/p;if(al===0)return 100;let rs=ag/al;return 100-100/(1+rs);}
  function atr(o,p=14){if(o.length<=p)return null;let t=[];for(let i=1;i<o.length;i++){let c=o[i],pc=o[i-1].c;t.push(Math.max(c.h-c.l,Math.abs(c.h-pc),Math.abs(c.l-pc)));}if(t.length<p)return null;let r=t.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<t.length;i++)r=((r*(p-1))+t[i])/p;return r;}
  function macd(v){if(v.length<35)return{line:0,signal:0,hist:0};let s=[];for(let i=26;i<=v.length;i++){let x=v.slice(0,i);s.push(ema(x,12)-ema(x,26));}let line=s[s.length-1]||0,signal=ema(s,9)||0;return{line,signal,hist:line-signal};}
  function vwap(p,vol){if(!p.length||p.length!==vol.length)return null;let pv=0,vv=0;for(let i=0;i<p.length;i++){let x=Number(vol[i]);if(!finite(x))continue;pv+=p[i]*x;vv+=x;}return vv>0?pv/vv:null;}
  function volumeRatio(v,p=20){if(v.length<=p)return 1;let cur=v[v.length-1],base=v.slice(-p-1,-1),avg=base.reduce((a,b)=>a+b,0)/base.length;return avg>0?cur/avg:1;}
  function analyze(c){
    let p=Array.isArray(c.prices)?c.prices.filter(finite):[],o=Array.isArray(c.ohlc)?c.ohlc.filter(x=>x&&finite(x.o)&&finite(x.h)&&finite(x.l)&&finite(x.c)):[],vol=Array.isArray(c.volumes)?c.volumes.map(Number).filter(finite):[];
    if(p.length<50||o.length<50)return;
    let price=p[p.length-1],e9=ema(p,9),e21=ema(p,21),e50=ema(p,50),e200=ema(p,200),s20=sma(p,20),r=rsi(p),a=atr(o)||Math.abs(price)*.01,m=macd(p),vw=vwap(p,vol),vr=volumeRatio(vol),last=o[o.length-1];
    let hh=o.slice(-30).map(x=>x.h),ll=o.slice(-30).map(x=>x.l),res=Math.max(...hh),sup=Math.min(...ll),range=Math.max(res-sup,a*2);
    let bull=0,bear=0,reasons=[];
    [[e9,e21],[e21,e50],[e50,e200]].forEach(([x,y])=>{if(finite(x)&&finite(y)){if(x>y)bull+=2;else bear+=2;}});
    if(finite(vw)){if(price>vw)bull+=2;else bear+=2;}
    if(finite(s20)){if(price>s20)bull+=2;else bear+=2;}
    if(r>=55&&r<=68){bull+=1.5;reasons.push('RSI mendukung momentum bullish');}else if(r<=45&&r>=32){bear+=1.5;reasons.push('RSI mendukung momentum bearish');}else if(r>72){bear+=2;reasons.push('RSI overbought');}else if(r<28){bull+=2;reasons.push('RSI oversold');}
    if(m.hist>0){bull+=2;reasons.push('MACD histogram positif');}else if(m.hist<0){bear+=2;reasons.push('MACD histogram negatif');}
    if(vr>=1.25){if(last.c>=last.o){bull+=2;reasons.push(`volume tinggi (${vr.toFixed(1)}x) mengonfirmasi candle naik`);}else{bear+=2;reasons.push(`volume tinggi (${vr.toFixed(1)}x) mengonfirmasi candle turun`);}}
    let body=Math.abs(last.c-last.o),cr=Math.max(last.h-last.l,a*.1);if(body/cr>=.6){if(last.c>last.o){bull++;reasons.push('candle 1D memiliki body bullish kuat');}else{bear++;reasons.push('candle 1D memiliki body bearish kuat');}}
    let ds=((price-sup)/price)*100,dr=((res-price)/price)*100;if(ds>=0&&ds<=3.5){bull+=1.5;reasons.push('harga dekat support');}if(dr>=0&&dr<=3.5){bear+=1.5;reasons.push('harga dekat resistance');}
    let net=bull-bear, strength=bull+bear, signal='HOLD / WAIT';if(net>=7&&bull>=bear*1.35)signal='STRONG BUY';else if(net>=3.5)signal='BUY';else if(net<=-7&&bear>=bull*1.35)signal='STRONG SELL';else if(net<=-3.5)signal='SELL';
    let conf=signal==='HOLD / WAIT'?50+Math.min(9,Math.abs(net)*2):50+(Math.abs(net)/Math.max(strength,1))*42;conf=clamp(conf,50,95);
    let bullish=net>0,entry=price,sl=bullish?Math.max(sup-a*.25,price-a*1.5):Math.min(res+a*.25,price+a*1.5),risk=Math.abs(entry-sl),tp1=bullish?entry+risk*1.5:entry-risk*1.5,tp2=bullish?entry+risk*2.5:entry-risk*2.5;
    Object.assign(c,{ema9:e9,ema21:e21,ema50:e50,ema200:e200,sma20:s20,rsi:r,atr:a,macdValue:m.line,macdSignal:m.signal,macdHistogram:m.hist,vwap:vw,volumeRatio:vr,res2:res,res1:res-range*.236,sup1:sup+range*.236,sup2:sup,entry,stopLoss:sl,takeProfit1:tp1,takeProfit2:tp2,riskReward:risk>0?Math.abs(tp2-entry)/risk:null,signal,confidencePct:conf,confidenceStr:`${conf.toFixed(1)}% ${signal.includes('SELL')?'BEARISH':signal.includes('BUY')?'BULLISH':'NETRAL'}`,confidenceColor:signal.includes('SELL')?'text-cryptoRed':signal.includes('BUY')?'text-cryptoGreen':'text-cryptoYellow',trendStatus:(finite(e50)&&finite(e21)&&e21>e50&&(finite(e200)?e50>=e200:true))?'UPTREND (1D)':(finite(e50)&&finite(e21)&&e21<e50&&(finite(e200)?e50<=e200:true))?'DOWNTREND (1D)':'KONSOLIDASI (1D)',macd:m.hist>0?'BULLISH':m.hist<0?'BEARISH':'NEUTRAL',analysisReasons:reasons.slice(-5)});
    if(!c.analysisReasons.length)c.analysisReasons=['Konfluensi indikator belum cukup kuat'];
  }
  window.calculateTechnicalIndicatorsWeekly=function(key){try{const db=typeof cryptoDatabase!=='undefined'?cryptoDatabase:null;if(db&&db[key])analyze(db[key]);}catch(e){console.warn('1D analysis engine:',e);}};
})();
