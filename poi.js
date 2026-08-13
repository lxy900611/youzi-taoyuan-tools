/* 大桃園周邊機能地圖 — 柚子（林顯祐）製作
 * 機能資料來源：OpenStreetMap（Overpass API 即時查詢，社群協作維護，非柚子自行編輯）
 * 地址查詢：見 geocode.js（門牌坐標資料優先，Nominatim 備援）
 */

const CONTACT = {
  name: "林顯祐（柚子）",
  tel: "0968877611",
  agency: "巨業不動產經紀有限公司",
  line: "https://line.me/ti/p/1oOrGNBjI6"
};
// 免費公用服務偶爾會忙碌逾時，主機掛了就換一個鏡像站重試
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter"
];
const SEARCH_RADIUS_M = 1200;
const MAX_SHOW = 12;

const CATS = [
  { key: "market",      label: "市場",     icon: "🥬", filters: [["shop", "marketplace"]] },
  { key: "super",       label: "超市/量販", icon: "🛒", filters: [["shop", "supermarket"], ["shop", "department_store"]] },
  { key: "food",        label: "小吃/餐廳", icon: "🍜", filters: [["amenity", "restaurant"], ["amenity", "fast_food"], ["amenity", "food_court"]] },
  { key: "conv",        label: "超商",     icon: "🏪", filters: [["shop", "convenience"]] },
  { key: "bus",         label: "公車站",   icon: "🚌", filters: [["highway", "bus_stop"]] },
  { key: "rail",        label: "火車/捷運", icon: "🚆", filters: [["railway", "station"], ["railway", "halt"]] },
  { key: "parking",     label: "停車場",   icon: "🅿️", filters: [["amenity", "parking"]] },
  { key: "medical",     label: "醫療",     icon: "🏥", filters: [["amenity", "hospital"], ["amenity", "clinic"], ["amenity", "doctors"], ["amenity", "pharmacy"]] },
  { key: "bank",        label: "銀行/郵局", icon: "🏦", filters: [["amenity", "bank"], ["amenity", "post_office"]] },
  { key: "park",        label: "公園",     icon: "🌳", filters: [["leisure", "park"]] },
  { key: "interchange", label: "交流道",   icon: "🛣️", filters: [["highway", "motorway_junction"]] }
];

let map = null;
let currentPin = null;
let originPoint = null;
let originLabel = "";
let curCat = CATS[0].key;
let resultsByCat = {}; // key -> [{name,lat,lng,dist}]
let markerLayer = null;

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

/* ================= 距離 ================= */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function distText(d) {
  return d < 1000 ? Math.round(d) + " 公尺" : (d / 1000).toFixed(1) + " 公里";
}
function navHref(lat, lng) {
  const org = originPoint ? `&origin=${originPoint.lat},${originPoint.lng}` : "";
  return `https://www.google.com/maps/dir/?api=1${org}&destination=${lat},${lng}`;
}

/* ================= Overpass 查詢 ================= */
function buildOverpassQuery(lat, lng, radius) {
  const parts = [];
  CATS.forEach(cat => {
    cat.filters.forEach(([k, v]) => {
      parts.push(`node["${k}"="${v}"](around:${radius},${lat},${lng});`);
      parts.push(`way["${k}"="${v}"](around:${radius},${lat},${lng});`);
    });
  });
  return `[out:json][timeout:25];(${parts.join("")});out center tags;`;
}
function classify(tags) {
  for (const cat of CATS) {
    for (const [k, v] of cat.filters) {
      if (tags[k] === v) return cat.key;
    }
  }
  return null;
}
async function fetchOverpass(q) {
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q)
      });
      if (!res.ok) throw new Error("overpass http " + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("overpass all endpoints failed");
}
async function queryNearby(lat, lng) {
  const q = buildOverpassQuery(lat, lng, SEARCH_RADIUS_M);
  const j = await fetchOverpass(q);
  const grouped = {};
  CATS.forEach(c => grouped[c.key] = []);
  (j.elements || []).forEach(el => {
    const tags = el.tags || {};
    const key = classify(tags);
    if (!key) return;
    const plat = el.type === "node" ? el.lat : (el.center && el.center.lat);
    const plng = el.type === "node" ? el.lon : (el.center && el.center.lon);
    if (plat == null || plng == null) return;
    const name = tags.name || tags["name:zh"] || tags["name:zh-Hant"] || catLabel(key) + "（無店名資料）";
    grouped[key].push({ name, lat: plat, lng: plng, dist: haversine(lat, lng, plat, plng) });
  });
  Object.values(grouped).forEach(arr => arr.sort((a, b) => a.dist - b.dist));
  return grouped;
}
function catLabel(key) { return (CATS.find(c => c.key === key) || {}).label || key; }
function catIcon(key) { return (CATS.find(c => c.key === key) || {}).icon || "📍"; }

