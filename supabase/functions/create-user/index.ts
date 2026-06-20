// supabase/functions/create-user/index.ts
//
// Creates a new user account on behalf of an admin.
// The service role key lives ONLY here, on the server — never in the browser.
//
// Security flow:
//   1. Read the caller's own auth token from the Authorization header
//   2. Look up that caller's profile and confirm role = 'admin'
//   3. Only if they're an admin, use the service role key to create the new user
//   4. Insert a matching row into user_profiles with the requested role/settlement

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

 Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Client using the CALLER's token — to verify who is asking
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerData?.user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin client — full privileges, used only after the admin check below
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Confirm the caller is actually an admin
    const { data: callerProfile, error: profileErr } = await adminClient
      .from("user_profiles")
      .select("role")
      .eq("id", callerData.user.id)
      .single();

    if (profileErr || callerProfile?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Admin access only" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse the new user's details from the request body
    const { name, email, password, role, settlement } = await req.json();

    if (!name || !email || !password) {
      return new Response(JSON.stringify({ error: "Name, email and password are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const allowedRoles = ["officer", "coordinator", "admin"];
    const finalRole = allowedRoles.includes(role) ? role : "officer";

    // Create the auth user — auto-confirmed, no email verification needed
    const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name },
    });

    if (createErr) {
      return new Response(JSON.stringify({ error: createErr.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Insert / upsert their profile row
    const { error: upsertErr } = await adminClient.from("user_profiles").upsert(
      {
        id: newUser.user.id,
        full_name: name,
        email,
        role: finalRole,
        settlement: settlement || null,
      },
      { onConflict: "id" }
    );

    if (upsertErr) {
      return new Response(JSON.stringify({ error: "User created but profile failed: " + upsertErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ success: true, user_id: newUser.user.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});