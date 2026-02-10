/**
 * 飞书 Open API 封装（纯 fetch，不依赖飞书 SDK）
 *
 * 需要的环境变量：
 *   FEISHU_APP_ID          - 飞书应用 App ID
 *   FEISHU_APP_SECRET      - 飞书应用 App Secret
 *   FEISHU_REDIRECT_URI    - OAuth 回调地址
 *   FEISHU_APPROVAL_CODE   - 审批定义 approval_code（创建审批实例时需要，可选）
 */

// ==================== 配置 ====================

const FEISHU_APP_ID = () => (process.env.FEISHU_APP_ID || "").trim();
const FEISHU_APP_SECRET = () => (process.env.FEISHU_APP_SECRET || "").trim();
const FEISHU_REDIRECT_URI = () =>
  (process.env.FEISHU_REDIRECT_URI || "").trim();

const FEISHU_HOST = "https://open.feishu.cn";

// ==================== 判断飞书是否启用 ====================

/**
 * 飞书功能是否可用（App ID 和 App Secret 都配置了才算启用）
 */
export function feishuEnabled() {
  return !!(FEISHU_APP_ID() && FEISHU_APP_SECRET());
}

// ==================== tenant_access_token 缓存 ====================

let _cachedToken = "";
let _tokenExpiresAt = 0; // Unix ms

/**
 * 获取 tenant_access_token（自动缓存，提前 5 分钟刷新）
 * 文档: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 */
export async function getTenantAccessToken() {
  const now = Date.now();
  // 缓存未过期（提前 300s 刷新）
  if (_cachedToken && _tokenExpiresAt - now > 300_000) {
    return _cachedToken;
  }

  const res = await fetch(
    `${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        app_id: FEISHU_APP_ID(),
        app_secret: FEISHU_APP_SECRET(),
      }),
    }
  );

  const json = await res.json();

  if (json.code !== 0) {
    console.error("[Feishu] getTenantAccessToken failed:", json);
    throw new Error(
      `feishu_token_error: ${json.msg || JSON.stringify(json)}`
    );
  }

  _cachedToken = json.tenant_access_token;
  // expire 是秒数，转成绝对毫秒时间戳
  _tokenExpiresAt = now + (json.expire || 7200) * 1000;

  return _cachedToken;
}

// ==================== OAuth 授权 ====================

/**
 * 生成飞书 OAuth 授权页 URL
 * 文档: https://open.feishu.cn/document/common-capabilities/sso/api/get-oauth-code
 * @param {string} state - 防 CSRF 的随机字符串
 */
export function getFeishuAuthUrl(state) {
  const appId = FEISHU_APP_ID();
  const redirectUri = encodeURIComponent(FEISHU_REDIRECT_URI());
  return (
    `${FEISHU_HOST}/open-apis/authen/v1/authorize` +
    `?app_id=${appId}` +
    `&redirect_uri=${redirectUri}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(state || "")}`
  );
}

/**
 * 用 OAuth code 换取用户信息
 * 步骤:
 *   1. code -> user_access_token  (authen/v1/oidc/access_token)
 *   2. user_access_token -> 用户信息 (authen/v1/user_info)
 *
 * 返回: { openId, name, avatarUrl, email, userId }
 */
export async function getFeishuUserByCode(code) {
  // --- 1. 用 app_access_token 兑换 user_access_token ---
  // 先获取 app_access_token（这里复用 tenant_access_token 接口拿到的凭证）
  const tenantToken = await getTenantAccessToken();

  const tokenRes = await fetch(
    `${FEISHU_HOST}/open-apis/authen/v1/oidc/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${tenantToken}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
      }),
    }
  );

  const tokenJson = await tokenRes.json();

  if (tokenJson.code !== 0) {
    console.error("[Feishu] getFeishuUserByCode token exchange failed:", tokenJson);
    throw new Error(
      `feishu_code_exchange_error: ${tokenJson.msg || JSON.stringify(tokenJson)}`
    );
  }

  const userAccessToken = tokenJson.data?.access_token;
  if (!userAccessToken) {
    throw new Error("feishu_code_exchange_error: no access_token in response");
  }

  // --- 2. 用 user_access_token 获取用户信息 ---
  const userRes = await fetch(
    `${FEISHU_HOST}/open-apis/authen/v1/user_info`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
      },
    }
  );

  const userJson = await userRes.json();

  if (userJson.code !== 0) {
    console.error("[Feishu] getFeishuUserByCode user_info failed:", userJson);
    throw new Error(
      `feishu_user_info_error: ${userJson.msg || JSON.stringify(userJson)}`
    );
  }

  const info = userJson.data || {};
  return {
    openId: info.open_id || "",
    unionId: info.union_id || "",
    userId: info.user_id || "",
    name: info.name || info.en_name || "",
    avatarUrl: info.avatar_url || info.avatar_thumb || "",
    email: info.email || info.enterprise_email || "",
  };
}

// ==================== 发送飞书消息 ====================

/**
 * 向指定用户（open_id）发送文本消息
 * 文档: https://open.feishu.cn/document/server-docs/im-v1/message/create
 *
 * @param {string} openId  - 目标用户的 open_id
 * @param {string} content - 消息文本内容（支持飞书富文本 markdown 子集）
 * @returns {object} 飞书 API 响应
 */
export async function sendFeishuMessage(openId, content) {
  if (!openId) {
    console.warn("[Feishu] sendFeishuMessage: openId is empty, skip");
    return null;
  }

  const token = await getTenantAccessToken();

  // 使用 interactive 消息卡片，视觉效果更好
  const cardContent = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "招聘平台通知" },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: content,
      },
    ],
  };

  const res = await fetch(
    `${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=open_id`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify(cardContent),
      }),
    }
  );

  const json = await res.json();

  if (json.code !== 0) {
    console.error("[Feishu] sendFeishuMessage failed:", json);
    // 消息发送失败不中断业务流程，只打日志
  } else {
    console.log("[Feishu] sendFeishuMessage OK -> openId:", openId);
  }

  return json;
}

// ==================== 创建审批实例 ====================

/**
 * 创建飞书审批实例
 * 文档: https://open.feishu.cn/document/server-docs/approval-v4/instance/create
 *
 * @param {string} approvalCode - 审批定义 code（在飞书管理后台创建审批流后获取）
 * @param {string} openId       - 发起人的 open_id
 * @param {Array}  formData     - 审批表单数据，格式:
 *   [{ id: "widget1", type: "input", value: "xxx" }, ...]
 *   具体 id / type 取决于审批定义里的控件配置
 * @returns {object} 飞书 API 响应（含 instance_code）
 */
export async function createApprovalInstance(approvalCode, openId, formData) {
  if (!approvalCode) {
    console.warn("[Feishu] createApprovalInstance: approvalCode is empty, skip");
    return null;
  }
  if (!openId) {
    console.warn("[Feishu] createApprovalInstance: openId is empty, skip");
    return null;
  }

  const token = await getTenantAccessToken();

  const res = await fetch(
    `${FEISHU_HOST}/open-apis/approval/v4/instances`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        approval_code: approvalCode,
        open_id: openId,
        form: JSON.stringify(formData),
      }),
    }
  );

  const json = await res.json();

  if (json.code !== 0) {
    console.error("[Feishu] createApprovalInstance failed:", json);
  } else {
    console.log(
      "[Feishu] createApprovalInstance OK -> instance_code:",
      json.data?.instance_code
    );
  }

  return json;
}
