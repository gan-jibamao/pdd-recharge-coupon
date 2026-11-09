/**
 * 拼多多「领 30 元话费券」每日自动领取 + 连续打卡保障
 * Surge cron 脚本 · v19
 *
 * 契约（2026-11-10 00:00 抓包实测）
 *   POST {baseUrl}/aurum/check_in/task/query            {"request_source":1}
 *   POST {baseUrl}/aurum/check_in/task/sub_task/finish  {"task_id","task_template_id","request_source":1}
 *   POST {baseUrl}/aurum/check_in/task/gain/award       {"task_id","request_source":1}
 *   鉴权只靠 Cookie；请求体不带 anti_content，也没有 AccessToken 头
 *
 * 错误码
 *   6071002 / 6070006  券已发完（终态，立即停手）
 *   4000004            请求频率超限（按次数×时长累计，退避 15s / 45s）
 *   6070004            今日已签到
 *   40001              登录态 / 风控拒绝
 *
 * 节奏（依据 11-10 零点抓包：11 发挤 26 秒全灭，7 分钟后单发即放行；券池到 00:04 才 100%）
 *   23:59:50 起静默 → 00:00:01.05 单发，当日窗口封顶 3 发
 *   00:02 补枪班次
 *   12:00 白天补签，防连续打卡断裂
 *
 * Cookie 由 pdd-cookie-capture.js 采集后写入 $persistentStore。
 */


/******************** 配置区 ********************/

const CONFIG = {
  // 登录态：留空即可（由采集脚本缓存），也可手填完整 Cookie
  cookie: "",

  // ---------- 接口（已填真实值，PDD 若改版再更新） ----------
  baseUrl: "https://m.pinduoduo.net/proxy/api/api",
  queryUrl: "/aurum/check_in/task/query",
  signUrl:  "/aurum/check_in/task/sub_task/finish",
  gainUrl:  "/aurum/check_in/task/gain/award",

  // ---------- 通知 ----------
  notify: true,
  notifyTitle: "拼多多话费券",

  // ---------- 重试 ----------
  retryTimes: 3,             // 普通失败重试次数
  retryIntervalMs: 2500,     // 普通重试间隔（毫秒）
  signRetryTimes: 3,         // 签到遇 6070004「不能签到」后的重试次数（午夜日期切换竞态假阳性）
  signRetryIntervalMs: 1500, // 签到重试间隔（毫秒；缩短减少抢券盲区）
  busyRetryTimes: 2,         // v19: 15→2。6071002 已归售罄终态，busy 只剩 6071001，不该连打 15 发
  busyRetryIntervalMs: 15000,// v19: 2000→15000（2026-11-10 实测：密集重试只会延长封锁）
  httpTimeout: 10,

  // ---------- 抢券轮询 ----------
  // 00:00 是服务器日期切换点，query 的「可领券」状态会延迟几秒才刷新，且话费券限量先到先得，
  // 所以 00:00–00:05 午夜窗口内持续轮询（总时长须小于 cron 的 timeout=90s）。
  // 窗口外（白天手动运行/延迟触发）：无事可做立即退出；签到后最多短轮询 20s 等可领券刷新。
  pollMs: 85000,             // 午夜窗口轮询总时长 85 秒（23:59:02 起跑 → ~00:00:27 结束，< cron timeout 90s）
                             // v18: 80000→85000，给跨日后的「新周期第 1 天签到」多留 5 秒
  midnightIntervalMs: 3000,  // v19: 900→3000。券池寿命是分钟级（11-10 实测 T+26s 仍有 21%），不必逐秒开火
  midnightQueryTimeoutMs: 2500, // 窗口内 query 快速超时：卡住就弃拍重发，不让一次慢查询吃掉整个窗口（09-24 07:39 实测 query 可卡 >4.9s）
  grabTimeoutMs: 3000,       // 窗口内领券请求超时（卡住弃单重打）
  // v19: 核心修正。2026-11-10 00:00 抓包铁证：11 发挤在 26 秒内全 4000004；同一账号 7 分钟后单发
  //       立刻拿到业务错误码（6071002，非限流）→ 限流按「次数×时长」累计，打得越密封得越久。
  //       旧值 300~700ms 的退避等于在封锁期里继续喂计数，两晚 0 中。
  rlBackoffMs: [15000, 45000],
  blindShots: 1,             // v19: 2→1。v18 用 while 背靠背连发两发 = 人为制造并发，必吃 4000004
  maxWindowShots: 3,         // v19: 10→3。11 发全灭 vs 7 分钟后单发放行，弹药越少活口越大
  firstShotMinMs: 1000,      // v17: 午夜后前 1000ms 禁发射（整点保护期，打了必吃 4000004）
  firstShotAimMs: 1050,      // v17: 首发精瞄 T+1050ms 出膛（两晚命中都在 T+1.0~1.3s 带内）
  preMidnightQueryTimeoutMs: 800, // v17: 23:59:52+ 的 query 竞速超时（那一拍价值极高；弃拍重发只花 300ms）
  probeWindowMin: [2, 19],   // v15: 00:02–00:19 启动 = 试限定时探针模式（配 cron "2 0 * * *" + "5 0 * * *" 两点画解除曲线）
  authQueryIntervalMs: 3000, // v14: query 被判 auth(40001) 后窗口内降频（确定性拒绝，不值得 4QPS 喂风控）
  blindSignRescue: true,     // v14: 查询全灭退出前用缓存 task 上下文盲签一次（streak 保护；false 关闭）
  daytimePollMs: 20000,      // 窗口外轮询总时长 20 秒（编辑器手动运行默认 5s 超时，别空转）
  pollIntervalMs: 1500,      // 每轮间隔 1.5 秒
};

/******************** 常量 ********************/

const STORE_KEY = {
  cookie:      "pdd_recharge.cookie",
  lastGrabDate: "pdd_recharge.last_grab_date",
  taskCtx:     "pdd_recharge.task_ctx", // v14: 最近一次成功 query 的 {task_id,task_template_id,finish,need,ts}
};

