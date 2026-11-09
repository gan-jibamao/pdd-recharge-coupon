# 接口契约

从 2026-11-09 23:59 → 00:04 的真机抓包还原。App 版本 8.30.0，页面 `https://m.pinduoduo.net/charge_sign_coupon.html`。

## 基地址

```
https://m.pinduoduo.net/proxy/api/api
```

三个接口都是 `POST`，`content-type: application/json`。

## 1. 查询状态

```
POST /aurum/check_in/task/query
{"request_source":1}
```

响应（截断）：

```json
{
  "success": true,
  "result": {
    "task_name": "领30元话费券",
    "task_id": "MT842261794981770892",
    "task_template_id": "1",
    "finish_count": 5,
    "gain_award_count": 5,
    "display_status": 30,
    "sub_tile": [
      {"text": "已连续打卡5天", "type": 1, "percent": null},
      {"text": "今日券已领21", "type": 3, "percent": 21}
    ],
    "sub_task_list": [
      {"check_in_button": {"content": [{"text": "立即领券"}], "can_click": true}}
    ],
    "gain_award_button": {"content": [{"text": "发放中"}], "can_click": false},
    "award_content": {"award_price": "30", "award_name": "平台补贴", "award_threshold": "满200可用"}
  }
}
```

### display_status

| 值 | 含义 |
|---|---|
| 30 | 可领（当日已开放） |
| 31 | 今日已领 / 已抢完，按钮显示「明日再来」 |
| 32 / 33 | 领取中（未实测） |
| 40 | 已领取 |

`sub_tile[1].percent` 是当日发放进度，零点归零，实测每秒涨 1~2%，到 `100` 即当日结束。

## 2. 签到

```
POST /aurum/check_in/task/sub_task/finish
{"task_id":"MT842261794981770892","task_template_id":"1","request_source":1}
```

今日已签时返回 `6070004 不能签到`。

## 3. 领券

```
POST /aurum/check_in/task/gain/award
{"task_id":"MT842261794981770892","request_source":1}
```

请求体逐字节如上，**没有 `anti_content`**。页面 JS 里写着 `risk:true`，但真机发出的请求体是干净的——那套风控只在别处生效。

## 鉴权

只靠 Cookie。必需的四个字段：

| 字段 | 说明 |
|---|---|
| `PDDAccessToken` | 59 字符，登录态本体 |
| `pdd_user_id` | 数字 UID |
| `pdd_user_uin` | 用户标识 |
| `_nano_fp` | 设备指纹 |

必需请求头：

```
content-type: application/json
referer: https://m.pinduoduo.net/charge_sign_coupon.html
```

没有 `AccessToken` 头。

## 错误码

| code | errorMsg | 语义 | 正确处理 |
|---|---|---|---|
| `6071002` | 请稍后重试，活动太火爆了 | **券已发完** | 停手 |
| `6070006` | 券已抢完，请明日再来 | 券已发完 | 停手 |
| `4000004` | RATE_LIMIT_EXCEED_EXCEPTION | 频率超限 | 秒级退避 |
| `6070004` | 不能签到 | 今日已签 | 视为已落地 |
| `40001` | （空） | 登录态 / 风控拒绝 | 停手，重新采集 Cookie |

`6071002` 与 `6071001` 不是一个东西：前者在券池 100% 时稳定复现，后者才是真的「活动火爆」。混淆二者会导致对一个死池连续重试。

## 时间源

```
GET /proxy/api/api/server/_stm
{"server_time":1794240280360}
```

毫秒时间戳。实测本机与服务器偏差约 40ms（含单程 RTT）。

## 零点窗口实测时间线

| 相对零点 | 事件 |
|---|---|
| −3s ~ −1s | 页面每拍 3 个请求轮询 `query` |
| 00:00:00 | `display_status` 31 → 30，`percent` 归零 |
| +1s | **3 条 award 同秒并发** + 1 条 query，全部 `4000004` |
| +2s ~ +7s | 每秒 1 发 award，全部 `4000004` |
| +8s ~ +26s | 只剩 query，每拍成功 |
| +26s | 第 11 发 award，仍 `4000004`；`percent` = 21 |
| +7min | 单发 award → `6071002`（**限流已解除**） |
| +4min | `percent` = 100，当日结束 |

结论：限流按次数累计而非按秒；券池是分钟级寿命；密集重试会延长封锁。

## 未验证

- `T+1050ms` 首发时刻。两次历史命中都在 T+1.0~1.3s，但 11-10 那一秒被并发污染，既不能证实也不能证伪。
- 是否绑定出口 IP。规则层面做了 `DOMAIN-SUFFIX,pinduoduo.net,DIRECT` 规避共享代理出口。
- 跨版本字段稳定性。以上全部来自 8.30.0。
