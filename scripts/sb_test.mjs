console.log("URL =", process.env.SUPABASE_URL);
console.log("KEY head =", (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").slice(0, 20));

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or KEY");
  process.exit(1);
}
console.log("URL =", process.env.SUPABASE_URL);
console.log("KEY head =", (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").slice(0, 20));

const sb = createClient(url, key, { auth: { persistSession: false } });

const row = {
  id: "test_" + Date.now(),
  name: "测试候选人",
  phone: "13800000000",
  status: "待筛选",
  source: "手动录入",
};

const { data, error } = await sb.from("candidates").insert(row).select();

console.log("insert result:", { data, error });