// 抓包到的真实 App UA
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_2 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Mobile/15E148 Model/iPhone15,2 phh_ios_version/8.25.0 " +
  "phh_ios_build/202609131751 pversion/0";

const REFERER = "https://m.pinduoduo.net/charge_sign_coupon.html";

/******************** 工具函数 ********************/

function log(msg) {
  console.log(`[PDD券] ${msg}`);
}

function beijingDate() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 北京时间 时:分 —— 判断是否处于 00:00 服务器日期切换竞态窗口
function beijingHM() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

// v13: 带秒（逼近零点步进 / 盲发判定用）
function beijingHMS() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
}

// v13: 日期字符串加减天（dedup 目标日计算；走 UTC 避免时区边界）
function dateAddDays(dateStr, n) {
  const d = new Date(Date.parse(dateStr + "T00:00:00Z") + n * 86400000);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

// v17: 午夜已过毫秒数（首发精瞄 / 整点保护期判定用）
function msSinceMidnight(hm) {
  return ((hm.h * 60 + hm.m) * 60 + hm.s) * 1000 + (hm.ms || 0);
}

// v17: 午夜首分钟内 T+firstShotMinMs 之前一律不许开火（整点保护期，打了必吃 4000004）
function aimReady(hm) {
  if (!(hm.h === 0 && hm.m === 0)) return true;
  return msSinceMidnight(hm) >= CONFIG.firstShotMinMs;
}

// v17: 命中后补签到——领券成功 = 连续打卡周期归零，当天签到即新周期第 1 天
async function postWinSignIn(taskId) {
  try {
    let ctx = {};
    try { ctx = JSON.parse($persistentStore.read(STORE_KEY.taskCtx) || "{}"); } catch (e) {}
    const tid = taskId || ctx.task_id;
    const tpl = ctx.task_template_id || "1";
    if (!tid) return "无 task 上下文，白天请开 App 补签到";
    const s = await doSignIn(tid, tpl);
    if (s.ok && isSuccess(s)) return "已补签到（新周期第 1 天就位）";
    if (isAlreadySigned(s)) return "已签过（新周期第 1 天已就位）";
    return `补签到未落地（${bizError(s)}），白天请开 App 补签`;
  } catch (e) { return `补签到异常（${e && e.message ? e.message : e}）`; }
}

function notify(title, body) {
  if (!CONFIG.notify) return;
  try { $notification.post(CONFIG.notifyTitle, title, body); } catch (e) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function http(method, url, bodyObj, headers, timeoutMs) {
  return new Promise((resolve) => {
    const h = Object.assign(
      {
        "User-Agent": USER_AGENT,
        Referer: REFERER,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      headers || {}
    );
    const ck = getCookie();
    if (ck) h["Cookie"] = ck;

    // Surge 官方签名：$httpClient.方法(options, callback)
    const opts = { url: url, headers: h, timeout: timeoutMs || CONFIG.httpTimeout };
    if (method === "POST") opts.body = bodyObj ? JSON.stringify(bodyObj) : "";

    const cb = (error, response, data) => {
      if (error) return resolve({ ok: false, status: 0, body: null, error: String(error) });
      let parsed = null;
      try { parsed = JSON.parse(data || "{}"); } catch (e) { parsed = { raw: data }; }
      resolve({
        ok: !!(response && response.status >= 200 && response.status < 300),
        status: response ? response.status : 0,
        body: parsed,
      });
    };

    try {
      if (method === "POST") $httpClient.post(opts, cb);
      else $httpClient.get(opts, cb);
    } catch (e) {
      resolve({ ok: false, status: 0, body: null, error: String(e) });
    }
  });
}

// 响应成功判定：{"success":true,"result":{...}}
function isSuccess(resp) {
  return !!(resp && resp.body && resp.body.success === true);
}

function bizError(resp) {
  if (!resp) return "无响应";
  if (resp.error) return resp.error;
  const b = resp.body || {};
  return b.errorMsg || b.error_msg || b.msg || b.message || JSON.stringify(b).slice(0, 200);
}

function getCookie() {
  let ck = "";
  try { ck = $persistentStore.read(STORE_KEY.cookie) || ""; } catch (e) {}
  return ck || CONFIG.cookie || "";
}

// 诊断：打印 Cookie 关键字段是否存在 + token 长度（绝不打印值）
function diagCookie(ckStr) {
  if (!ckStr) return "无 Cookie";
  const jar = {};
  String(ckStr).split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  const t = jar["PDDAccessToken"];
  const parts = [
    `字段数=${Object.keys(jar).length}`,
    `PDDAccessToken=${t ? "有(len " + t.length + ")" : "❌无"}`,
    `pdd_user_id=${jar["pdd_user_id"] ? "有" : "无"}`,
    `pdd_user_uin=${jar["pdd_user_uin"] ? "有" : "无"}`,
    `api_uid=${jar["api_uid"] ? "有" : "无"}`,
    `pdd_vds=${jar["pdd_vds"] ? "有" : "无"}`,
  ];
  return parts.join(" | ");
}

/******************** 核心接口 ********************/

function queryTask() {
  return http("POST", CONFIG.baseUrl + CONFIG.queryUrl, { request_source: 1 });
}

// v11: 窗口内 query 快速超时竞速——到点没回就弃拍（返回 null），下一拍立刻重发
function queryTaskFast(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs);
    queryTask().then((r) => { if (!settled) { settled = true; clearTimeout(t); resolve(r); } });
  });
}

function doSignIn(taskId, taskTemplateId) {
  return http(
    "POST",
    CONFIG.baseUrl + CONFIG.signUrl,
    { task_id: taskId, task_template_id: taskTemplateId, request_source: 1 }
  );
}

function doGainAward(taskId, timeoutMs) {
  // 请求体与真机抓包逐字节一致：只有 task_id + request_source，不带 anti_content
  return http("POST", CONFIG.baseUrl + CONFIG.gainUrl, { task_id: taskId, request_source: 1 }, null, timeoutMs);
}

