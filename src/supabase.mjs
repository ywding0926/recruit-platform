import { createClient } from "@supabase/supabase-js";

function getEnv(name) {
  const v = String(process.env[name] || "").trim();
  return v || null;
}

export const supabaseEnabled = String(process.env.SUPABASE_ENABLED || "").trim() === "1";

export function getBucketName() {
  return String(process.env.SUPABASE_BUCKET || "resumes").trim() || "resumes";
}

export function getSignedUrlExpiresIn() {
  const n = Number(process.env.SUPABASE_SIGNED_URL_EXPIRES || 3600);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

// 缓存实例，避免重复创建
let _anonClient = null;
let _adminClient = null;

/**
 * 浏览器/低权限 client（一般用于前端；后端也能用，但写库可能被 RLS/权限限制）
 */
export function getSupabaseClient() {
  if (_anonClient) return _anonClient;

  const url = getEnv("SUPABASE_URL");
  const anon = getEnv("SUPABASE_ANON_KEY");
  if (!url || !anon) {
    console.warn("[Supabase] Missing SUPABASE_URL or SUPABASE_ANON_KEY, anon client unavailable");
    return null;
  }
  _anonClient = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _anonClient;
}

/**
 * 服务端 admin client（用 service role key，后端写库/写 storage 必须用这个）
 */
export function getSupabaseAdmin() {
  if (_adminClient) return _adminClient;

  const url = getEnv("SUPABASE_URL");
  const service = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !service) {
    console.warn("[Supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY, admin client unavailable");
    return null;
  }
  _adminClient = createClient(url, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _adminClient;
}

// 兼容旧代码 `import { sb } from "./supabase.mjs";`
export const sb = (() => {
  try {
    return getSupabaseClient();
  } catch {
    return null;
  }
})();
