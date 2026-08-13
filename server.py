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
import re
import time
import threading
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

TYOEM_BASE = "https://route.tyoem.gov.tw"
TYOEM_API = TYOEM_BASE + "/web/dataManagerAgentWeb.jsp"
UA = "Mozilla/5.0 (compatible; yozu-trash-proxy/1.0)"

_session_lock = threading.Lock()
_session = {"http": None, "token": None, "fetched_at": 0}
SESSION_MAX_AGE = 600  # 秒；保守一點，過期就重抓，避免用到失效的 token


def refresh_session():
    s = requests.Session()
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
    resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
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


@app.route("/api/health")
def health():
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8767, debug=False)
