/**
 * 飞书 (Feishu / Lark) 集成模块
 * - tenant_access_token 获取与缓存
 * - OAuth 登录（OIDC）
 * - 发送消息（卡片）
 * - 创建审批实例
 * - 通讯录同步（部门+员工）
 * - 日历事件（面试日程同步）
 */

const FEISHU_HOST = "https://open.feishu.cn";

/* ---------- 环境变量 ---------- */
const appId     = () => process.env.FEISHU_APP_ID || "";
const appSecret = () => process.env.FEISHU_APP_SECRET || "";

export function feishuEnabled() {
  return !!(appId() && appSecret());
}

/* ---------- tenant_access_token ---------- */
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

/* ---------- OAuth 登录 ---------- */
export function getFeishuAuthUrl(state = "") {
  const redirectUri = encodeURIComponent(process.env.FEISHU_REDIRECT_URI || "");
  return `${FEISHU_HOST}/open-apis/authen/v1/authorize?app_id=${appId()}&redirect_uri=${redirectUri}&response_type=code&state=${state}`;
}

export async function getFeishuUserByCode(code) {
  const token = await getTenantAccessToken();

  // 1. 用 code 换 user_access_token
  const res = await fetch(`${FEISHU_HOST}/open-apis/authen/v1/oidc/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const data = await res.json();
  console.log("[Feishu OIDC] access_token response keys:", JSON.stringify(Object.keys(data.data || {})));
  if (data.code !== 0) throw new Error("飞书 OAuth 换 token 失败: " + data.msg);

  const tokenData = data.data;
  const userAccessToken = tokenData.access_token;

  // access_token 接口可能只返回 token，不含用户信息
  let openId = tokenData.open_id;
  let unionId = tokenData.union_id;
  let name = tokenData.name || tokenData.en_name;
  let avatar = tokenData.avatar_url || tokenData.avatar_thumb || "";

  // 2. 如果缺少 openId 或 name，调 userinfo 接口补全
  if (!openId || !name) {
    console.log("[Feishu OIDC] access_token 缺少用户信息，调用 userinfo");
    const uiRes = await fetch(`${FEISHU_HOST}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    const uiData = await uiRes.json();
    console.log("[Feishu OIDC] userinfo:", JSON.stringify({ code: uiData.code, open_id: uiData.data?.open_id, name: uiData.data?.name }));
    if (uiData.code === 0 && uiData.data) {
      openId = uiData.data.open_id || openId;
      unionId = uiData.data.union_id || unionId;
      name = uiData.data.name || uiData.data.en_name || name;
      avatar = uiData.data.avatar_url || uiData.data.avatar_thumb || avatar;
    }
  }

  console.log("[Feishu OIDC] final: openId=", openId, "name=", name);
  return {
    id: openId,
    name: name || "飞书用户",
    avatar: avatar || "",
    openId: openId,
    unionId: unionId,
    provider: "feishu",
  };
}

/* ---------- 发送消息（卡片） ---------- */
export async function sendFeishuMessage(openId, content, title = "招聘平台通知", extraElements = []) {
  if (!feishuEnabled() || !openId) return null;
  try {
    const token = await getTenantAccessToken();
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: title }, template: "blue" },
      elements: [{ tag: "markdown", content }, ...extraElements],
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

/* ---------- 获取机器人加入的群列表 ---------- */
export async function getFeishuBotChats() {
  if (!feishuEnabled()) return [];
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/chats?user_id_type=open_id&page_size=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.error("[Feishu] 获取群列表失败:", data.msg);
      return [];
    }
    return (data.data?.items || []).map(c => ({ chatId: c.chat_id, name: c.name, memberCount: c.member_count }));
  } catch (e) {
    console.error("[Feishu] 获取群列表异常:", e.message);
    return [];
  }
}

