/* 大桃園垃圾車地圖 — 柚子（林顯祐）製作
 * 清運點與班表來源：桃園市政府環境管理處「垃圾清運路線即時查詢系統」，
 * 透過本專案的 server.py 小型代理伺服器轉發（該系統未開放跨網站直接呼叫）。
 * 地址查詢：見 geocode.js（本地門牌坐標資料優先，比對方自己的定位更準）。
 */

const CONTACT = {
  name: "林顯祐（柚子）",
  tel: "0968877611",
  agency: "巨業不動產經紀有限公司",
  line: "https://line.me/ti/p/1oOrGNBjI6"
};
const TRASH_PROXY = "https://youzi-taoyuan-tools.onrender.com";
const RANGE_OPTIONS = [300, 400, 500];

let map = null;
let currentPin = null;
let originPoint = null;
let originLabel = "";
let carType = "lagi"; // lagi=垃圾車 / recycle=資收車
let curRange = 300;
let pts = [];
let ptLayer = null;

/* ================= 地圖 ================= */
function initMap() {
  map = L.map("map", { zoomControl: false }).setView([24.965, 121.225], 13);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
    maxZoom: 19
  }).addTo(map);
}
function pinIcon() {
  return L.divIcon({ className: "", iconAnchor: [15, 40], html:
    `<svg width="30" height="42" viewBox="0 0 30 42" style="filter:drop-shadow(0 3px 4px rgba(0,0,0,.4))">
      <path d="M15 41C15 41 28 24.5 28 14.5C28 7 22.2 1.5 15 1.5C7.8 1.5 2 7 2 14.5C2 24.5 15 41 15 41Z"
        fill="#0b5d52" stroke="#e8734a" stroke-width="2.2"/>
      <circle cx="15" cy="14.5" r="5" fill="#fff"/>
      <circle cx="15" cy="14.5" r="2.2" fill="#e8734a"/>
    </svg>` });
}
function placePin(lat, lng) {
  if (currentPin) map.removeLayer(currentPin);
  currentPin = L.marker([lat, lng], { icon: pinIcon(), zIndexOffset: 1000 }).addTo(map);
  originPoint = { lat, lng };
}
function navHref(lat, lng) {
  const org = originPoint ? `&origin=${originPoint.lat},${originPoint.lng}` : "";
  return `https://www.google.com/maps/dir/?api=1${org}&destination=${lat},${lng}`;
}
function distText(d) { return d < 1000 ? Math.round(d) + " 公尺" : (d / 1000).toFixed(1) + " 公里"; }
function walkMin(d) { return Math.max(1, Math.round(d / 70)); } // 約每分鐘70公尺
function esc(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ================= 分段控制 ================= */
function renderRangeRow() {
  const row = document.getElementById("rangeRow");
  row.innerHTML = RANGE_OPTIONS.map(r => `<button data-r="${r}" class="${r === curRange ? "on" : ""}">${r}公尺</button>`).join("");
  row.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      curRange = parseInt(btn.dataset.r, 10);
      row.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
      if (originPoint) queryPoints();
    };
  });
}

/* ================= 查詢清運點（透過代理伺服器） ================= */
async function queryPoints() {
  if (!originPoint) return;
  showMsg("查詢垃圾車清運點中…", 10000);
  try {
    const url = `${TRASH_PROXY}/api/trash-poi?lat=${originPoint.lat.toFixed(6)}&lng=${originPoint.lng.toFixed(6)}&range=${curRange}&car_type=${carType}`;
    const res = await fetch(url);
    const j = await res.json();
    if (!j.ok) { showMsg(j.msg || "查詢失敗，請稍後再試"); return; }
    document.getElementById("msgBox").style.display = "none";
    pts = (j.pts || []).slice().sort((a, b) => a.d - b.d);
    drawPoints();
    renderPanel();
  } catch (e) {
    showMsg("垃圾車查詢服務暫時無法使用，可能是代理伺服器沒有啟動，請稍後再試");
  }
}
function drawPoints() {
  if (ptLayer) { map.removeLayer(ptLayer); ptLayer = null; }
  const g = L.layerGroup();
  const color = carType === "recycle" ? "#2b8a3e" : "#c0392b";
  const icon = carType === "recycle" ? "♻️" : "🚛";
  pts.forEach(p => {
    const timeLabel = carType === "recycle" ? p.recycle_arrive : p.arrive;
    L.marker([p.lat, p.lng], { icon: L.divIcon({
      className: "", iconAnchor: [15, 15],
      html: `<div style="width:30px;height:30px;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 6px rgba(0,0,0,.35);border:2px solid #fff">${icon}</div>`
    }) }).bindPopup(`<b>${icon} ${esc(p.n)}</b>${p.li ? `<br><small>${esc(p.li)}</small>` : ""}<br>${timeLabel ? "班表時間：" + timeLabel : "班表資料不足"}`).addTo(g);
  });
  g.addTo(map);
  ptLayer = g;
}

