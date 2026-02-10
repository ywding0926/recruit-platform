/**
 * 飞书 (Feishu / Lark) 集成模块
 * - tenant_access_token 获取与缓存（服务端 OpenAPI 调用：IM、通讯录、日历、审批等）
 * - app_access_token 获取与缓存（OAuth / OIDC 换取 user_access_token）
 * - OAuth 登录（OIDC）
 * - 发送消息（卡片）
 * - 创建审批实例
 * - 通讯录同步（部门+员工）
 * - 日历事件（面试日程同步）
 */

const FEISHU_HOST = "https://open.feishu.cn";

/* ---------- 环境变量 ---------- */
const appId = () => process.env.FEISHU_APP_ID || "";
const appSecret = () => process.env.FEISHU_APP_SECRET || "";

export function feishuEnabled() {
  return !!(appId() && appSecret());
}

/* ---------- tenant_access_token（调用多数 OpenAPI） ---------- */
let tenantTokenCache = { token: "", expiresAt: 0 };

export async function getTenantAccessToken() {
  if (tenantTokenCache.token && Date.now() < tenantTokenCache.expiresAt) {
    return tenantTokenCache.token;
  }
  const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId(), app_secret: appSecret() }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error("获取 tenant_access_token 失败: " + data.msg);
  tenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };
  return tenantTokenCache.token;
}

/* ---------- app_access_token（OAuth / OIDC 必须用它） ---------- */
// 关键：authen/v1/oidc/access_token 的 Authorization 需要 app_access_token :contentReference[oaicite:1]{index=1}
let appTokenCache = { token: "", expiresAt: 0 };

export async function getAppAccessToken() {
  if (appTokenCache.token && Date.now() < appTokenCache.expiresAt) {
    return appTokenCache.token;
  }
  const res = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId(), app_secret: appSecret() }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error("获取 app_access_token 失败: " + data.msg);
  appTokenCache = {
    token: data.app_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };
  return appTokenCache.token;
}

/* ---------- OAuth 登录 ---------- */
export function getFeishuAuthUrl(state = "") {
  const redirectUri = encodeURIComponent(process.env.FEISHU_REDIRECT_URI || "");
  // 可选：需要通讯录/日历等授权时，把 scope 也拼上（前提是飞书后台开了权限并配置了范围）
  const scope = (process.env.FEISHU_SCOPE || "").trim();
  const scopePart = scope ? `&scope=${encodeURIComponent(scope)}` : "";
  return `${FEISHU_HOST}/open-apis/authen/v1/authorize?app_id=${appId()}&redirect_uri=${redirectUri}&response_type=code&state=${encodeURIComponent(
    state || ""
  )}${scopePart}`;
}

export async function getFeishuUserByCode(code) {
  // ✅ 关键修正：这里必须用 app_access_token，不是 tenant_access_token :contentReference[oaicite:2]{index=2}
  const token = await getAppAccessToken();
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

  const d = data.data || {};
  return {
    id: d.open_id,
    name: d.name || d.en_name || "飞书用户",
    avatar: d.avatar_url || "",
    openId: d.open_id,
    unionId: d.union_id,
    provider: "feishu",
  };
}

/* ---------- 发送消息（卡片） ---------- */
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

/* ---------- 创建审批实例 ---------- */
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

/* ---------- 通讯录：获取部门列表 ---------- */
export async function getFeishuDepartments(parentId = "0") {
  if (!feishuEnabled()) return [];
  try {
    const token = await getTenantAccessToken();
    const allDepts = [];
    let pageToken = "";
    do {
      const url = `${FEISHU_HOST}/open-apis/contact/v3/departments?parent_department_id=${parentId}&page_size=50${
        pageToken ? "&page_token=" + pageToken : ""
      }`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.code !== 0) {
        console.error("[Feishu] 获取部门失败:", data.msg);
        break;
      }
      const items = data.data?.items || [];
      for (const dept of items) {
        allDepts.push({
          id: dept.department_id,
          name: dept.name,
          parentId: dept.parent_department_id,
          openDepartmentId: dept.open_department_id,
        });
      }
      pageToken = data.data?.has_more ? data.data.page_token : "";
    } while (pageToken);
    return allDepts;
  } catch (e) {
    console.error("[Feishu] 获取部门异常:", e.message);
    return [];
  }
}