/* ---------- 发送群聊消息（卡片） ---------- */
export async function sendFeishuGroupMessage(chatId, content, title = "招聘平台通知", extraElements = []) {
  if (!feishuEnabled() || !chatId) return null;
  try {
    const token = await getTenantAccessToken();
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: title }, template: "blue" },
      elements: [{ tag: "markdown", content }, ...extraElements],
    };
    const res = await fetch(`${FEISHU_HOST}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    });
    const data = await res.json();
    if (data.code !== 0) console.error("[Feishu] 发送群消息失败:", data.msg, "chatId:", chatId);
    return data;
  } catch (e) {
    console.error("[Feishu] 发送群消息异常:", e.message);
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
      const url = `${FEISHU_HOST}/open-apis/contact/v3/departments?parent_department_id=${parentId}&page_size=50${pageToken ? "&page_token=" + pageToken : ""}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.code !== 0) { console.error("[Feishu] 获取部门失败:", data.msg); break; }
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
      const url = `${FEISHU_HOST}/open-apis/contact/v3/users?department_id=${departmentId}&page_size=50${pageToken ? "&page_token=" + pageToken : ""}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.code !== 0) { console.error("[Feishu] 获取员工失败:", data.msg); break; }
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
    const deptIds = ["0", ...depts.map(d => d.id)];
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

/* ---------- 通讯录：按关键词搜索用户 ---------- */
export async function searchFeishuUsers(query) {
  if (!feishuEnabled() || !query) return [];
  try {
    const token = await getTenantAccessToken();
    const res = await fetch(`${FEISHU_HOST}/open-apis/search/v1/user?query=${encodeURIComponent(query)}&page_size=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.error("[Feishu] 搜索用户失败:", data.msg, data.code);
      // 搜索API不可用时，回退到全量获取+本地过滤
      return null;
    }
    const items = data.data?.users || [];
    return items.map(u => ({
      openId: u.open_id || "",
      name: u.name || "",
      avatar: u.avatar?.avatar_origin || u.avatar?.avatar_240 || "",
      department: u.department_name || "",
      jobTitle: u.job_title || "",
    }));
  } catch (e) {
    console.error("[Feishu] 搜索用户异常:", e.message);
    return null;
  }
}

/* ---------- 任务：创建飞书任务（提醒面试官填面评） ---------- */
export async function createFeishuTask({ title, description = "", assigneeOpenId, followerOpenIds = [], dueTimestamp = 0 }) {
  if (!feishuEnabled()) return null;
  try {
    const token = await getTenantAccessToken();
    // dueTimestamp 统一为毫秒级时间戳；飞书 v2 API due.timestamp 为毫秒级字符串
    const dueMs = dueTimestamp > 9999999999 ? dueTimestamp : dueTimestamp * 1000;
    // 使用飞书任务 v2 API
    const body = {
      summary: title,
      description: description || undefined,
      due: dueMs ? { timestamp: String(dueMs), is_all_day: false } : undefined,
      members: [
        // 负责人（面试官）
        { id: assigneeOpenId, type: "user", role: "assignee" },
        // 关注人（HR）
        ...followerOpenIds.map(id => ({ id, type: "user", role: "follower" })),
      ],
    };
    console.log("[Feishu Task] 创建任务:", title, "assignee:", assigneeOpenId, "followers:", followerOpenIds.length);
    const res = await fetch(`${FEISHU_HOST}/open-apis/task/v2/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.error("[Feishu Task] 创建失败:", data.code, data.msg);
      // 如果 v2 不可用，尝试 v1 API
      return await createFeishuTaskV1({ title, description, assigneeOpenId, followerOpenIds, dueTimestamp, token });
    }
    const taskId = data.data?.task?.id || data.data?.task?.guid || data.data?.task?.task_id || "";
    console.log("[Feishu Task] 创建成功, taskId:", taskId, "resp:", JSON.stringify(data.data).slice(0, 200));
    return { code: 0, taskId };
  } catch (e) {
    console.error("[Feishu Task] 异常:", e.message);
    return null;
  }
}

async function createFeishuTaskV1({ title, description, assigneeOpenId, followerOpenIds, dueTimestamp, token }) {
  try {
    // v1 API 的 due.timestamp 也是秒级字符串
    const dueSec = dueTimestamp > 9999999999 ? Math.round(dueTimestamp / 1000) : dueTimestamp;
    const body = {
      summary: title,
      description: description || undefined,
      extra: assigneeOpenId,
      due: dueSec ? { timestamp: String(dueSec), is_all_day: false } : undefined,
      origin: { platform_i18n_name: '{"zh_cn": "招聘系统"}' },
      can_edit: true,
      collaborator_ids: followerOpenIds,
    };
    const res = await fetch(`${FEISHU_HOST}/open-apis/task/v1/tasks?user_id_type=open_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.error("[Feishu Task v1] 创建失败:", data.code, data.msg);
      return null;
    }
    console.log("[Feishu Task v1] 创建成功, taskId:", data.data?.task?.id);
    return { code: 0, taskId: data.data?.task?.id };
  } catch (e) {
    console.error("[Feishu Task v1] 异常:", e.message);
    return null;
  }
}

/* ---------- 日历：创建面试日程（含飞书会议） ---------- */
/**
 * 上传文件到飞书云空间（日历素材），返回 file_token
 * @param {string} fileUrl - 文件下载地址（Supabase signed URL 或本地 /uploads/...）
 * @param {string} fileName - 原始文件名（如 resume.pdf）
 * @param {string} calendarId - 飞书日历 ID（parent_node）
 * @returns {string|null} file_token 或 null（失败时）
 */
