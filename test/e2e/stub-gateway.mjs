/**
 * Cổng thanh toán giả cho `payment-e2e.mjs`.
 *
 * Chỉ trả `resultCode: 0` kèm một `payUrl` — đủ để luồng tạo đơn đi hết mà
 * không cần credential Momo thật.
 */
import http from 'http';
http.createServer((req,res)=>{
  let b='';req.on('data',c=>b+=c);req.on('end',()=>{
    const p=JSON.parse(b||'{}');
    console.log('STUB got amount=',p.amount,'orderId=',p.orderId);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({resultCode:0,payUrl:'https://stub/pay/'+p.orderId,deeplink:'momo://stub',requestId:p.requestId}));
  });
}).listen(4499,()=>console.log('stub on 4499'));
