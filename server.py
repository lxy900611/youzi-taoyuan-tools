# -*- coding: utf-8 -*-
"""
垃圾車清運點小型代理伺服器
用途：桃園市環境管理處「垃圾清運路線即時查詢系統」(route.tyoem.gov.tw) 只設計給
     自家網頁用（沒有開放 CORS 給其他網站呼叫），所以前端沒辦法直接打它的 API。
     這支伺服器代替瀏覽器，在後端呼叫該系統、把資料轉成乾淨的 JSON 回傳給我們自己的前端。

風險提醒（寫在這裡是因為這是技術文件，不是要嚇唬使用者）：
- 這是逆向工程找出來的內部介面，官方沒有正式公告、沒有授權條款，可能隨時改版失效。
- 使用者已經確認接受這個風險（見專案對話紀錄），正式上線前建議向桃園市環境管理處確認使用許可。
"""
import os
import re
import ssl
import time
import threading
from flask import Flask, request, jsonify
import requests
from requests.adapters import HTTPAdapter

app = Flask(__name__)

TYOEM_BASE = "https://route.tyoem.gov.tw"
TYOEM_API = TYOEM_BASE + "/web/dataManagerAgentWeb.jsp"
UA = "Mozilla/5.0 (compatible; yozu-trash-proxy/1.0)"


class LenientX509Adapter(HTTPAdapter):
    """
    route.tyoem.gov.tw 的憑證鏈缺少 Subject Key Identifier 這個 x509v3 擴充欄位，
    新版 OpenSSL（3.2+，較新的部署環境常見）預設用 VERIFY_X509_STRICT 會擋下這種
    憑證，導致 SSLCertVerificationError。這裡只關掉那一項嚴格檢查，其餘憑證驗證
    （信任鏈、網域名稱、有效期限）完全不受影響，仍然是安全的 HTTPS 連線。
    """
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        if hasattr(ssl, "VERIFY_X509_STRICT"):
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)

_session_lock = threading.Lock()
_session = {"http": None, "token": None, "fetched_at": 0}
SESSION_MAX_AGE = 600  # 秒；保守一點，過期就重抓，避免用到失效的 token


def refresh_session():
    s = requests.Session()
    s.mount("https://", LenientX509Adapter())
    r = s.get(TYOEM_BASE + "/", headers={"User-Agent": UA}, timeout=15)
    r.raise_for_status()
    m = re.search(r'id="random_form"[^>]*value="([^"]+)"', r.text)
    if not m:
        raise RuntimeError("找不到 random_form token，對方頁面結構可能改版了")
    with _session_lock:
        _session["http"] = s
        _session["token"] = m.group(1)
        _session["fetched_at"] = time.time()
    return s, m.group(1)


def get_session():
    with _session_lock:
        fresh_enough = _session["http"] is not None and (time.time() - _session["fetched_at"]) < SESSION_MAX_AGE
        if fresh_enough:
            return _session["http"], _session["token"]
    return refresh_session()


def call_tyoem(dcfid, params, retry=True):
    s, token = get_session()
    data = dict(params)
    data["dcfid"] = dcfid
    data["random_form"] = token
    r = s.post(TYOEM_API, data=data, headers={
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest"
    }, timeout=15)
    r.raise_for_status()
    j = r.json()
    if j.get("errCode") not in ("0000",) and retry:
        # token/session 過期，重新登入一次再試一次
        refresh_session()
        return call_tyoem(dcfid, params, retry=False)
    return j


def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.after_request
def add_cors(resp):
    return cors(resp)


@app.route("/api/trash-poi")
def trash_poi():
    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "msg": "缺少或格式錯誤的 lat/lng"}), 400
    rng = request.args.get("range", "300")
    car_type = request.args.get("car_type", "lagi")  # lagi=垃圾車 / recycle=資收車
    if car_type not in ("lagi", "recycle"):
        car_type = "lagi"

    try:
        j = call_tyoem("lagifQueryPoiByAddr", {
            "lat": lat, "lng": lng, "range": rng,
            "car_type": car_type, "trace": "0", "query": "0"
        })
    except Exception as e:
        return jsonify({"ok": False, "msg": "查詢服務忙碌中，請稍後再試（" + str(e) + "）"}), 502

    if j.get("errCode") != "0000":
        return jsonify({"ok": False, "msg": j.get("msg") or "查詢失敗"}), 200

    pts = []
    for row in j.get("result", []):
        pts.append({
            "n": row.get("poi_name"),
            "li": row.get("show_memo"),
            "lat": row.get("lat"),
            "lng": row.get("lng"),
            "d": row.get("dis"),
            "arrive": row.get("arrive_time"),
            "recycle_arrive": row.get("recycle_arrive_time"),
            "real_time": row.get("real_time"),
            "route": row.get("routing_name")
        })
    return jsonify({"ok": True, "pts": pts})


NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
NOTION_LEAD_DB_ID = "72c3a789-4294-41fa-8efc-a1eb717b04ca"  # 免費行情評估名單
NOTION_VERSION = "2022-06-28"
LEAD_TOPIC_OPTIONS = {"稅務問題", "行情評估", "貸款／自備款規劃", "屋況／驗屋建議", "賣屋流程", "其他"}