// 判断是否为「活动太火爆」这类可重试的风控/限流错误（6071001）
function isBusyError(resp) {
  if (!resp || !resp.body) return false;
  const b = resp.body;
  if (b.errorCode === 6071001 || b.error_code === 6071001) return true;
  const msg = String(b.errorMsg || b.error_msg || "");
  return /火爆|太火|请稍后重试|稍后重试/.test(msg);
}

// 判断是否为「已签过」错误（6070004 / 不能签到）——午夜边界竞态或 App 已自动签到时会出现
function isAlreadySigned(resp) {
  if (!resp || !resp.body) return false;
  const b = resp.body;
  const code = b.errorCode !== undefined && b.errorCode !== null ? b.errorCode : b.error_code;
  if (code !== undefined && code !== null && String(code) === "6070004") return true;
  const msg = String(b.errorMsg || b.error_msg || "");
  return /不能签到|已签|已经签/.test(msg);
}

// v10: 领券响应分类（09-24 07:28 实测 6070006=券已抢完,请明日再来 → st=31 即售罄终态）
function classifyGain(resp) {
  if (resp && resp.ok && resp.body && resp.body.success === true) return "ok";
  const b = (resp && resp.body) || {};
  const code = b.errorCode !== undefined && b.errorCode !== null ? b.errorCode : b.error_code;
  const msg = String(b.errorMsg || b.error_msg || "");
  // v19: 6071002「请稍后重试，活动太火爆了」= 券池已空。
  //   2026-11-10 00:07:35 券池 100% 时单发实测返回 6071002；旧规则靠消息正则把它归 busy，
  //   于是 grabWithRetry 会对一个终态错误连打 3+15 发、耗时 37 秒，把第二天的信用额度也烧掉。
  if (String(code) === "6070006" || String(code) === "6071002" ||
      /抢完|已领完|领完了|没有名额|已抢光/.test(msg)) return "soldout";
  // v12: 09-25 00:00 实测 4000004 RATE_LIMIT_EXCEED_EXCEPTION = 平台级限流（非售罄非火爆），退避后继续打
  if (String(code) === "4000004" || /RATE_LIMIT|限流|操作频繁|请求过于频繁/.test(msg)) return "ratelimit";
  if (String(code) === "6071001" || /火爆|太火|请稍后重试|稍后重试/.test(msg)) return "busy";
  if (/请先签|先签到|去签到|请完成打卡/.test(msg)) return "needsign";
  if (/未到|未开始|暂未|还没开始|活动未/.test(msg)) return "notopen";
  if (String(code) === "40001") return "auth";
  return "other";
}

// 领券并重试：普通失败重试 retryTimes 次；「活动太火爆」额外继续抢 busyRetryTimes 次
async function grabWithRetry(taskId, timeoutMs) {
  let last = null;
  for (let i = 0; i < CONFIG.retryTimes; i++) {
    last = await doGainAward(taskId, timeoutMs);
    if (last.ok && isSuccess(last)) return { success: true, resp: last };
    log(`领券第 ${i + 1}/${CONFIG.retryTimes} 次：${bizError(last)}`);
    if (i < CONFIG.retryTimes - 1) await sleep(CONFIG.retryIntervalMs);
  }

  // 「活动太火爆」→ 持续抢
  let extra = 0;
  while (isBusyError(last) && extra < CONFIG.busyRetryTimes) {
    await sleep(CONFIG.busyRetryIntervalMs);
    extra++;
    last = await doGainAward(taskId, timeoutMs);
    if (last.ok && isSuccess(last)) return { success: true, resp: last };
    log(`活动火爆继续抢 ${extra}/${CONFIG.busyRetryTimes}：${bizError(last)}`);
  }
  return { success: false, resp: last };
}

// 诊断快照：按钮/奖励原始字段（can_click 之外常带文案，如「明日10点开抢」，是定性关键）
function dumpCtx(r) {
  try {
    return JSON.stringify({
      display_status: r.display_status,
      finish_count: r.finish_count,
      gain_award_count: r.gain_award_count,
      gain_award_button: r.gain_award_button,
      award_content: r.award_content,
    }).slice(0, 500);
  } catch (e) { return "dump失败"; }
}

// 满 5 天但服务端仍判不可领：试领一次定性（未开抢 / 已抢完 / 风控，errorMsg 会说明）。
// 若返回「活动太火爆」→ 窗口其实开着，直接进入持续抢。
async function probeClaim(taskId) {
  const p = await doGainAward(taskId);
  if (p.ok && isSuccess(p)) return { claimed: true, resp: p };
  if (isBusyError(p)) {
    log("试领返回活动火爆 → 窗口实际开放，进入持续抢");
    const gr = await grabWithRetry(taskId);
    if (gr.success) return { claimed: true, resp: gr.resp };
    return { claimed: false, resp: gr.resp };
  }
  log(`试领被拒：${bizError(p)}`);
  try { log(`试领原始响应：${JSON.stringify(p.body).slice(0, 400)}`); } catch (e) {}
  return { claimed: false, resp: p };
}

// v14: 查询全灭时的 streak 保护——用最近一次成功 query 缓存的 task 上下文盲签一次。
// 跨日后 task_id 可能失效：失败仅记录；6070004（已签过）也算落地。
async function blindSignRescue() {
  if (CONFIG.blindSignRescue === false) return "";
  let ctx = null;
  try { ctx = JSON.parse($persistentStore.read(STORE_KEY.taskCtx) || "null"); } catch (e) {}
  if (!ctx || !ctx.task_id) { log("盲签跳过：无缓存 task 上下文（本机从未成功查询过）"); return "盲签未尝试（无缓存task_id）"; }
  const ageH = Math.round((Date.now() - (ctx.ts || 0)) / 3600000);
  log(`盲签：用缓存 task 上下文尝试签到（缓存 ${ageH}h 前，当时 ${ctx.finish}/${ctx.need} 天）`);
  const s = await doSignIn(ctx.task_id, ctx.task_template_id);
  if (s.ok && isSuccess(s)) { log("盲签成功：今日签到已落地"); return "盲签成功（今日已签）"; }
  if (isAlreadySigned(s)) { log("盲签返回已签过：今日签到早已落地"); return "今日已签（App侧已落地）"; }
  log(`盲签未落地：${bizError(s)}`);
  return "盲签未落地，请白天开 App 补签防连续打卡断裂";
}


