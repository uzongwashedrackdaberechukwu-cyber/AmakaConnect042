import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const out=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,"content-type":"application/json"}});
Deno.serve(async req=>{if(req.method==="OPTIONS")return new Response("ok",{headers:cors});try{
 const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,auth=req.headers.get("Authorization")||"";
 const c=createClient(url,anon,{global:{headers:{Authorization:auth}}}),a=createClient(url,key); const {data:{user}}=await c.auth.getUser(); if(!user)return out({error:"Unauthorized"},401);
 const {data:role}=await a.from("admin_users").select("user_id").eq("user_id",user.id).maybeSingle(); if(!role)return out({error:"Admin access required"},403);
 const {action,payload={}}=await req.json();
 if(action==="dashboard"){const [u,f,t]=await Promise.all([a.from("profiles").select("id",{count:"exact",head:true}),a.from("funding_requests").select("id",{count:"exact",head:true}).eq("status","pending"),a.from("transactions").select("id",{count:"exact",head:true})]);return out({users:u.count||0,pending_funding:f.count||0,transactions:t.count||0});}
 if(action==="funding"){const {data,error}=await a.from("funding_requests").select("id,user_id,amount,payment_reference,status,created_at,profiles(full_name,phone)").order("created_at",{ascending:false}).limit(100);if(error)throw error;return out(data);}
 if(action==="review_funding"){const {data,error}=await a.rpc("review_funding_request",{p_request_id:payload.id,p_status:payload.status,p_admin_id:user.id});if(error)throw error;return out({ok:true,balance:data});}
 if(action==="transactions"){const {data,error}=await a.from("transactions").select("*").order("created_at",{ascending:false}).limit(100);if(error)throw error;return out(data);}
 if(action==="users"){const {data,error}=await a.from("profiles").select("id,full_name,username,phone,created_at,wallets(balance,currency)").order("created_at",{ascending:false}).limit(100);if(error)throw error;return out(data);}
 return out({error:"Unsupported action"},400);
}catch(e){return out({error:(e as Error).message},500)}});
