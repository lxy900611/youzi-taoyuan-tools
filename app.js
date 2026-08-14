/* 大桃園學區地圖 — 柚子（林顯祐）製作
 * 學區資料來源：桃園市政府教育局 115學年度國中小學區一覽表（114-12-31公告）
 * 村里界資料來源：內政部國土測繪中心 村(里)界圖(TWD97經緯度)
 * 门牌坐標資料來源：桃園市政府「門牌位置坐標資料」開放資料（115年6月，戶政事務所人工套圖標點）
 * 地址查詢：優先用門牌坐標資料本地比對（精確到門牌），查不到才退回 OpenStreetMap Nominatim（免費地理編碼服務）
 */

const CONTACT = {
  name: "林顯祐（柚子）",
  tel: "0968877611",
  telShow: "0968-877-611",
  agency: "巨業不動產經紀有限公司",
  line: "https://line.me/ti/p/1oOrGNBjI6"
};

let LEVEL = "elem";
let villageGeo = null;
let zoneData = null;
let polygonByKey = {};
let zoneIndex = {};      // level -> "town|里" -> [{school,home,tel,range,free}]
let schoolColorMap = {}; // level -> school -> css color
let labelGroup = null;
let currentPin = null;
let originPoint = null;

const map = L.map("map", { zoomControl: false }).setView([24.965, 121.225], 12);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19
}).addTo(map);

/* ================= 資料索引 ================= */
function buildZoneIndex() {
  zoneIndex = { elem: {}, jr: {} };
  schoolColorMap = { elem: {}, jr: {} };
  for (const level of ["elem", "jr"]) {
    const namesSeen = [];
    for (const [town, districtData] of Object.entries(zoneData.districts)) {
      for (const school of districtData[level]) {
        if (!namesSeen.includes(school.name)) namesSeen.push(school.name);
        for (const zoneEntry of school.zones) {
          const key = town + "|" + zoneEntry.v + "里";
          (zoneIndex[level][key] = zoneIndex[level][key] || []).push({
            school: school.name, home: school.home, tel: school.tel,
            range: zoneEntry.r, free: zoneEntry.f
          });
        }
      }
    }
    namesSeen.forEach((name, i) => {
      const hue = Math.round(i * 137.508) % 360;
      const light = 56 + (i % 3) * 8;
      schoolColorMap[level][name] = `hsl(${hue},58%,${light}%)`;
    });
  }
}

function villageInfo(key) {
  const entries = zoneIndex[LEVEL][key] || [];
  const fixed = entries.filter(e => !e.free);
  const freeOnes = entries.filter(e => e.free);
  const schools = [...new Set(fixed.map(e => e.school))];
  let primary = null;
  if (schools.length) {
    const wholeVill = fixed.find(e => e.range === "");
    primary = wholeVill ? wholeVill.school : fixed[0].school;
  }
  return { entries, fixed, freeOnes, schools, primary, split: schools.length > 1 };
}

function polygonStyle(feature) {
  const key = feature.properties.town + "|" + feature.properties.vill;
  const info = villageInfo(key);
  if (!info.primary) return { color: "#9aa8a2", weight: 1, fillColor: "#d8ded9", fillOpacity: .3 };
  return {
    color: "#2c3e3a",
    weight: info.split ? 1.6 : 1,
    dashArray: info.split ? "4 3" : null,
    fillColor: schoolColorMap[LEVEL][info.primary],
    fillOpacity: info.split ? .4 : .56
  };
}

/* ================= 面板渲染 ================= */
function fmtRange(r) { return r === "" ? "全里" : "第 " + r + " 鄰"; }

function schoolCard(entry) {
  const color = schoolColorMap[LEVEL][entry.school] || "#ccc";
  const freeTag = entry.free ? `<span class="tagFree">自由學區</span>` : "";
  const telHtml = entry.tel ? `<small>☎ ${entry.tel.startsWith("0") ? entry.tel : "03-" + entry.tel}</small>` : "";
  const cleanName = entry.school.replace(/（[^）]*）/g, "");
  const dest = encodeURIComponent("桃園市" + entry.home + cleanName);
  const originParam = originPoint ? `&origin=${originPoint.lat},${originPoint.lng}` : "";
  return `<div class="schoolCard">
    <span class="swatch" style="background:${color}"></span>
    <div><div class="snm">${entry.school}${entry.home ? `<small>（${entry.home}）</small>` : ""}${telHtml}${freeTag}</div>
    <div class="srng">${fmtRange(entry.range)}</div></div>
    <a class="navBtn" href="https://www.google.com/maps/dir/?api=1${originParam}&destination=${dest}" target="_blank" rel="noopener"><span>🧭</span>導航</a>
  </div>`;
}