/* ================= 面板 ================= */
function copyText() {
  if (!pts.length) return "";
  const p = pts[0];
  const timeLabel = carType === "recycle" ? p.recycle_arrive : p.arrive;
  const lines = [];
  lines.push(`【${carType === "recycle" ? "資源回收車" : "垃圾車"}資訊】${originLabel}`);
  lines.push(`最近清運點：${p.n}${p.li ? `（${p.li}）` : ""}，走路約 ${walkMin(p.d)} 分鐘（直線 ${p.d} 公尺）`);
  if (timeLabel) lines.push(`班表時間：${timeLabel}`);
  lines.push(`（班表來源：桃園市環境管理處，僅供參考）`);
  return lines.join("\n");
}
function renderPanel() {
  const panel = document.getElementById("resultPanel");
  const icon = carType === "recycle" ? "♻️" : "🚛";
  const name = carType === "recycle" ? "資收車" : "垃圾車";
  let html = `<div class="rTitle">📍 ${esc(originLabel)}</div>
    <div class="rAddr">${curRange} 公尺內的${name}清運點</div>`;
  if (!pts.length) {
    html += `<div class="rSummary warn">這個範圍內查不到${name}清運點。可以把範圍調大再試；如果住的是有垃圾房或子母車的社區大樓，本來就是由清潔隊或廠商定點收運，不用追垃圾車。</div>`;
  } else {
    html += `<button class="copyBtn" id="copyBtn">📋 複製最近清運點資訊（可直接貼 LINE）</button>`;
    html += pts.map((p, i) => {
      const timeLabel = carType === "recycle" ? p.recycle_arrive : p.arrive;
      const realNote = p.real_time ? `<span style="color:var(--red)">（今日實際約 ${esc(p.real_time)}）</span>` : "";
      return `<div class="trashCard${i === 0 ? " best" : ""}">
        <div class="ticon">${icon}</div>
        <div style="flex:1;min-width:0">
          <div class="tnm">${i === 0 ? `<span class="bestbadge">最近</span>` : ""}${esc(p.n)}${p.li ? `<small>（${esc(p.li)}）</small>` : ""}</div>
          <div class="td">${distText(p.d)}・走路約 ${walkMin(p.d)} 分</div>
          <div class="ttime">${timeLabel ? "⏰ " + timeLabel + realNote : "班表資料不足"}</div>
        </div>
        <a class="navBtn" href="${navHref(p.lat, p.lng)}" target="_blank" rel="noopener"><span>🧭</span>導航</a>
      </div>`;
    }).join("");
  }
  html += `<div class="disclaimer">班表與清運點來源：<a href="https://route.tyoem.gov.tw/" target="_blank" rel="noopener">桃園市環境管理處垃圾清運路線即時查詢系統</a>，班次可能因天候、國定假日或路線調整異動，請以官方公告為準。距離為直線估算。</div>`;
  html += `<div class="ctaHead">🏡 想找不用煩惱倒垃圾動線的房子？柚子幫你把關：</div>
  <div class="ctaGrid">
    <a class="cLine" href="${CONTACT.line}" target="_blank" rel="noopener">💬 加LINE諮詢</a>
    <a class="cTel" href="tel:${CONTACT.tel}">📞 打給林顯祐</a>
  </div>`;
  document.getElementById("panelBody").innerHTML = html;
  panel.classList.add("open");
  panel.classList.remove("collapsed");
  const cb = document.getElementById("copyBtn");
  if (cb) cb.onclick = async () => {
    try { await navigator.clipboard.writeText(copyText()); showMsg("已複製，直接貼到 LINE 就能傳"); }
    catch (e) { showMsg("複製失敗，請長按文字手動複製"); }
  };
}
function closePanel() { document.getElementById("resultPanel").classList.remove("open"); }

