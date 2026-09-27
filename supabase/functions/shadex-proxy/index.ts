import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"content-type":"application/json"}});
const base=(Deno.env.get("SHADEX_API_BASE_URL")||"").replace(/\/$/,"");
const apiKey=Deno.env.get("SHADEX_API_KEY")||"";

async function shadex(path:string,init:RequestInit={}){
  if(!base||!apiKey) throw new Error("ShadexGoLtd API is not configured.");
  const r=await fetch(base+path,{...init,headers:{accept:"application/json","content-type":"application/json",authorization:`Bearer ${apiKey}`,...(init.headers||{})}});
  const body=await r.json().catch(()=>({success:false,error:{message:"Invalid upstream response."}}));
  if(!r.ok||body?.success===false){const e=new Error(body?.error?.message||body?.data?.message||`Upstream request failed (${r.status}).`);(e as any).status=r.status;throw e;}
  return body.data;
}

Deno.serve(async req=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  try{
    const url=Deno.env.get("SUPABASE_URL")!, anon=Deno.env.get("SUPABASE_ANON_KEY")!, service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth=req.headers.get("Authorization")||"";
    const client=createClient(url,anon,{global:{headers:{Authorization:auth}}});
    const {data:{user}}=await client.auth.getUser();
    if(!user) return json({error:"Unauthorized"},401);
    const admin=createClient(url,service);
    const {action,payload={}}=await req.json();

    if(action==="catalogue") return json(await shadex("/api/v1/vtu/products"));
    if(action!=="purchase") return json({error:"Unsupported action."},400);

    const serviceType=String(payload.service_type||"");
    if(!["data","airtime"].includes(serviceType)) return json({error:"Invalid service type."},400);
    const amount=Number(payload.customer_amount);
    if(!Number.isFinite(amount)||amount<=0) return json({error:"Invalid purchase amount."},400);
    const localKey=String(payload.idempotency_key||crypto.randomUUID());

    const {data:txId,error:reserveError}=await admin.rpc("reserve_vtu_purchase",{p_user_id:user.id,p_type:serviceType,p_amount:amount,p_network:String(payload.network_name||""),p_phone:String(payload.phone_number||""),p_idempotency_key:localKey});
    if(reserveError) return json({error:reserveError.message},reserveError.message.toLowerCase().includes("insufficient")?402:400);

    try{
      const orderBody:any={service_type:serviceType,network_id:String(payload.network_id),phone_number:String(payload.phone_number)};
      if(serviceType==="data") orderBody.data_plan_id=String(payload.data_plan_id);
      else orderBody.amount=String(payload.amount);
      const upstream=await shadex("/api/v1/vtu/orders",{method:"POST",headers:{"Idempotency-Key":localKey},body:JSON.stringify(orderBody)});
      const order=upstream?.order||upstream;
      const providerId=String(order?.id||order?.order_id||"")||null;
      const status=String(order?.status||"processing");
      await admin.rpc("complete_vtu_purchase",{p_transaction_id:txId,p_provider_reference:providerId,p_provider_status:status});
      return json({transaction_id:txId,order,status,message:status==="successful"?"Purchase successful.":"Purchase submitted and is processing."},201);
    }catch(e){
      const status=Number((e as any).status||500);
      // 4xx means upstream rejected before an uncertain provider state; refund locally.
      if(status>=400&&status<500) await admin.rpc("refund_vtu_purchase",{p_transaction_id:txId,p_reason:(e as Error).message});
      else await admin.from("transactions").update({status:"pending",description:"Provider confirmation pending"}).eq("id",txId);
      return json({error:(e as Error).message,transaction_id:txId,pending:status>=500},status>=500?202:status);
    }
  }catch(e){return json({error:(e as Error).message||"Request failed."},500)}
});