function showResult(town, vill, matchedAddr) {
  const key = town + "|" + vill;
  const info = villageInfo(key);
  const levelName = LEVEL === "elem" ? "國小" : "國中";
  let html = `<div class="rTitle">桃園市${town}${vill}</div>`;
  if (matchedAddr) html += `<div class="rAddr">📍 ${matchedAddr}</div>`;

  if (info.schools.length === 0 && info.freeOnes.length === 0) {
    html += `<div class="rSummary warn">此里在整理的115學年度資料中查無${levelName}學區，請直接洽教育局或學校確認。</div>`;
  } else if (info.schools.length === 1 && info.fixed.every(e => e.range === "" || e.school === info.schools[0])) {
    html += `<div class="rSummary">此里${levelName}學區為 <b>${info.schools[0]}</b>${info.freeOnes.length ? "，另有部分鄰屬<b>自由學區</b>（見下方）" : ""}。</div>`;
  } else if (info.schools.length === 1) {
    html += `<div class="rSummary">此里${levelName}學區主要為 <b>${info.schools[0]}</b>，但依「鄰」有切分${info.freeOnes.length ? "，並有自由學區" : ""}——請對照下方鄰別。</div>`;
  } else {
    html += `<div class="rSummary warn">⚠️ 此里${levelName}<b>依「鄰」分屬不同學校</b>${info.freeOnes.length ? "，部分鄰為自由學區" : ""}，請對照戶口名簿上的「鄰」，或把完整門牌傳給柚子確認。</div>`;
  }

  if (info.fixed.length) {
    html += `<div class="blk"><h3>學區劃分（${levelName}）</h3>` + info.fixed.map(schoolCard).join("") + `</div>`;
  }
  if (info.freeOnes.length) {
    html += `<div class="blk"><h3>自由學區（列出的學校皆可選）</h3>` + info.freeOnes.map(schoolCard).join("") + `</div>`;
  }

  const hasStreetNote = info.entries.some(e => e.range.includes("【"));
  html += `<div class="disclaimer">學區每年可能調整${hasStreetNote ? "，且此里部分鄰有「路段／門牌」細分" : ""}。本圖依教育局115學年度公告獨立整理，僅供參考，正式學區請洽<a href="https://www.tyc.edu.tw/News.aspx?n=5208" target="_blank" rel="noopener">桃園市教育局</a>及學校確認。</div>`;

  const ctaLine = CONTACT.line
    ? `<a class="cLine" href="${CONTACT.line}" target="_blank" rel="noopener">💬 加LINE諮詢</a>`
    : "";
  html += `<div class="ctaHead">🏡 想在這個學區找房？柚子幫你把關：</div>
  <div class="ctaGrid ${CONTACT.line ? "" : "single"}">
    ${ctaLine}
    <a class="cTel" href="tel:${CONTACT.tel}">📞 打給${CONTACT.name.replace(/（.*）/, "")}</a>
  </div>`;

  document.getElementById("panelBody").innerHTML = html;
  const panel = document.getElementById("resultPanel");
  panel.classList.add("open");
  panel.classList.remove("collapsed");

  const poly = polygonByKey[key];
  if (poly) {
    Object.values(polygonByKey).forEach(p => p.setStyle(polygonStyle(p.feature)));
    poly.setStyle({ weight: 3.5, color: "#e8734a", dashArray: null });
    poly.bringToFront();
  }
}
function closePanel() {
  document.getElementById("resultPanel").classList.remove("open");
  Object.values(polygonByKey).forEach(p => p.setStyle(polygonStyle(p.feature)));
}