/* ================= 提示 ================= */
function showMsg(text, ms) {
  const box = document.getElementById("msgBox");
  box.innerHTML = text;
  box.style.display = "block";
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.style.display = "none", ms || 3600);
}

/* ================= 查詢流程 ================= */
async function runSearch(lat, lng, label) {
  placePin(lat, lng);
  originLabel = label;
  map.setView([lat, lng], 16);
  await queryPoints();
}
async function searchAddress() {
  const district = document.getElementById("selDistrict").value;
  const raw = document.getElementById("addrInput").value.trim();
  if (!district) { showMsg("請先選地區"); return; }
  if (!raw) { showMsg("請輸入路名門牌"); return; }
  showMsg("查詢中…", 12000);
  const result = await resolveAddress(district, raw);
  if (result.error) { showMsg(result.error); return; }
  if (result.approx) showMsg("⚠️ 查不到這個確切門牌，" + result.approxNote, 5000);
  await runSearch(result.lat, result.lng, result.label);
}
function locateMe() {
  if (!navigator.geolocation) { showMsg("這個瀏覽器不支援定位"); return; }
  const btn = document.getElementById("gpsBtn");
  btn.classList.add("busy");
  showMsg("定位中…", 12000);
  navigator.geolocation.getCurrentPosition(pos => {
    btn.classList.remove("busy");
    runSearch(pos.coords.latitude, pos.coords.longitude, "📍 目前位置");
  }, err => {
    btn.classList.remove("busy");
    showMsg(err.code === 1 ? "你沒有開放定位權限，請改用輸入地址查詢" : "定位失敗，可改用輸入地址查詢");
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

/* ================= 底部面板手勢 ================= */
(function initDrawerGesture() {
  const panel = document.getElementById("resultPanel");
  const handle = document.getElementById("panelHandle");
  let startY = null, moved = false;
  handle.addEventListener("touchstart", e => { startY = e.touches[0].clientY; moved = false; }, { passive: true });
  handle.addEventListener("touchmove", e => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 30) { panel.classList.add("collapsed"); moved = true; startY = null; }
    else if (dy < -30) { panel.classList.remove("collapsed"); moved = true; startY = null; }
  }, { passive: true });
  handle.addEventListener("touchend", () => { startY = null; });
  handle.addEventListener("click", () => { if (!moved) panel.classList.toggle("collapsed"); moved = false; });
})();

/* ================= 事件綁定與啟動 ================= */
document.getElementById("selDistrict").onchange = () => {
  const on = !!document.getElementById("selDistrict").value;
  document.getElementById("addrInput").disabled = !on;
  document.getElementById("addrInput").placeholder = on ? "只要打路名門牌，例：中山路100號" : "③ 選好地區後，輸入路名門牌";
};
document.getElementById("searchBtn").onclick = searchAddress;
document.getElementById("addrInput").addEventListener("keydown", e => { if (e.key === "Enter") searchAddress(); });
document.getElementById("gpsBtn").onclick = locateMe;
document.getElementById("segTrash").onclick = () => setCarType("lagi");
document.getElementById("segRecycle").onclick = () => setCarType("recycle");
function setCarType(type) {
  carType = type;
  document.getElementById("segTrash").classList.toggle("on", type === "lagi");
  document.getElementById("segRecycle").classList.toggle("on", type === "recycle");
  if (originPoint) queryPoints();
}

initMap();
renderRangeRow();
fetch("/data/address_points.json").then(r => r.json()).then(loadAddressPoints)
  .catch(() => showMsg("門牌資料載入失敗，可改用GPS定位查詢"));