/* ---------- 通讯录：获取部门下员工 ---------- */
export async function getFeishuEmployees(departmentId = "0") {
  if (!feishuEnabled()) return [];
  try {
    const token = await getTenantAccessToken();
    const allUsers = [];
    let pageToken = "";
    do {
      const url = `${FEISHU_HOST}/open-apis/contact/v3/users?department_id=${departmentId}&page_size=50${
        pageToken ? "&page_token=" + pageToken : ""
      }`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.code !== 0) {
        console.error("[Feishu] 获取员工失败:", data.msg);
        break;
      }
      const items = data.data?.items || [];
      for (const u of items) {
        allUsers.push({
          openId: u.open_id,
          unionId: u.union_id || "",
          name: u.name || "",
          enName: u.en_name || "",
          avatar: u.avatar?.avatar_origin || u.avatar?.avatar_240 || "",
          department: departmentId,
          jobTitle: u.job_title || "",
          mobile: u.mobile || "",
          email: u.email || "",
        });
      }
      pageToken = data.data?.has_more ? data.data.page_token : "";
    } while (pageToken);
    return allUsers;
  } catch (e) {
    console.error("[Feishu] 获取员工异常:", e.message);
    return [];
  }
}

/* ---------- 通讯录：递归获取所有员工 ---------- */
export async function getAllFeishuEmployees() {
  if (!feishuEnabled()) return [];
  try {
    const depts = await getFeishuDepartments("0");
    const deptIds = ["0", ...depts.map((d) => d.id)];
    const allUsers = [];
    const seenIds = new Set();
    for (const deptId of deptIds) {
      const users = await getFeishuEmployees(deptId);
      for (const u of users) {
        if (!seenIds.has(u.openId)) {
          seenIds.add(u.openId);
          allUsers.push(u);
        }
      }
    }
    return allUsers;
  } catch (e) {
    console.error("[Feishu] 获取所有员工异常:", e.message);
    return [];
  }
}

/* ---------- 日历：创建面试日程 ---------- */
export async function createFeishuCalendarEvent({
  summary,
  description,
  startTime,
  endTime,
  attendeeOpenIds = [],
}) {
  if (!feishuEnabled()) return null;
  try {
    const token = await getTenantAccessToken();

    // 1) 获取主日历 ID
    const calRes = await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars/primary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const calData = await calRes.json();
    let calendarId = "primary";
    if (calData.code === 0 && calData.data?.calendars?.[0]?.calendar?.calendar_id) {
      calendarId = calData.data.calendars[0].calendar.calendar_id;
    }

    // 2) 创建事件
    const eventBody = {
      summary,
      description: description || "",
      start_time: { timestamp: String(Math.floor(new Date(startTime).getTime() / 1000)) },
      end_time: { timestamp: String(Math.floor(new Date(endTime).getTime() / 1000)) },
    };

    const eventRes = await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars/${calendarId}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(eventBody),
    });
    const eventData = await eventRes.json();
    if (eventData.code !== 0) {
      console.error("[Feishu] 创建日历事件失败:", eventData.msg);
      return eventData;
    }

    const eventId = eventData.data?.event?.event_id;

    // 3) 添加参与人
    if (eventId && attendeeOpenIds.length > 0) {
      const attendees = attendeeOpenIds.map((id) => ({ type: "user", user_id: id, is_optional: false }));
      await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ attendees, need_notification: true }),
      });
    }

    return eventData;
  } catch (e) {
    console.error("[Feishu] 创建日历事件异常:", e.message);
    return null;
  }
}