GMAIL_USER = os.environ.get("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
NOTIFY_EMAIL_TO = os.environ.get("NOTIFY_EMAIL_TO", "")


def send_lead_notification_email(name, phone, line_id, address, topics):
    """新名單寫進 Notion 後，順便寄一封通知信。三個環境變數沒設定齊全就直接跳過，
    不會讓表單送出失敗——email 通知是錦上添花，Notion 才是主要紀錄。"""
    if not (GMAIL_USER and GMAIL_APP_PASSWORD and NOTIFY_EMAIL_TO):
        return
    import smtplib
    from email.mime.text import MIMEText

    topics_text = "、".join(topics) if topics else "（未選擇）"
    body = (
        f"姓名：{name}\n"
        f"電話：{phone}\n"
        f"LINE ID：{line_id or '（未填）'}\n"
        f"位置：{address or '（未填）'}\n"
        f"諮詢項目：{topics_text}\n"
        f"\n完整名單請見 Notion「免費行情評估名單」資料庫。"
    )
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = f"【新名單】{name} - 免費行情評估"
    msg["From"] = GMAIL_USER
    msg["To"] = NOTIFY_EMAIL_TO
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=10) as smtp:
            smtp.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            smtp.sendmail(GMAIL_USER, [NOTIFY_EMAIL_TO], msg.as_string())
    except Exception:
        pass


@app.route("/api/lead-submit", methods=["POST", "OPTIONS"])
def lead_submit():
    if request.method == "OPTIONS":
        return ("", 204)

    if not NOTION_TOKEN:
        return jsonify({"ok": False, "msg": "伺服器尚未設定 Notion 金鑰，請直接聯絡柚子"}), 500

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    phone = (data.get("phone") or "").strip()
    line_id = (data.get("line_id") or "").strip()
    address = (data.get("address") or "").strip()
    topics_in = data.get("topics") or []

    if not name or not phone:
        return jsonify({"ok": False, "msg": "姓名和電話為必填"}), 400
    if not isinstance(topics_in, list):
        topics_in = []
    topics = [t for t in topics_in if isinstance(t, str) and t in LEAD_TOPIC_OPTIONS][:10]

    payload = {
        "parent": {"database_id": NOTION_LEAD_DB_ID},
        "properties": {
            "姓名": {"title": [{"text": {"content": name[:200]}}]},
            "電話": {"phone_number": phone[:50]},
            "LINE ID": {"rich_text": [{"text": {"content": line_id[:200]}}]},
            "諮詢地址或地號": {"rich_text": [{"text": {"content": address[:500]}}]},
            "諮詢項目": {"multi_select": [{"name": t} for t in topics]},
            "處理狀態": {"select": {"name": "未聯絡"}},
            "來源": {"rich_text": [{"text": {"content": "中壢房產顧問柚子官網"}}]},
        },
    }
    try:
        r = requests.post(
            "https://api.notion.com/v1/pages",
            headers={
                "Authorization": f"Bearer {NOTION_TOKEN}",
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        r.raise_for_status()
    except Exception as e:
        return jsonify({"ok": False, "msg": "送出失敗，麻煩直接加 LINE 聯絡柚子（" + str(e) + "）"}), 502

    send_lead_notification_email(name, phone, line_id, address, topics)
    return jsonify({"ok": True})


NOTION_AGENT_DB_ID = "34323628-0001-4646-a504-84c43c40d6e4"  # 同事名單


@app.route("/api/agent-add", methods=["POST", "OPTIONS"])
def agent_add():
    if request.method == "OPTIONS":
        return ("", 204)

    if not NOTION_TOKEN:
        return jsonify({"ok": False, "msg": "伺服器尚未設定 Notion 金鑰"}), 500

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    tel = (data.get("tel") or "").strip()
    line = (data.get("line") or "").strip()
    link = (data.get("link") or "").strip()
    page_id = (data.get("page_id") or "").strip()

    if not name:
        return jsonify({"ok": False, "msg": "姓名為必填"}), 400

    properties = {
        "姓名": {"title": [{"text": {"content": name[:200]}}]},
        "電話": {"phone_number": tel[:50] if tel else None},
        "LINE": {"rich_text": [{"text": {"content": line[:200]}}] if line else []},
        "生成的連結": {"url": link[:2000] if link else None},
    }

    try:
        if page_id:
            r = requests.patch(
                f"https://api.notion.com/v1/pages/{page_id}",
                headers={
                    "Authorization": f"Bearer {NOTION_TOKEN}",
                    "Notion-Version": NOTION_VERSION,
                    "Content-Type": "application/json",
                },
                json={"properties": properties},
                timeout=15,
            )
        else:
            r = requests.post(
                "https://api.notion.com/v1/pages",
                headers={
                    "Authorization": f"Bearer {NOTION_TOKEN}",
                    "Notion-Version": NOTION_VERSION,
                    "Content-Type": "application/json",
                },
                json={"parent": {"database_id": NOTION_AGENT_DB_ID}, "properties": properties},
                timeout=15,
            )
        r.raise_for_status()
        result = r.json()
    except Exception as e:
        return jsonify({"ok": False, "msg": "同步 Notion 失敗（" + str(e) + "）"}), 502

    return jsonify({"ok": True, "page_id": result.get("id")})


@app.route("/api/health")
def health():
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8767))
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    app.run(host=host, port=port, debug=False)
