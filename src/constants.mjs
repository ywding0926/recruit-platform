// ====== 常量 ======
export const STATUS_COLS = [
  { key: "待筛选", name: "待筛选" },
  { key: "简历初筛", name: "简历初筛" },
  { key: "待一面", name: "待一面" },
  { key: "一面通过", name: "一面通过" },
  { key: "一面不通过", name: "一面不通过" },
  { key: "待二面", name: "待二面" },
  { key: "二面通过", name: "二面通过" },
  { key: "二面不通过", name: "二面不通过" },
  { key: "待三面", name: "待三面" },
  { key: "三面通过", name: "三面通过" },
  { key: "三面不通过", name: "三面不通过" },
  { key: "待四面", name: "待四面" },
  { key: "四面通过", name: "四面通过" },
  { key: "四面不通过", name: "四面不通过" },
  { key: "待五面", name: "待五面" },
  { key: "五面通过", name: "五面通过" },
  { key: "五面不通过", name: "五面不通过" },
  { key: "待发offer", name: "待发offer" },
  { key: "Offer发放", name: "Offer发放" },
  { key: "拒offer", name: "拒offer" },
  { key: "入职", name: "入职" },
  { key: "面试不通过", name: "面试不通过" },
  { key: "面试Pending", name: "面试Pending" },
  { key: "淘汰", name: "淘汰" },
];

export const STATUS_SET = new Set(STATUS_COLS.map((x) => x.key));
export const STATUS_KEYS = STATUS_COLS.map((x) => x.key);

export const INTERVIEW_ROUNDS = [1, 2, 3, 4, 5];
export const INTERVIEW_RATING = ["S", "A", "B+", "B", "B-", "C"];
export const INTERVIEW_RATING_LABEL = {
  "S": "S（不可错过 / Super Talent）",
  "A": "A（强推荐 / Top Performer）",
  "B+": "B+（优选录用 / Strong Hire）",
  "B": "B（可录用 / Solid Hire）",
  "B-": "B-（谨慎录用 / Lean Hire）",
  "C": "C（不录用 / No Hire）",
};
export const INTERVIEW_STATUS = STATUS_COLS.map((x) => x.key);

export const NEXT_ACTIONS = [
  "待联系",
  "约一面",
  "等面试反馈",
  "安排下一轮面试",
  "约二面",
  "约三面",
  "谈薪",
  "准备Offer",
  "发Offer",
  "等入职",
  "已结束",
  "其他",
];

export const JOB_CATEGORIES = [
  "技术",
  "产品",
  "设计",
  "运营",
  "市场",
  "销售",
  "人力",
  "财务",
  "行政",
  "其他",
];

export const OFFER_STATUSES = [
  "待发放",
  "已发放",
  "已接受",
  "已拒绝",
  "已撤回",
];

export const EMPLOYMENT_TYPES = ["社招", "实习"];

export const CANDIDATE_SOURCES = [
  "官网投递",
  "内推",
  "Boss直聘",
  "猎头",
  "飞书表单",
  "手动录入",
];

// 属于"面试通过"模块的候选人状态（不在人才库中显示，仅管理员可见）
export const OFFER_STAGE_STATUSES = new Set(["待发offer", "Offer发放", "拒offer", "入职"]);

// ====== 看板流水线阶段（精简版） ======
export const PIPELINE_STAGES = [
  {
    key: "screening",
    name: "简历筛选",
    icon: "📋",
    color: "#8f959e",
    statuses: ["待筛选", "简历初筛"],
  },
  {
    key: "interview",
    name: "面试中",
    icon: "💬",
    color: "#3370ff",
    statuses: [
      "待一面",
      "一面通过",
      "一面不通过",
      "待二面",
      "二面通过",
      "二面不通过",
      "待三面",
      "三面通过",
      "三面不通过",
      "待四面",
      "四面通过",
      "四面不通过",
      "待五面",
      "五面通过",
      "五面不通过",
      "面试不通过",
      "面试Pending",
    ],
  },
  {
    key: "offer",
    name: "待发Offer",
    icon: "📝",
    color: "#ff7d00",
    statuses: ["待发offer"],
  },
  {
    key: "offered",
    name: "Offer已发",
    icon: "📨",
    color: "#7b61ff",
    statuses: ["Offer发放"],
  },
  {
    key: "offer_rejected",
    name: "拒Offer",
    icon: "🚫",
    color: "#f54a45",
    statuses: ["拒offer"],
  },
  {
    key: "hired",
    name: "已入职",
    icon: "✅",
    color: "#34c724",
    statuses: ["入职"],
  },
  {
    key: "rejected",
    name: "淘汰",
    icon: "❌",
    color: "#f54a45",
    statuses: ["淘汰"],
  },
];