// v13: 00:05–00:19 启动的定时探针——不是为抢券（券池 00:00:11 就空了），是给 4000004
// 封锁窗打「解除时间点」：00:05 回 6070006 = 业务层恢复 → 封锁窗 ≥ 券池寿命(~10s)，
// 脚本路线实锤判死；仍 4000004 = 封锁 >5min，更死。真正能翻盘的证据是 App 手点
//（pdd-gain-replay）：手点被拒 = 全客户端封锁；手点成功 = 客户端形状 → 补打路线复活。
// （win 分支仅为兜底：若 PDD 某天补放名额/状态异常开放，探针顺手把券收下。）
async function probeRun() {
  const q = await queryTask();
  if (!q || !q.ok || !isSuccess(q)) {
    const kind = q ? classifyGain(q) : "无响应";
    log(`探针 query 失败（${kind}）：${bizError(q)}`);
    notify("探针失败", `00:05+ 探针 query 被拒（${kind} / ${bizError(q)}）——白天手动跑一次本脚本定性`);
    $done();
    return;
  }
  const r = q.body.result || {};
  const canSign = !!(r.sub_task_list && r.sub_task_list[0] && r.sub_task_list[0].check_in_button && r.sub_task_list[0].check_in_button.can_click);
  log(`探针状态：st=${r.display_status} 领取按钮=${r.gain_award_button ? r.gain_award_button.can_click : "?"} 可签到=${canSign}`);

  // v18: 探针顺带签到——00:05 那班 cron 兼作「午夜漏签」兜底（10-01 / 10-02 连漏两天的补丁位）。
  //   抢券窗口早过（券池 ~10s 就空），签到与试领互不干扰；canSign=false 时一枪不发。
  let probeSignMsg = "";
  if (canSign && r.task_id) {
    log("探针发现可签到 → 补签一枪");
    const ps = await doSignIn(r.task_id, r.task_template_id);
    if (ps.ok && isSuccess(ps)) { probeSignMsg = "已补签到（新周期第 1 天就位）"; log("探针补签成功"); }
    else if (isAlreadySigned(ps)) { probeSignMsg = "今日签到早已落地"; log("探针补签返回已签过（6070004）"); }
    else { probeSignMsg = `补签未落地：${bizError(ps)}`; log(`探针补签未落地：${probeSignMsg}`); }
  }

  if (r.display_status === 40) {
    log("券已领取，探针退出");
    notify("探针：券已领过", probeSignMsg ? `今日签到：${probeSignMsg}` : "今日不可签到（已签或按钮未开）");
    $done();
    return;
  }
  // v19: 单发 → 低频补枪。11-10 实测券池是分钟级寿命（T+26s 仍有 21%，00:04 才 100%），
  //   旧版探针只打一枪，若落在限流期就直接放弃一整天的机会。改成 3 枪、间隔 15s。
  let p = null, kind = "other";
  for (let i = 0; i < 3; i++) {
    if (i > 0) await sleep(15000);
    p = await doGainAward(r.task_id);
    if (p.ok && isSuccess(p)) {
      try { $persistentStore.write(beijingDate(), STORE_KEY.lastGrabDate); } catch (e) {}
      log("探针直接命中，领券成功！");
      const sw = await postWinSignIn(r.task_id);
      notify("领券成功", `探针命中！${(r.award_content && r.award_content.award_name) || "话费券"} 仍可领；${sw}`);
      $done();
      return;
    }
    kind = classifyGain(p);
    log(`探针第 ${i + 1}/3 发被拒（${kind}）：${bizError(p)}`);
    if (kind === "soldout" || kind === "auth") break;   // 终态，不用再打
  }
  try { log(`探针原始响应：${JSON.stringify(p && p.body).slice(0, 400)}`); } catch (e) {}
  notify("探针结果", `00:${String(beijingHM().m).padStart(2, "0")} 探针：${kind} / ${bizError(p)}`);
  $done();
}

/******************** 主流程 ********************/