/* ================= 校名標籤 ================= */
function ringCentroid(ring) {
  let lonSum = 0, latSum = 0;
  ring.forEach(pt => { lonSum += pt[0]; latSum += pt[1]; });
  return [latSum / ring.length, lonSum / ring.length];
}
function biggestRing(geometry) {
  if (geometry.type === "Polygon") return geometry.coordinates[0];
  let best = geometry.coordinates[0][0];
  geometry.coordinates.forEach(poly => { if (poly[0].length > best.length) best = poly[0]; });
  return best;
}
function rebuildLabels() {
  if (labelGroup) { map.removeLayer(labelGroup); labelGroup = null; }
  if (!document.getElementById("chkNames").checked) return;
  if (map.getZoom() < 13) return;
  const pointsBySchool = {};
  for (const feature of villageGeo.features) {
    const key = feature.properties.town + "|" + feature.properties.vill;
    const info = villageInfo(key);
    if (!info.primary) continue;
    const wholeOnly = info.fixed.filter(e => e.range === "").map(e => e.school);
    const target = wholeOnly.length ? wholeOnly[0] : info.primary;
    const c = ringCentroid(biggestRing(feature.geometry));
    (pointsBySchool[target] = pointsBySchool[target] || []).push(c);
  }
  labelGroup = L.layerGroup();
  for (const [school, pts] of Object.entries(pointsBySchool)) {
    const lat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const lng = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    L.marker([lat, lng], {
      icon: L.divIcon({ className: "villLabel", html: `<span>${school}</span>` }),
      interactive: false
    }).addTo(labelGroup);
  }
  labelGroup.addTo(map);
}

/* ================= 地圖圖層 ================= */
function renderPolygons() {
  Object.values(polygonByKey).forEach(p => map.removeLayer(p));
  polygonByKey = {};
  L.geoJSON(villageGeo, {
    style: polygonStyle,
    onEachFeature: (feature, layer) => {
      const key = feature.properties.town + "|" + feature.properties.vill;
      polygonByKey[key] = layer;
      layer.on("click", () => showResult(feature.properties.town, feature.properties.vill));
      layer.on("mouseover", function () { this.setStyle({ fillOpacity: .75 }); });
      layer.on("mouseout", function () { this.setStyle(polygonStyle(feature)); });
      layer.addTo(map);
    }
  });
  rebuildLabels();
}

/* ================= 定位圖釘 ================= */
function pinIcon() {
  return L.divIcon({ className: "", iconAnchor: [15, 40], html:
    `<svg width="30" height="42" viewBox="0 0 30 42" style="filter:drop-shadow(0 3px 4px rgba(0,0,0,.4))">
      <path d="M15 41C15 41 28 24.5 28 14.5C28 7 22.2 1.5 15 1.5C7.8 1.5 2 7 2 14.5C2 24.5 15 41 15 41Z"
        fill="#0b5d52" stroke="#e8734a" stroke-width="2.2"/>
      <circle cx="15" cy="14.5" r="5" fill="#fff"/>
      <circle cx="15" cy="14.5" r="2.2" fill="#e8734a"/>
    </svg>` });
}

/* ================= 點在多邊形內判斷（射線法） ================= */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const hit = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}
function findVillageAt(lat, lng) {
  for (const feature of villageGeo.features) {
    const geom = feature.geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      if (pointInRing(lng, lat, poly[0])) {
        if (poly.slice(1).some(hole => pointInRing(lng, lat, hole))) continue;
        return feature;
      }
    }
  }
  return null;
}

/* ================= 提示訊息 ================= */
function showMsg(text, ms) {
  const box = document.getElementById("msgBox");
  box.innerHTML = text;
  box.style.display = "block";
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.style.display = "none", ms || 3600);
}

/* ================= 地址查詢（用 geocode.js 共用模組） ================= */
async function searchAddress() {
  const district = document.getElementById("selDistrict").value;
  const raw = document.getElementById("addrInput").value.trim();
  if (!district) { showMsg("請先選地區"); return; }
  if (!raw) { showMsg("請輸入路名門牌"); return; }

  showMsg("查詢中…", 12000);
  const result = await resolveAddress(district, raw);
  if (result.error) { showMsg(result.error); return; }

  placePin(result.lat, result.lng);
  const feature = findVillageAt(result.lat, result.lng);
  if (!feature) { showMsg("這個地址不在桃園市服務範圍內"); return; }
  map.setView([result.lat, result.lng], result.approx ? 15 : 17);
  if (result.approx) {
    showMsg("⚠️ 查不到這個確切門牌，" + result.approxNote, 6000);
  } else {
    document.getElementById("msgBox").style.display = "none";
  }
  showResult(feature.properties.town, feature.properties.vill, result.label);
}
function placePin(lat, lng) {
  if (currentPin) map.removeLayer(currentPin);
  currentPin = L.marker([lat, lng], { icon: pinIcon(), zIndexOffset: 1000 }).addTo(map);
  originPoint = { lat, lng };
}