/* ================= 分類列 ================= */
function renderCatRow() {
  const row = document.getElementById("catRow");
  row.innerHTML = CATS.map(c =>
    `<button data-key="${c.key}" class="${c.key === curCat ? "on" : ""}">${c.icon} ${c.label}</button>`
  ).join("");
  row.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      curCat = btn.dataset.key;
      row.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === btn));
      if (originPoint) { drawMarkers(); renderPanel(); }
    };
  });
}

/* ================= 標記與面板 ================= */
function drawMarkers() {
  if (markerLayer) { map.removeLayer(markerLayer); markerLayer = null; }
  const list = (resultsByCat[curCat] || []).slice(0, MAX_SHOW);
  const g = L.layerGroup();
  list.forEach((p, i) => {
    L.marker([p.lat, p.lng], { icon: L.divIcon({
      className: "", iconAnchor: [15, 15],
      html: `<div style="width:30px;height:30px;border-radius:50%;background:${i === 0 ? "var(--amber)" : "#0b5d52"};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 6px rgba(0,0,0,.35);border:2px solid #fff">${catIcon(curCat)}</div>`
    }) }).bindPopup(`<b>${esc(p.name)}</b><br>${distText(p.dist)}`).addTo(g);
  });
  g.addTo(map);
  markerLayer = g;
}
function esc(s) { return (s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderPanel() {
  const list = resultsByCat[curCat] || [];
  const panel = document.getElementById("resultPanel");
  let html = `<div class="rTitle">📍 ${esc(originLabel)}</div>
    <div class="rAddr">${SEARCH_RADIUS_M} 公尺內的${catLabel(curCat)}</div>`;
  if (!list.length) {
    html += `<div class="rSummary warn">這個範圍內查不到${catLabel(curCat)}的OSM資料，不代表現場真的沒有——OpenStreetMap是社群協作地圖，部分小店家可能還沒被標註。</div>`;
  } else {
    html += list.slice(0, MAX_SHOW).map((p, i) => `<div class="poiCard${i === 0 ? " best" : ""}">
      <div class="picon">${catIcon(curCat)}</div>
      <div style="flex:1;min-width:0">
        <div class="pnm">${i === 0 ? `<span class="bestbadge">最近</span>` : ""}${esc(p.name)}</div>
        <div class="pd">${distText(p.dist)}</div>
      </div>
      <a class="navBtn" href="${navHref(p.lat, p.lng)}" target="_blank" rel="noopener"><span>🧭</span>導航</a>
    </div>`).join("");
    if (list.length > MAX_SHOW) html += `<div class="rAddr" style="margin-top:6px">還有 ${list.length - MAX_SHOW} 筆較遠的結果沒列出</div>`;
  }
  html += `<div class="disclaimer">機能資料來自 <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a> 社群協作地圖即時查詢，非柚子自行維護，可能有遺漏或過期，實際請以現場為準。距離為直線估算。</div>`;
  html += `<div class="ctaHead">🏡 想在這附近找房？柚子幫你把關：</div>
  <div class="ctaGrid">
    <a class="cLine" href="${CONTACT.line}" target="_blank" rel="noopener">💬 加LINE諮詢</a>
    <a class="cTel" href="tel:${CONTACT.tel}">📞 打給林顯祐</a>
  </div>`;
  document.getElementById("panelBody").innerHTML = html;
  panel.classList.add("open");
  panel.classList.remove("collapsed");
}
function closePanel() {
  document.getElementById("resultPanel").classList.remove("open");
}

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
  showMsg("查詢附近機能中…（第一次查詢可能要等10幾秒）", 30000);
  try {
    resultsByCat = await queryNearby(lat, lng);
    document.getElementById("msgBox").style.display = "none";
    drawMarkers();
    renderPanel();
  } catch (e) {
    showMsg("機能查詢服務暫時忙碌，請稍後再試一次");
  }
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

initMap();
renderCatRow();
fetch("data/address_points.json").then(r => r.json()).then(loadAddressPoints)
  .catch(() => showMsg("門牌資料載入失敗，可改用GPS定位查詢"));
