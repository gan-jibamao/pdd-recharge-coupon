/**
 * ============================================================
 *  pdd-cookie-capture.js — Surge http-request 脚本（v4，双域抓取）
 *  抓取来源（任一命中即处理，写入同一键 pdd_recharge.cookie）：
 *    A) m.pinduoduo.net 全域        —— 券活动页所在域（历史采集源）
 *    B) mobile.yangkeduo.com/proxy/ —— H5 主站 API 中继
 *
 *  v4 修的三处（均为 v3 实测缺陷）：
 *    1. 只在「核心鉴权字段」变化时写盘。v3 比对整条 Cookie 串，而 pdd_vds / dilx / jrpl
 *       每个请求都在轮换 → 几乎每个被拦截的请求都触发一次 $persistentStore.write（I/O 放大）。
 *       核心字段 = PDDAccessToken + pdd_user_id + pdd_user_uin + _nano_fp，四者不变即视为同一登录态。
 *    2. 非核心字段的轮换走 60s 节流静默写入，不弹窗。v3 每次变化都弹，实际是通知轰炸。
 *    3. 「未变化」心跳弹窗 10min → 6h。v3 的 10 分钟一次等于一天 144 条通知。
 *    4. 脚本声明去掉 requires-body：本脚本不读 body，强制缓冲只会让大响应变慢。
 *
 *  Surge [Script]（type=http-request，pattern 两条，均不带 requires-body）：
 *  拼多多Cookie采集   = type=http-request, pattern=^https?:\/\/m\.pinduoduo\.net, script-path=pdd-cookie-capture.js, timeout=5
 *  拼多多Cookie采集YKD = type=http-request, pattern=^https?:\/\/mobile\.yangkeduo\.com\/proxy/, script-path=pdd-cookie-capture.js, timeout=5
 * ============================================================
 */

const KEY_COOKIE = "pdd_recharge.cookie";
const KEY_SIG    = "pdd_recharge.cookie_sig";
const KEY_SEEN   = "pdd_recharge.cookie_seen_ts";
const KEY_WRITE  = "pdd_recharge.cookie_write_ts";

const SEEN_COOLDOWN_MS  = 6 * 60 * 60 * 1000; // 心跳通知：6 小时
const SILENT_WRITE_MS   = 60 * 1000;          // 非核心字段静默写盘节流

// 真正决定能不能调接口的四个字段
const CORE_FIELDS = ["PDDAccessToken", "pdd_user_id", "pdd_user_uin", "_nano_fp"];

function getHeader(headers, name) {
  if (!headers) return "";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return String(headers[k] || "");
  }
  return "";
}

function parseJar(ckStr) {
  const jar = {};
  String(ckStr || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return jar;
}

// FNV-1a 32bit → 8 hex（指纹用，非加密）
function fp8(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

function coreSig(ckStr) {
  const jar = parseJar(ckStr);
  return CORE_FIELDS.map((k) => jar[k] || "").join("\u0001");
}

function tokenOf(ckStr) {
  const m = /(?:^|;\s*)PDDAccessToken=([^;]+)/.exec(String(ckStr || ""));
  return m ? m[1] : "";
}

function read(k) { try { return $persistentStore.read(k) || ""; } catch (e) { return ""; } }
function write(k, v) { try { $persistentStore.write(String(v), k); return true; } catch (e) { return false; } }

function srcOf(url) {
  return /m\.pinduoduo\.net/.test(url) ? "m.pinduoduo.net" : "mobile.yangkeduo.com";
}

function notify(title, body) {
  try { $notification.post("拼多多话费券", title, body); } catch (e) {}
}

(function main() {
  try {
    const url = ($request && $request.url) || "";
    const ck = getHeader($request && $request.headers, "Cookie");
    if (!ck) { console.log(`[PDDcookie] ${url.slice(0, 120)} 无 Cookie 头，跳过`); return $done({}); }

    const jar = parseJar(ck);
    const tok = jar.PDDAccessToken || "";
    if (!tok) {
      console.log(`[PDDcookie] 无 PDDAccessToken（字段数=${Object.keys(jar).length}），不写入`);
      return $done({});
    }

    const src = srcOf(url);
    const now = Date.now();
    const sig = coreSig(ck);
    const old = read(KEY_COOKIE);
    const oldSig = old ? coreSig(old) : "";
    const fp = fp8(tok);
    const n = Object.keys(jar).length;

    // 1) 核心字段变了 → 立即写盘 + 弹窗（真正的登录态更新）
    if (sig !== oldSig) {
      if (!write(KEY_COOKIE, ck)) { console.log("[PDDcookie] 写入失败"); return $done({}); }
      write(KEY_SIG, sig);
      write(KEY_WRITE, now);
      const oldFp = tokenOf(old) ? fp8(tokenOf(old)) : "无";
      console.log(`[PDDcookie] 已更新（${src}，${n} 字段，token ${oldFp}→${fp}）`);
      notify("Cookie 已更新", `${src} | ${n} 字段 | token ${oldFp}→${fp}\n主脚本下次运行自动生效`);
      return $done({});
    }

    // 2) 核心字段没变，只有轮换字段（pdd_vds/dilx/jrpl…）不同 → 60s 节流静默写盘，不弹窗
    if (ck !== old) {
      const lastWrite = parseInt(read(KEY_WRITE) || "0", 10) || 0;
      if (now - lastWrite >= SILENT_WRITE_MS) {
        write(KEY_COOKIE, ck);
        write(KEY_WRITE, now);
        console.log(`[PDDcookie] 轮换字段已同步（${src}，${n} 字段，token ${fp} 不变）`);
      }
      return $done({});
    }

    // 3) 完全一致 → 心跳，6 小时一条
    const lastSeen = parseInt(read(KEY_SEEN) || "0", 10) || 0;
    if (now - lastSeen >= SEEN_COOLDOWN_MS) {
      write(KEY_SEEN, now);
      notify("采集在跑", `token ${fp} 未轮换（${n} 字段）——若主脚本报登录态，请退出拼多多重新登录一次`);
    }
    console.log(`[PDDcookie] 未变化（${src}，token ${fp}）`);
  } catch (e) {
    console.log(`[PDDcookie] 异常 ${e}`);
  }
  $done({});
})();