async function main() {
  const today = beijingDate();
  log(`开始执行（v19），日期 ${today}`);
  log(`Cookie 诊断：${diagCookie(getCookie())}`);

  if (!getCookie()) {
    log("未获取到 cookie：请先打开一次拼多多 App/网页让采集脚本缓存，或手填 CONFIG.cookie");
    notify("未获取到 Cookie", "请打开一次拼多多 App/网页，或手填 CONFIG.cookie");
    $done();
    return;
  }

  // v13: 00:05–00:19 启动 = 试限定时探针（需另配 cron "5 0 * * *"，timeout=30）
  const hm0 = beijingHM();
  const [pMin, pMax] = CONFIG.probeWindowMin;
  if (hm0.h === 0 && hm0.m >= pMin && hm0.m <= pMax) {
    await probeRun();
    return;
  }

  // 防重复（v13 修 bug）：领券成功写入 lastGrabDate=成功当日。23:59 预埋跑的目标日是「明天」，
  // 旧版比对「今天」→ 抢中当晚 23:59 预埋会被误杀（次日窗口直接弃权）。
  let lastGrab = "";
  try { lastGrab = $persistentStore.read(STORE_KEY.lastGrabDate) || ""; } catch (e) {}
  const targetDay = (hm0.h === 23 && hm0.m >= 59) ? dateAddDays(today, 1) : today;
  if (lastGrab === targetDay) {
    log(`目标日 ${targetDay} 已领过券，跳过`);
    $done();
    return;
  }

  // 1. 抢券轮询：午夜窗口（00:00–00:05）内长轮询 75s，熬服务器日期切换竞态（限量先到先得）；
  //    窗口外最多轮询 20s。若已签到且不可领券且不在窗口内 → 下面立即退出，不空转。
  const hm = beijingHM();
  // v9: 23:59 预埋起跑同样算窗口（脚本先热身，00:00 一到立即抢/签）
  const isMidnightWindow = (hm.h === 0 && hm.m <= 5) || (hm.h === 23 && hm.m >= 59);
  const deadline = Date.now() + (isMidnightWindow ? CONFIG.pollMs : CONFIG.daytimePollMs);
  let triedSign = false;      // 今天只签到一次
  let soldOut = false;        // v10: 当日名额已抢完（6070006），跨日时重置
  let grabShots = 0;          // v12: 本窗口已开火数（4000004 限流取证）
  let rlShots = 0;            // v19: 其中真正被 4000004 拒绝的发数（通知文案按它算，别把售罄说成限流）
  let rlWait = 0;             // v12: 限流退避等待（下一拍生效）
  let lastState = "";
  let runDate = today;        // v9: 预埋起跑会横跨 23:59→00:00，跨日时重置签到标记
  let preArmed = false;       // v13: 查到满 5 天 → 允许 00:00 盲发
  let blindLeft = CONFIG.blindShots; // v13: 盲发枪数余量
  let lastTaskId = "";        // v13: 23:59 预埋的 task_id（盲发用；跨日若换新由确认射击接管）
  let sawOpen = false;        // v13: 见过开放态（st=30/32/33 或 canGrab）——盲发期 6070006 不许 latch 售罄
  let signLanded = false;     // v13: 显式签到成功过（通知措辞 / streak 判断用）
  let forceSign = false;      // v13: gain 回 needsign → 破例解锁窗口内签到
  let qFails = 0;             // v14: 连续被拒的 query 拍数（取证）
  let lastQKind = "";         // v14: 上一次 query 失败分类（首次记录 + auth 降频判定）
  let ride40Logged = false;   // v18: st=40 午夜续跑只打一次日志
  let lastSt = 0;             // v18: 上一拍查到的 display_status（盲发闸：40=券已领，不许再开火）

  // v17: 跨日重置抽成函数——循环顶与「query 后重取 hmPost」两处都调。
  //   只调循环顶会漏掉跨午夜那一拍：拍头 hmNow 还是 23:59，重置被推迟到下一拍（10-01 log 实测 00:00:00.731）
  const syncDay = () => {
    const nd = beijingDate();
    if (nd === runDate) return false;
    runDate = nd; triedSign = false; soldOut = false; ride40Logged = false;
    log("跨日：重置签到/抢券标记，进入新的一天");
    return true;
  };

  while (true) {
    const hmNow = beijingHMS(); // 每拍取新鲜时间（取证日志/窗口判定用）
    syncDay();
    // v13: 盲发——00:00:00 一到先开火，不等 query 确认（两晚首发都拖到确认后 +1.8~2.0s）。
    // 用 23:59 预埋的 lastTaskId；若跨日 task_id 换新，盲发落空由确认射击接管，无副作用。
    // v19: while 连发 → 单发。v18 的 while 两发之间没有 sleep，等于同一毫秒并发两枪；
    //      2026-11-10 T+1s 的 3 发并发正是当晚 4000004 的起点。后续补枪交给退避链。
    if (preArmed && blindLeft > 0 && lastTaskId && !soldOut && lastSt !== 40 &&
        hmNow.h === 0 && hmNow.m === 0 && aimReady(hmNow) && grabShots < CONFIG.maxWindowShots) {
      blindLeft--;
      const bg = await doGainAward(lastTaskId, CONFIG.grabTimeoutMs);
      grabShots++;
      const bkind = classifyGain(bg);
      if (bkind === "ok") {
        try { $persistentStore.write(beijingDate(), STORE_KEY.lastGrabDate); } catch (e) {}
        log("盲发命中，领券成功！");
        const sw = await postWinSignIn(lastTaskId); // v17: 命中即周期归零，补一枪签到保新周期第 1 天
        log(`命中后补签到：${sw}`);
        notify("领券成功", `盲发命中！已领到话费券（T+${CONFIG.firstShotAimMs}ms 首发）；${sw}`);
        $done();
        return;
      }
      if (bkind === "soldout" && sawOpen) { soldOut = true; log("盲发返回售罄（已见过开放态），今日停手"); }
      else {
        log(`盲发：${bkind === "ratelimit" ? "限流 4000004" :
          bkind === "soldout" ? "售罄码（未见开放态，不判售罄，继续）" : bizError(bg)}`);
        if (bkind === "ratelimit") { rlShots++; rlWait = CONFIG.rlBackoffMs[0]; }
      }
    }
    // v17: 逼近零点那几拍（23:59:52+）用 800ms 短超时——那一拍卡住会把确认射击推到 T+2.8s
    const preZero = hmNow.h === 23 && hmNow.m === 59 && hmNow.s >= 52;
    const qTmo = isMidnightWindow ? (preZero ? CONFIG.preMidnightQueryTimeoutMs : CONFIG.midnightQueryTimeoutMs) : undefined;
    const q = isMidnightWindow ? await queryTaskFast(qTmo) : await queryTask();
    if (!q || !q.ok || !isSuccess(q)) {
      if (!q) log(`query 超过 ${qTmo}ms 未回，弃拍重发`);
      if (Date.now() > deadline) {
        // v14: 出口带分类取证 + 盲签 streak 保护（v13 在此静默 21s 后裸退，0 签到）
        const kind = q ? classifyGain(q) : "无响应";
        log(`查询失败（${kind}）：${bizError(q)}${qFails ? `（本窗口连续 ${qFails} 拍被拒）` : ""}`);
        try { log(`原始响应：${JSON.stringify(q && q.body).slice(0, 500)}`); } catch (e) {}
        const blind = await blindSignRescue();
        notify("查询失败", `${kind} / ${bizError(q)}；${blind}；` +
          (kind === "auth"
            ? "白天手动跑一次本脚本定性：白天也 40001=Cookie 失效需重抓；白天正常=午夜风控墙，抢券转 App 手点+点击放大器"
            : "白天手动跑一次本脚本定性"));
        $done();
        return;
      }
      if (q) {
        // v14: 失败不再静默——首次被拒即分类记录，同类每 10 拍汇报一次
        qFails++;
        const k = classifyGain(q);
        if (k !== lastQKind) {
          lastQKind = k; qFails = 1;
          log(`查询被拒（${k}）：${bizError(q)}`);
          if (k === "auth") log(`auth(40001)=登录态/风控层拒绝——窗口内降频 ${CONFIG.authQueryIntervalMs}ms 继续探（定性以白天手动跑为准）`);
        } else if (qFails % 10 === 0) {
          log(`查询被拒（${k}）已持续 ${qFails} 拍`);
        }
      }
      await sleep(isMidnightWindow ? (lastQKind === "auth" ? CONFIG.authQueryIntervalMs : 300) : CONFIG.pollIntervalMs);
      continue;
    }

    const r = q.body.result || {};
    const finish = r.finish_count || 0;          // 当前连续打卡天数
    const need = r.gain_award_count || 5;        // 领券所需天数
    const taskId = r.task_id;
    const taskTemplateId = r.task_template_id;
    const gainBtn = r.gain_award_button || {};
    const st = r.display_status;                 // 20=新一天cycle未满 30=满5天开抢中(00:00后几秒,不等can_click) 31=当日已抢完(6070006实测) 32/33=可领(未实测) 40=已领取
    // can_click 可能滞后/漏翻 display_status（09-22 00:00 实测 5/5 全程 false）：状态已判「可领」就按可领处理
    const canGrab = !!gainBtn.can_click || st === 32 || st === 33;
    const checkInBtn = (r.sub_task_list && r.sub_task_list[0] && r.sub_task_list[0].check_in_button) || {};
    const canSign = !!checkInBtn.can_click;      // 今天还没签
    const award = r.award_content || {};
    const awardDesc = `${award.award_threshold || ""}减${award.award_price || "30"}`;
    if (finish >= need && taskId) preArmed = true;                      // v13: 满 5 天 → 允许 00:00 盲发
    lastSt = st;                                                        // v18: 盲发闸用（st=40 = 券已领，跨日头一枪不打）
    if (canGrab || st === 30 || st === 32 || st === 33) sawOpen = true; // v13: 见过开放态（盲发期售罄判定闸）
    if (taskId) lastTaskId = taskId;
    let hmPost = beijingHMS(); // v16: 查询可能跨午夜（23:59:59 发出→00:00:00 返回），用查询后的新鲜时间判定，修 sign-in 插队/首发延迟
    syncDay(); // v17: 跨午夜那拍在开火前完成跨日重置（循环顶那拍的时间还是 23:59）
    // v14: 每次成功 query 持久化 task 上下文（查询全灭夜的盲签弹药）
    try { $persistentStore.write(JSON.stringify({ task_id: taskId, task_template_id: taskTemplateId, finish: finish, need: need, ts: Date.now() }), STORE_KEY.taskCtx); } catch (e) {}

    const stateLine = `连续打卡 ${finish} 天 / 需 ${need} 天；可领券=${canGrab}；可签到=${canSign}；状态=${st}`;
    const forensic = hmPost.h === 0 && hmPost.m === 0; // v9: 00:00–00:01 逐拍留痕（开抢窗口可能 <2s）
    if (stateLine !== lastState) { log(stateLine); log(`快照: ${dumpCtx(r)}`); lastState = stateLine; }
    else if (forensic) { log(stateLine); }

    // v17: 首发精瞄——午夜首分钟内尚未开火时，把第一枪精确对齐到 T+firstShotAimMs。
    //   实测：09-28 命中 t=+1047ms、10-01 命中 t=+1297ms；09-25/26/29 从未有任何一枪落进
    //   T+1.0~1.3s 带内（首发 1.8s+，或烧在 T+0~1.0s 的整点保护期）。
    if (preArmed && grabShots === 0 && !soldOut && st !== 40 &&
        hmPost.h === 0 && hmPost.m === 0 &&
        msSinceMidnight(hmPost) + 30 < CONFIG.firstShotAimMs) {
      const align = CONFIG.firstShotAimMs - msSinceMidnight(hmPost);
      log(`首位对齐：睡 ${align}ms 到 T+${CONFIG.firstShotAimMs}ms 出膛（整点保护期内不打）`);
      await sleep(align);
      hmPost = beijingHMS(); // 醒来重取时间
    }

    // 1.0 券已领取（display_status=40）——★ v18：这不等于「今日无事可做」。
    //     领券成功 = 连续打卡周期归零 → 新周期第 1 天的签到照样必须落地（09-28 / 10-01 各漏一次）。
    //     ① 签到已落地（或今日确实不可签）且不在午夜窗口 → 才收工；
    //     ② 23:59 预埋 / 00:00–00:05 窗口内，或仍可签到 → 不退出：wantGrab 因 st===40 不会触发，
    //        继续轮询等跨日状态翻转，由下面正常的签到分支完成新周期第 1 天。
    //     （旧版在这里无条件 $done —— 10-01 23:59:02 预埋死在第一拍，10-02 的新周期第 1 天因此漏签）
    if (st === 40) {
      if (!isMidnightWindow && (signLanded || !canSign)) {
        log(`display_status=40：券已领过${signLanded ? "，今日签到已落地" : "，今日不可签到"} → 收工`);
        notify(signLanded ? "今日已签到" : "已领过券",
          signLanded ? `话费券已领过；今日签到已落地（连续打卡 ${finish} 天 / 需 ${need} 天）`
                     : `连续打卡 ${finish} 天 / 需 ${need} 天，今日话费券已领取；今日不可签到`);
        $done();
        return;
      }
      if (!ride40Logged) {
        ride40Logged = true;
        log(`券已领取（40）${canSign ? "但今日可签到 → 走签到" : "仍在午夜窗口 → 等跨日翻转后签到"}`);
      }
      // 不 return：落到下面（1.5 因 isMidnightWindow/可签到跳过，2 因 st===40 不触发，3 负责签到）
    }

    // 1.5 已签到且不可领券、也不在午夜竞态窗口 → 今日无事可做，立即退出。
    //     （白天手动运行/延迟触发不再空轮询 75s，也就不会撞 [Script Timeout]）
    if (!canGrab && !canSign && !isMidnightWindow) {
      // 1.6 已满 5 天却仍判不可领（状态非 32/33/40）→ 白天手动跑也能试领一次定性
      if (finish >= need && st !== 40) {
        log(`已满 ${need} 天但服务端未开放领取（状态=${st}），试领一次定性`);
        const pr = await probeClaim(taskId);
        if (pr.claimed) {
          try { $persistentStore.write(beijingDate(), STORE_KEY.lastGrabDate); } catch (e) {}
          const sw = await postWinSignIn(taskId); // v17: 命中即周期归零，补一枪签到保新周期第 1 天
          log(`命中后补签到：${sw}`);
          notify("领券成功", `试领直接命中！已领到话费券（${awardDesc}）；${sw}`);
        } else {
          notify("未领到券", `已满 ${need} 天，试领被拒：${bizError(pr.resp)}`);
        }
        $done();
        return;
      }
      const left = Math.max(need - finish, 0);
      log(`今日流程完成：已签到，连续 ${finish} 天 / 需 ${need} 天，还差 ${left} 天，状态=${st}`);
      notify("今日已签到", `连续打卡 ${finish} 天 / 需 ${need} 天，还差 ${left} 天（状态=${st}）` +
        (finish + 1 >= need ? "，明天签到后即可领券！" : ""));
      $done();
      return;
    }

    // 2. 抢券（最高优先级；v10：午夜窗口内 st=30 即开抢中——不等 can_click（它整窗不翻，09-24 快照实锤
    //    if_grayed_out），先抢后签。can_click/32/33 命中时窗口外也抢）
    const wantGrab = taskId && finish >= need && !soldOut && st !== 40 && st !== 31 &&
      grabShots < CONFIG.maxWindowShots && // v13: 单窗口 gain 封顶（含盲发）
      rlWait === 0 && // v19: 退避未走完不许再开火。否则盲发刚被限流，同一拍会紧接着再打一枪 = 两发连击
      (canGrab || (hmPost.h === 0 && hmPost.m <= 5)) && aimReady(hmPost); // v17: 首发精瞄闸（T+1000ms 前不许开火）
    if (wantGrab) {
      grabShots++;   // v19: 所有失败分支统一计数。v18 只在 ratelimit 分支自增，
                     //       非限流失败（notopen/other）时 grabShots 恒 0 → maxWindowShots 形同虚设
      const grabTmo = hmPost.h === 0 ? CONFIG.grabTimeoutMs : undefined;
      const g = await doGainAward(taskId, grabTmo);
      const kind = classifyGain(g);
      if (kind === "ok") {
        try { $persistentStore.write(beijingDate(), STORE_KEY.lastGrabDate); } catch (e) {}
        const sw = await postWinSignIn(taskId); // v17: 命中即周期归零，补一枪签到保新周期第 1 天
        log(`命中后补签到：${sw}`);
        notify("领券成功", `已领到 ${award.award_name || "话费券"}（${awardDesc}）；${sw}`);
        $done();
        return;
      }
      if (kind === "busy") {
        log("活动火爆 → 进入持续抢");
        const gr = await grabWithRetry(taskId, grabTmo);
        if (gr.success) {
          try { $persistentStore.write(beijingDate(), STORE_KEY.lastGrabDate); } catch (e) {}
          const sw = await postWinSignIn(taskId); // v17: 命中即周期归零，补一枪签到保新周期第 1 天
          log(`命中后补签到：${sw}`);
          notify("领券成功", `已领到 ${award.award_name || "话费券"}（${awardDesc}）；${sw}`);
          $done();
          return;
        }
        soldOut = true;
        log(`持续抢未中：${bizError(gr.resp)}`);
      } else if (kind === "soldout") {
        soldOut = true;
        log(`今日名额已抢完：${bizError(g)}`);
      } else if (kind === "ratelimit") {
        rlShots++;
        const wait = CONFIG.rlBackoffMs[Math.min(grabShots - 1, CONFIG.rlBackoffMs.length - 1)];
        rlWait = wait;
        log(`抢券第 ${grabShots} 发被限流 4000004，退避 ${wait}ms 后再打`);
      } else {
        if (kind === "needsign") forceSign = true; // v13: 仅此情形破例解锁窗口内签到
        // notopen / needsign / auth / other → 继续轮询再试（needsign 会落到下面签到分支）
        log(`抢券未中（${kind}）：${bizError(g)}`);
      }
    }

    // 3. 可签到 → 签到一次（签到后立即重查，可能即可领券）
    //    v13: 00:00–00:01 且满 5 天时冻结签到——09-26 实测签到分支在首发被拒后插队，
    //    签到+3 次重试烧掉 4.8s 黄金窗口（01.8→06.6），第 2/3 发被拖到 06.7/08.7。
    //    v18: 补 st !== 40 —— 冻结只为保抢券窗口，券已领过时无券可抢，冻结只会把新周期签到也冻掉。
    const hotGrab = hmPost.h === 0 && hmPost.m <= 1 && finish >= need && !forceSign && st !== 40;
    if (canSign && !triedSign && !hotGrab) {
      log("今天还没签到，开始签到");
      const s = await doSignIn(taskId, taskTemplateId);
      if (s.ok && isSuccess(s)) {
        triedSign = true;
        signLanded = true;
        log("签到成功，重查是否可领券");
        continue;
      }
      if (isAlreadySigned(s)) {
        // 09-22 00:00:01.98 实测教训：日期切换竞态窗口内的 6070004 可能是假阳性
        //（之后可签到翻 false、可领券始终 false，当天再无签到机会）。重试确认，不再一票放弃。
        triedSign = true;
        let signed = false;
        for (let i = 1; i <= (CONFIG.signRetryTimes || 0); i++) {
          await sleep(CONFIG.signRetryIntervalMs);
          const s2 = await doSignIn(taskId, taskTemplateId);
          if (s2.ok && isSuccess(s2)) { signed = true; log(`第 ${i} 次重试签到成功`); break; }
          if (!isAlreadySigned(s2)) { log(`第 ${i} 次重试签到失败：${bizError(s2)}`); break; }
        }
        if (signed) { signLanded = true; log("重试签到成功，重查是否可领券"); continue; }
        log(`签到返回「${bizError(s)}」且 ${CONFIG.signRetryTimes} 次重试仍不能签，继续等可领券`);
        continue;
      }
      log(`签到失败：${bizError(s)}（稍后重试）`);
      // 落到下面 sleep 继续轮询
    }

    // 3.5 v18: 签到已落地且今日无券可抢（未满 5 天）→ 立即收工。
    //     新周期第 1 天就是这种形态：签完就没别的事了，不必空转到 deadline 再误报「未领到券」。
    //     hmPost.h !== 23：23:59 那一签是旧一天的，还要续跑到 00:00 给新一天签。
    if (signLanded && !canGrab && !soldOut && finish < need && hmPost.h !== 23) {
      const cycleLeft = Math.max(need - finish, 0);
      log(`今日签到已落地（连续 ${finish} 天 / 需 ${need} 天），无券可抢 → 收工`);
      notify("今日已签到", `连续打卡 ${finish} 天 / 需 ${need} 天` + (cycleLeft > 0 ? `，还差 ${cycleLeft} 天` : ""));
      $done();
      return;
    }

    // 4. 已签到但尚未可领券 → 继续轮询，直到超时
    if (Date.now() > deadline) {
      // v13 补签 → v15 强化：不再看 canSign——09-28 实测售罄翻转瞬间可签到 true→false 而全程
      // 零签到动作（canSign=false ≠ 已签，可能只是状态 31 的连带字段）。!signLanded 即盲签一枪：
      // 成功 / 6070004（本就已签）都算落地闭环；其余失败留证据进通知，白天 App 补签。
      let blindSignMsg = "";
      if (!signLanded && taskId) {
        log(`窗口结束补签（canSign=${canSign} 不作门槛）`);
        const s3 = await doSignIn(taskId, taskTemplateId);
        if (s3.ok && isSuccess(s3)) { signLanded = true; log("补签成功：今日签到已落地"); }
        else if (isAlreadySigned(s3)) { signLanded = true; log("补签返回已签过（6070004）：今日签到早已落地"); }
        else { blindSignMsg = String(bizError(s3)); log(`补签未落地：${blindSignMsg}（白天请开 App 补签，防连续打卡断裂）`); }
      }
      // 4.5 午夜窗口熬完仍满 5 天不可领 → 试领一次定性（可能窗口根本不在 00:00 开）
      //     v19: 本窗口已经打过枪（尤其全被 4000004）时不再补探——11-10 实测 26 秒内 11 发全灭，
      //          多这一发不会改变结果，只会继续给限流计数充值。
      if (finish >= need && st !== 40 && !soldOut && grabShots === 0) {
        log(`午夜窗口结束仍未开放（状态=${st}），试领一次定性`);
        const pr = await probeClaim(taskId);
        if (pr.claimed) {
          try { $persistentStore.write(beijingDate(), STORE_KEY.lastGrabDate); } catch (e) {}
          const sw = await postWinSignIn(taskId); // v17: 命中即周期归零，补一枪签到保新周期第 1 天
          log(`命中后补签到：${sw}`);
          notify("领券成功", `试领直接命中！已领到话费券（${awardDesc}）；${sw}`);
          $done();
          return;
        }
      }
      log(`轮询结束未领到券（可领券=${canGrab}；可签到=${canSign}；状态=${st}；${grabShots} 发）`);
      const rlTag = rlShots ? `；${rlShots} 发被限流(4000004)` : "";
      const signTag = signLanded ? "已签到"
        : blindSignMsg ? `盲签也未落地（${blindSignMsg}），白天务必开 App 补签防连续天数断裂`
        : canSign ? "尚未签到成功，请白天开 App 补签防连续天数断裂"
        : "签到未落地（无 task 上下文），白天请开 App 补签";
      // v18: 券已领过就别喊「未领到券」——今天真正要做的是签到
      if (st === 40) {
        log(`午夜窗口结束：券已领过（40），签到${signLanded ? "已落地" : "未落地"}`);
        notify("已领过券", `话费券已领过；今日签到：${signTag}`);
        $done();
        return;
      }
      notify("未领到券", `连续打卡 ${finish} 天，${signTag}${rlTag}；` +
        (soldOut ? "今日券已发完（售罄终态），明日 00:00 预埋再战" : `状态=${st}`));
      $done();
      return;
    }
    if (rlWait > 0) { const w = rlWait; rlWait = 0; await sleep(w); } // v12: 限流退避优先于常规节拍
    else if (hmPost.h === 23 && hmPost.m === 59 && hmPost.s >= 50 && preArmed) {
      // v19: 23:59:50 起彻底静默，一跳睡到 T+firstShotAimMs。
      //   旧版这里是 250ms 一次的 query 轮询（4QPS），2026-11-10 抓包里零点前 3 拍各 3 请求、
      //   零点整秒后立刻 4000004——预埋轮询本身就在烧配额。这一跳由盲发接棒。
      const waitMs = (60 - hmPost.s) * 1000 - (hmPost.ms || 0) + CONFIG.firstShotAimMs;
      if (waitMs > 0 && waitMs < 15000) {
        log(`预埋静默 ${waitMs}ms，等 T+${CONFIG.firstShotAimMs}ms 首发`);
        await sleep(waitMs);
      } else {
        await sleep(CONFIG.pollIntervalMs);
      }
    }
    else if (hmPost.h === 0 && hmPost.m <= 1) await sleep(CONFIG.midnightIntervalMs);
    else await sleep(CONFIG.pollIntervalMs);
  }
}

main().catch((e) => {
  log(`异常：${e && e.message ? e.message : e}`);
  $done();
});