/* ================= GPS 定位 ================= */
function locateMe() {
  if (!navigator.geolocation) { showMsg("這個瀏覽器不支援定位"); return; }
  const btn = document.getElementById("gpsBtn");
  btn.classList.add("busy");
  showMsg("定位中…", 12000);
  navigator.geolocation.getCurrentPosition(pos => {
    btn.classList.remove("busy");
    const { latitude: lat, longitude: lng } = pos.coords;
    placePin(lat, lng);
    const feature = findVillageAt(lat, lng);
    if (!feature) { showMsg("你目前的位置不在桃園市服務範圍內"); map.setView([lat, lng], 13); return; }
    map.setView([lat, lng], 16);
    document.getElementById("msgBox").style.display = "none";
    showResult(feature.properties.town, feature.properties.vill, "📍 目前位置");
  }, err => {
    btn.classList.remove("busy");
    showMsg(err.code === 1 ? "你沒有開放定位權限，請改用輸入地址查詢" : "定位失敗，可改用輸入地址查詢");
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}

/* ================= 下拉選單：縣市→地區→里 ================= */
function initSelectors() {
  const selDistrict = document.getElementById("selDistrict");
  const selVillDirect = document.getElementById("selVillDirect");
  const addrInput = document.getElementById("addrInput");

  const townVills = {};
  villageGeo.features.forEach(f => (townVills[f.properties.town] = townVills[f.properties.town] || []).push(f.properties.vill));
  Object.keys(townVills).sort().forEach(t => selDistrict.add(new Option(t, t)));

  selDistrict.onchange = () => {
    const town = selDistrict.value;
    addrInput.disabled = !town;
    addrInput.placeholder = town ? `只要打路名門牌，例：中山路100號` : "③ 選好地區後，輸入路名門牌";
    selVillDirect.innerHTML = "<option value=''>或直接選里查詢</option>";
    if (town) {
      townVills[town].sort((a, b) => a.localeCompare(b, "zh-Hant")).forEach(v => selVillDirect.add(new Option(v, v)));
    }
  };
  selVillDirect.onchange = () => {
    const town = selDistrict.value;
    if (!town || !selVillDirect.value) return;
    const poly = polygonByKey[town + "|" + selVillDirect.value];
    if (poly) map.fitBounds(poly.getBounds(), { maxZoom: 15 });
    showResult(town, selVillDirect.value);
  };
}

/* ================= 國小／國中切換 ================= */
function setLevel(level) {
  LEVEL = level;
  document.getElementById("segElem").classList.toggle("on", level === "elem");
  document.getElementById("segJr").classList.toggle("on", level === "jr");
  Object.values(polygonByKey).forEach(p => p.setStyle(polygonStyle(p.feature)));
  rebuildLabels();
  closePanel();
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

/* ================= 事件綁定 ================= */
document.getElementById("searchBtn").onclick = searchAddress;
document.getElementById("addrInput").addEventListener("keydown", e => { if (e.key === "Enter") searchAddress(); });
document.getElementById("gpsBtn").onclick = locateMe;
document.getElementById("segElem").onclick = () => setLevel("elem");
document.getElementById("segJr").onclick = () => setLevel("jr");
document.getElementById("chkNames").onchange = rebuildLabels;
map.on("zoomend", () => { if (villageGeo) rebuildLabels(); });

/* ================= 啟動 ================= */
Promise.all([
  fetch("/data/zone_data.json").then(r => r.json()),
  fetch("/data/villages.geojson").then(r => r.json()),
  fetch("/data/address_points.json").then(r => r.json())
]).then(([zd, geo, addr]) => {
  zoneData = zd;
  villageGeo = geo;
  addressPoints = addr;
  buildZoneIndex();
  renderPolygons();
  initSelectors();
}).catch(() => showMsg("資料載入失敗，請重新整理頁面"));
