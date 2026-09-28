const c=window.STORE_CONFIG||{};
let sb;

const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>"']/g,x=>({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[x]));

const money=n=>`₦${Number(n||0).toLocaleString("en-NG",{
  minimumFractionDigits:2,
  maximumFractionDigits:2
})}`;

async function api(action,payload={}){
  const {data:{session}}=await sb.auth.getSession();

  if(!session) throw new Error("Please sign in again.");

  const r=await fetch("/api/backend",{
    method:"POST",
    headers:{
      Authorization:`Bearer ${session.access_token}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      action:"admin",
      payload:{action,payload}
    })
  });

  const data=await r.json();

  if(!r.ok){
    throw new Error(data.error||data.message||"Request failed");
  }

  return data;
}

async function login(){
  $("msg").textContent="Signing in…";

  const email=$("email").value.trim();
  const password=$("password").value;

  if(!email||!password){
    $("msg").textContent="Enter your admin email and password.";
    return;
  }

  const {error}=await sb.auth.signInWithPassword({email,password});

  if(error){
    $("msg").textContent=error.message;
    return;
  }

  try{
    await loadAll();
    $("msg").textContent="";
    $("panel").classList.remove("hidden");
    document.querySelector(".adminlogin").classList.add("hidden");
  }catch(e){
    await sb.auth.signOut();
    $("msg").textContent=e.message;
  }
}

async function loadAll(){
  const [dash,funds,txs]=await Promise.all([
    api("dashboard"),
    api("funding"),
    api("transactions")
  ]);

  $("users").textContent=dash.users||0;
  $("pending").textContent=dash.pending||0;
  $("txs").textContent=dash.transactions||0;

  $("funds").innerHTML=funds?.length
    ? funds.map(f=>`
      <div class="listitem">
        <div>
          <b>${money(f.amount)}</b>
          <small>${esc(f.payment_reference||"No bank reference")}</small>
          <small>${new Date(f.created_at).toLocaleString()}</small>
        </div>
        <div>
          <small class="status ${esc(f.status)}">${esc(f.status)}</small>
          ${f.status==="pending" ? `
            <div style="display:flex;gap:6px;margin-top:8px">
              <button onclick="reviewFunding('${esc(f.id)}','approved')">Approve</button>
              <button onclick="reviewFunding('${esc(f.id)}','rejected')">Reject</button>
            </div>
          ` : ""}
        </div>
      </div>
    `).join("")
    : '<span class="muted">No funding requests.</span>';

  $("adminTx").innerHTML=txs?.length
    ? txs.map(t=>`
      <div class="listitem">
        <div>
          <b>${esc(t.description||t.type)}</b>
          <small>${new Date(t.created_at).toLocaleString()}</small>
        </div>
        <div>
          <b>${money(t.amount)}</b>
          <small class="status ${esc(t.status)}">${esc(t.status)}</small>
        </div>
      </div>
    `).join("")
    : '<span class="muted">No transactions yet.</span>';
}

async function reviewFunding(id,status){
  const word=status==="approved"?"approve":"reject";

  if(!confirm(`Are you sure you want to ${word} this funding request?`)){
    return;
  }

  try{
    await api("review_funding",{
      request_id:id,
      status
    });

    await loadAll();
  }catch(e){
    alert(e.message);
  }
}

(async()=>{
  if(!c.supabaseUrl||!c.supabaseAnonKey){
    $("msg").textContent="Supabase configuration is missing.";
    return;
  }

  sb=window.supabase.createClient(c.supabaseUrl,c.supabaseAnonKey);

  const {data:{session}}=await sb.auth.getSession();

  if(session){
    try{
      await loadAll();
      $("panel").classList.remove("hidden");
      document.querySelector(".adminlogin").classList.add("hidden");
    }catch{
      await sb.auth.signOut();
    }
  }
})();