export async function uploadResumeToFeishu(fileUrl, fileName, calendarId) {
  if (!feishuEnabled() || !fileUrl || !calendarId) return null;
  try {
    const token = await getTenantAccessToken();

    // 下载文件内容
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) {
      console.warn("[FeishuUpload] 下载简历失败:", fileRes.status, fileUrl);
      return null;
    }
    const fileBuffer = await fileRes.arrayBuffer();
    const fileSize = fileBuffer.byteLength;
    if (fileSize === 0) {
      console.warn("[FeishuUpload] 简历文件为空");
      return null;
    }
    // 飞书限制附件总大小 25MB
    if (fileSize > 25 * 1024 * 1024) {
      console.warn("[FeishuUpload] 简历超过25MB限制，跳过附件上传");
      return null;
    }

    // 构造 multipart/form-data 上传
    const formData = new FormData();
    formData.append("file_name", fileName || "resume.pdf");
    formData.append("parent_type", "calendar");
    formData.append("parent_node", calendarId);
    formData.append("size", String(fileSize));
    formData.append("file", new Blob([fileBuffer]), fileName || "resume.pdf");

    const uploadRes = await fetch(`${FEISHU_HOST}/open-apis/drive/v1/medias/upload_all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const uploadData = await uploadRes.json();
    if (uploadData.code !== 0) {
      console.warn("[FeishuUpload] 上传素材失败:", uploadData.code, uploadData.msg);
      return null;
    }
    const fileToken = uploadData.data?.file_token;
    console.log("[FeishuUpload] 上传成功, file_token:", fileToken);
    return fileToken || null;
  } catch (e) {
    console.warn("[FeishuUpload] 上传异常:", e.message);
    return null;
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.summary
 * @param {string} opts.description
 * @param {string} opts.startTime
 * @param {string} opts.endTime
 * @param {string[]} opts.attendeeOpenIds
 * @param {{ url: string, name: string }[]} [opts.resumeAttachments] - 简历附件列表，自动上传
 */
export async function createFeishuCalendarEvent({ summary, description, startTime, endTime, attendeeOpenIds = [], resumeAttachments = [], hostOpenId = "" }) {
  if (!feishuEnabled()) {
    console.log("[Feishu Calendar] 跳过：feishu 未启用");
    return null;
  }
  try {
    const token = await getTenantAccessToken();
    console.log("[Feishu Calendar] token:", token ? "OK(" + token.slice(0, 8) + "...)" : "空");

    // 1. 获取应用主日历 ID
    let calendarId = null;

    // 先尝试 primary 接口
    const calRes = await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars/primary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const calData = await calRes.json();
    console.log("[Feishu Calendar] primary response:", JSON.stringify({ code: calData.code, msg: calData.msg }));

    if (calData.code === 0 && calData.data) {
      // 兼容多种返回格式
      calendarId = calData.data.calendars?.[0]?.calendar?.calendar_id
        || calData.data.calendar_id
        || calData.data.calendar?.calendar_id
        || null;
    }

    // primary 失败则用日历列表
    if (!calendarId) {
      console.log("[Feishu Calendar] primary 无法获取，尝试列表接口");
      const listRes = await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars?page_size=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listData = await listRes.json();
      const cals = listData.data?.calendar_list || [];
      console.log("[Feishu Calendar] 日历列表:", cals.length, "个, roles:", cals.map(c => c.role).join(","));
      const writable = cals.find(c => c.role === "owner") || cals.find(c => c.role === "writer") || cals[0];
      if (writable) calendarId = writable.calendar_id;
    }

    if (!calendarId) {
      console.error("[Feishu Calendar] 无法获取可用日历 ID，跳过");
      return null;
    }
    console.log("[Feishu Calendar] 使用 calendarId:", calendarId);

    // 2. 上传简历附件（如果有）
    const attachmentFileTokens = [];
    for (const att of resumeAttachments) {
      if (!att.url || !att.name) continue;
      try {
        const fileToken = await uploadResumeToFeishu(att.url, att.name, calendarId);
        if (fileToken) attachmentFileTokens.push(fileToken);
      } catch (attErr) {
        console.warn("[FeishuUpload] 附件上传失败，跳过:", attErr.message);
      }
    }
    if (attachmentFileTokens.length > 0) {
      console.log("[Feishu Calendar] 成功上传简历附件:", attachmentFileTokens.length, "个");
    }

    // 3. 创建事件（含飞书视频会议）
    const startTs = String(Math.floor(new Date(startTime).getTime() / 1000));
    const endTs = String(Math.floor(new Date(endTime).getTime() / 1000));
    console.log("[Feishu Calendar] 创建事件:", summary, "start:", startTs, "end:", endTs, "attendees:", attendeeOpenIds.length);

    const eventBody = {
      summary,
      description: description || "",
      start_time: { timestamp: startTs },
      end_time: { timestamp: endTs },
      attendee_ability: "can_modify_event",
      need_notification: true,
      // 自动创建飞书视频会议
      // Bot 身份不支持 assign_hosts，需设 allow_attendees_start: true
      vchat: {
        vc_type: "vc",
        meeting_settings: {
          allow_attendees_start: true,
        },
      },
      // 附件（简历）
      ...(attachmentFileTokens.length > 0 ? { attachments: attachmentFileTokens.map(ft => ({ file_token: ft })) } : {}),
    };

    const eventRes = await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars/${calendarId}/events?user_id_type=open_id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(eventBody),
    });
    const eventData = await eventRes.json();
    const event = eventData.data?.event;
    const meetingUrl = event?.vchat?.meeting_url || "";
    console.log("[Feishu Calendar] 创建事件结果:", JSON.stringify({ code: eventData.code, msg: eventData.msg, eventId: event?.event_id, meetingUrl }));
    if (eventData.code !== 0) {
      console.error("[Feishu] 创建日历事件失败:", eventData.msg, JSON.stringify(eventData));
      return { code: eventData.code, msg: eventData.msg, meetingUrl: "" };
    }

    const eventId = event?.event_id;

    // 3. 添加参与人（使用 open_id 类型）— 这会同步到每个人的个人日历
    if (eventId && attendeeOpenIds.length > 0) {
      const attendees = attendeeOpenIds.map(id => ({ type: "user", user_id: id, is_optional: false }));
      console.log("[Feishu Calendar] 添加参与人:", attendeeOpenIds.length, "人");
      const attRes = await fetch(`${FEISHU_HOST}/open-apis/calendar/v4/calendars/${calendarId}/events/${eventId}/attendees?user_id_type=open_id`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ attendees, need_notification: true }),
      });
      const attData = await attRes.json();
      console.log("[Feishu Calendar] 添加参与人结果:", JSON.stringify({ code: attData.code, msg: attData.msg }));
      if (attData.code !== 0) {
        console.error("[Feishu] 添加日历参与人失败:", attData.msg, JSON.stringify(attData));
      } else {
        console.log("[Feishu Calendar] 添加参与人成功:", attendeeOpenIds.length, "人");
      }
    }

    return { code: 0, eventId, calendarId, meetingUrl, data: eventData.data };
  } catch (e) {
    console.error("[Feishu] 创建日历事件异常:", e.message, e.stack);
    return null;
  }
}

/* ---------- VC：从会议链接获取录制/妙记链接 ---------- */
/**
 * 根据飞书会议 URL 获取会议录制链接
 * meetingUrl 格式: https://vc.feishu.cn/j/935314044
 * 返回 { recordingUrl, meetingId, meetingNo } 或 null
 */
export async function getFeishuMeetingRecording(meetingUrl) {
  if (!feishuEnabled() || !meetingUrl) return null;
  try {
    const token = await getTenantAccessToken();
    // 从 URL 提取 9 位会议号
    const match = meetingUrl.match(/\/j\/(\d+)/);
    if (!match) {
      console.log("[Feishu VC] 无法从 URL 提取会议号:", meetingUrl);
      return null;
    }
    const meetingNo = match[1];
    console.log("[Feishu VC] 会议号:", meetingNo);

    // 1. 用 meeting_no 查找 meeting_id
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 90 * 86400; // 往前查 90 天
    const listRes = await fetch(
      `${FEISHU_HOST}/open-apis/vc/v1/meetings/list_by_no?meeting_no=${meetingNo}&start_time=${startSec}&end_time=${nowSec}&page_size=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listData = await listRes.json();
    console.log("[Feishu VC] list_by_no result:", JSON.stringify({ code: listData.code, msg: listData.msg, count: listData.data?.meeting_briefs?.length }));
    if (listData.code !== 0 || !listData.data?.meeting_briefs?.length) {
      return { meetingNo, meetingId: "", recordingUrl: "" };
    }
    const meetingId = listData.data.meeting_briefs[0].id;
    console.log("[Feishu VC] meeting_id:", meetingId);

    // 2. 获取录制文件
    const recRes = await fetch(
      `${FEISHU_HOST}/open-apis/vc/v1/meetings/${meetingId}/recording`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const recData = await recRes.json();
    console.log("[Feishu VC] recording result:", JSON.stringify({ code: recData.code, msg: recData.msg }));
    const recordingUrl = recData.data?.recording?.url || "";

    return { meetingNo, meetingId, recordingUrl };
  } catch (e) {
    console.error("[Feishu VC] 获取会议录制异常:", e.message);
    return null;
  }
}
