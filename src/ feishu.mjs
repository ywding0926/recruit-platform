/**
 * 飞书 (Feishu / Lark) 集成模块
 */

const FEISHU_HOST = "https://open.feishu.cn";

const appId     = () => process.env.FEISHU_APP_ID || "";
const appSecret = () => process.env.FEISHU_APP_SECRET || "";

export function feishuEnabled() {
  return !!(appId() && appSecret());
}

let tokenCache = { token: "", expiresAt: 0 };

export async function getTenantAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId(), app_secret: appSecret() }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error("获取 tenant_access_token 失败: " + data.msg);
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };
  return tokenCache.token;
}

export function getFeishuAuthUrl(state = "") {
  const redirectUri = encodeURIComponent(process.env.FEISHU_REDIRECT_URI || "");
  return `${FEISHU_HOST}/open-apis/authen/v1/authorize?app_id=${appId()}&redirect_uri=${redirectUri}&response_type=code&state=${state}`;
}

export async function getFeishuUserByCode(code) {
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_HOST}/open-apis/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error("飞书 OAuth 换 token 失败: " + data.msg);
  const d = data.data;
  return {
    id: d.open_id,
    name: d.name || d.en_name || "飞书用户",
    avatar: d.avatar_url || "",
    openId: d.open_id,
    unionId: d.union_id,
    provider: "feishu",
  };
}

export async function sendFeishuMessage(openId, content, title = "招聘平台通知") {
  if (!feishuEnabled() || !openId) return null;
  try {
    const token = await getTenantAccessToken();
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: title }, template: "blue" },
      elements: [{ tag: "markdown", content }],
    };
    const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    });
    const data = await res.json();
    if (data.code !== 0) console.error("[Feishu] 发送消息失败:", data.msg);
    return data;
  } catch (e) {
    console.error("[Feishu] 发送消息异常:", e.message);
    return null;
  }
}

export async function createApprovalInstance(approvalCode, openId, formData) {
  if (!feishuEnabled() || !approvalCode) return null;
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(`${FEISHU_HOST}/open-apis/approval/v4/instances`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        approval_code: approvalCode,
        open_id: openId,
        form: JSON.stringify(formData),
      }),
    });
    const data = await res.json();
    if (data.code !== 0) console.error("[Feishu] 创建审批失败:", data.msg);
    return data;
  } catch (e) {
    console.error("[Feishu] 创建审批异常:", e.message);
    return null;
  }
}