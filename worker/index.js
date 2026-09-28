const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const cleanBase = value => String(value || "").replace(/\/+$/, "");

async function getUser(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;

  const r = await fetch(`${cleanBase(env.SUPABASE_URL)}/auth/v1/user`, {
    headers: {
      authorization: auth,
      apikey: env.SUPABASE_ANON_KEY
    }
  });

  if (!r.ok) return null;
  return await r.json();
}

async function supabase(env, path, options = {}) {
  const r = await fetch(`${cleanBase(env.SUPABASE_URL)}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(options.headers || {})
    }
  });

  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = text; }

  if (!r.ok) {
    throw new Error(body?.message || body?.error || `Database request failed (${r.status})`);
  }

  return body;
}

async function rpc(env, name, body) {
  return supabase(env, `rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function shadex(env, path, options = {}) {
  if (!env.SHADEX_API_BASE_URL || !env.SHADEX_API_KEY) {
    throw new Error("Service provider connection is not configured.");
  }

  const r = await fetch(`${cleanBase(env.SHADEX_API_BASE_URL)}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${env.SHADEX_API_KEY}`,
      ...(options.headers || {})
    }
  });

  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { message: text }; }

  if (!r.ok || body?.success === false) {
    const e = new Error(
      body?.error?.message ||
      body?.message ||
      "Service request failed."
    );
    e.status = r.status;
    e.body = body;
    throw e;
  }

  return body?.data ?? body;
}

async function requireAdmin(user, env) {
  const rows = await supabase(
    env,
    `admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function handleCatalogue(env) {
  const data = await shadex(env, "/api/v1/vtu/products");
  return json(data);
}

async function handleBillsCatalogue(env) {
  const data = await shadex(env, "/api/v1/bills/products");
  return json(data);
}

async function handleBillVerify(env, payload) {
  const data = await shadex(env, "/api/v1/bills/verify", {
    method: "POST",
    body: JSON.stringify(payload || {})
  });
  return json(data);
}

async function handlePurchase(user, env, payload) {
  const type = payload?.service_type;

  if (!["data", "airtime"].includes(type)) {
    return json({ error: "Unsupported service type." }, 400);
  }

  const amount = Number(payload?.customer_amount || payload?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "Invalid transaction amount." }, 400);
  }

  const key = String(payload?.idempotency_key || "");
  if (key.length < 8) {
    return json({ error: "Invalid transaction reference." }, 400);
  }

  let reservation;

  try {
    reservation = await rpc(env, "reserve_vtu_purchase", {
      p_user_id: user.id,
      p_type: type,
      p_amount: amount,
      p_reference: key,
      p_description:
        type === "data"
          ? `Data purchase - ${payload.phone_number || ""}`
          : `Airtime purchase - ${payload.phone_number || ""}`
    });
  } catch (e) {
    return json({ error: e.message }, 400);
  }

  const transactionId =
    Array.isArray(reservation)
      ? reservation[0]?.transaction_id || reservation[0]?.id
      : reservation?.transaction_id || reservation?.id || reservation;

  const upstreamBody = {
    service_type: type,
    network_id: payload.network_id,
    phone_number: payload.phone_number
  };

  if (type === "data") {
    upstreamBody.data_plan_id = payload.data_plan_id;
  } else {
    upstreamBody.amount = payload.amount;
  }

  try {
    const result = await shadex(env, "/api/v1/vtu/orders", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(upstreamBody)
    });

    await rpc(env, "complete_vtu_purchase", {
      p_transaction_id: transactionId,
      p_provider_reference:
        result?.order_id || result?.id || result?.reference || null
    });

    return json({
      success: true,
      message: type === "data"
        ? "Data order submitted successfully."
        : "Airtime order submitted successfully.",
      data: result
    });
  } catch (e) {
    const status = Number(e.status || 500);

    if (status >= 400 && status < 500) {
      try {
        await rpc(env, "refund_vtu_purchase", {
          p_transaction_id: transactionId,
          p_reason: e.message
        });
      } catch {}

      return json({ error: e.message }, status);
    }

    return json({
      error: "The provider response is still being confirmed. Your transaction has not been automatically refunded."
    }, 503);
  }
}

async function handleAdmin(user, env, action, payload) {
  if (!(await requireAdmin(user, env))) {
    return json({ error: "Administrator access required." }, 403);
  }

  if (action === "dashboard") {
    const [profiles, funding, transactions] = await Promise.all([
      supabase(env, "profiles?select=id"),
      supabase(env, "funding_requests?status=eq.pending&select=id"),
      supabase(env, "transactions?select=id")
    ]);

    return json({
      users: profiles?.length || 0,
      pending: funding?.length || 0,
      transactions: transactions?.length || 0
    });
  }

  if (action === "funding") {
    return json(await supabase(
      env,
      "funding_requests?select=*&order=created_at.desc&limit=100"
    ));
  }

  if (action === "transactions") {
    return json(await supabase(
      env,
      "transactions?select=*&order=created_at.desc&limit=100"
    ));
  }

  if (action === "users") {
    return json(await supabase(
      env,
      "profiles?select=*&order=created_at.desc&limit=100"
    ));
  }

  if (action === "review_funding") {
    const data = await rpc(env, "review_funding_request", {
      p_request_id: payload?.request_id,
      p_status: payload?.status
    });
    return json(data);
  }

  return json({ error: "Unsupported admin action." }, 400);
}

async function api(request, env) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const user = await getUser(request, env);
  if (!user?.id) return json({ error: "Please sign in again." }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid request." }, 400); }

  try {
    if (body.action === "catalogue") return handleCatalogue(env);
    if (body.action === "bills_catalogue") return handleBillsCatalogue(env);
    if (body.action === "bill_verify") return handleBillVerify(env, body.payload);
    if (body.action === "purchase") return handlePurchase(user, env, body.payload);

    if (body.action === "admin") {
      return handleAdmin(
        user,
        env,
        body.payload?.action,
        body.payload?.payload || {}
      );
    }

    return json({ error: "Unsupported action." }, 400);
  } catch (e) {
    return json({ error: e.message || "Request failed." }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/backend") {
      return api(request, env);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  }
};
