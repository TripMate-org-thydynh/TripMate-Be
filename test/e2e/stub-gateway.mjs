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
    // ZaloPay gửi `app_id` và mong `return_code` + `order_url`; còn lại là MoMo.
    if (p.app_id) {
      res.end(JSON.stringify({return_code:1,return_message:'OK',order_url:'https://stub/zalo/'+p.app_trans_id,cashier_order_url:'https://stub/zalo/c/'+p.app_trans_id}));
      return;
    }
    res.end(JSON.stringify({resultCode:0,payUrl:'https://stub/pay/'+p.orderId,deeplink:'momo://stub',requestId:p.requestId}));
  });
}).listen(4499,()=>console.log('stub on 4499'));
