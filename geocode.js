/* geocode.js — 大桃園工具箱共用地址解析模組
 * 供 index.html（學區地圖）、poi.html（周邊機能）、trash.html（垃圾車）共用。
 * 策略：優先比對桃園市政府「門牌位置坐標資料」（本地、精確、無網路延遲），
 * 查不到才退回 OpenStreetMap Nominatim（免費地理編碼服務）當備援。
 */

const GEOCODE_ENDPOINT = "https://nominatim.openstreetmap.org/search";
let addressPoints = null; // town -> road -> [[鄰,巷,弄,號,lat,lon], ...]
function loadAddressPoints(data) { addressPoints = data; }

/* ---------- 本地門牌坐標查詢 ---------- */
function normalizeDigits(s) {
  const full = "０１２３４５６７８９", half = "0123456789";
  return (s || "").replace(/[０-９]/g, d => half[full.indexOf(d)]);
}
function parseAddressInput(raw) {
  let s = normalizeDigits(raw.trim());
  let num = "", alley = "", lane = "";
  let m = s.match(/(\d+)\s*號/);
  if (m) { num = m[1]; s = s.slice(0, m.index) + s.slice(m.index + m[0].length); }
  m = s.match(/(\d+)\s*弄/);
  if (m) { alley = m[1]; s = s.slice(0, m.index) + s.slice(m.index + m[0].length); }
  m = s.match(/(\d+)\s*巷/);
  if (m) { lane = m[1]; s = s.slice(0, m.index) + s.slice(m.index + m[0].length); }
  return { road: s.trim(), lane, alley, num };
}
function resolveRoadKey(town, roadQuery) {
  const roads = Object.keys((addressPoints && addressPoints[town]) || {});
  if (roads.includes(roadQuery)) return roadQuery;
  const candidates = roads.filter(r => roadQuery && (roadQuery.includes(r) || r.includes(roadQuery)));
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}
function localAddressLookup(town, parsed) {
  const roadKey = resolveRoadKey(town, parsed.road);
  if (!roadKey) return null;
  const points = addressPoints[town][roadKey];
  const exact = points.filter(p => p[1] === parsed.lane && p[2] === parsed.alley && p[3] === parsed.num);
  if (exact.length) return { point: exact[0], level: 0, roadKey };
  const sameAlley = points.filter(p => p[1] === parsed.lane && p[2] === parsed.alley);
  if (sameAlley.length) return { point: sameAlley[0], level: 1, roadKey };
  const sameLane = points.filter(p => p[1] === parsed.lane);
  if (sameLane.length) return { point: sameLane[0], level: 2, roadKey };
  if (points.length) return { point: points[0], level: 3, roadKey };
  return null;
}
const LOCAL_APPROX_LABEL = ["", "同巷弄", "同巷", "同路段"];

/* ---------- Nominatim 備援（退階查詢） ---------- */
function addressFallbackChain(raw) {
  const chain = [raw];
  let cur = raw;
  const steps = [/\d+(-\d+)?號.*$/, /\d+弄.*$/, /\d+巷.*$/];
  for (const pattern of steps) {
    const stripped = cur.replace(pattern, "").trim();
    if (stripped && stripped !== cur && !chain.includes(stripped)) chain.push(stripped);
    cur = stripped || cur;
  }
  return chain;
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function geocodeOnce(query) {
  // accept-language 放查詢字串而不是自訂 header，避免觸發 CORS preflight（曾造成間歇性 fetch 失敗）
  const url = `${GEOCODE_ENDPOINT}?format=json&limit=1&countrycodes=tw&accept-language=zh-TW&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const list = await res.json();
  return list[0] || null;
}
async function resolveAddressViaNominatim(district, raw) {
  const prefix = "台灣桃園市" + district;
  const chain = addressFallbackChain(raw);
  let hit = null, usedStep = 0, hadNetworkError = false;
  for (let i = 0; i < chain.length; i++) {
    if (i > 0) await wait(1100); // 尊重免費服務的查詢頻率限制
    for (let attempt = 0; attempt < 2 && !hit; attempt++) {
      if (attempt > 0) await wait(700);
      try { hit = await geocodeOnce(prefix + chain[i]); }
      catch (e) { hadNetworkError = true; }
    }
    if (hit) { usedStep = i; break; }
  }
  if (!hit) {
    return { error: hadNetworkError
      ? "查詢服務有點不穩，請稍後再試一次，或改用下方「直接選里查詢」"
      : "查不到這個地址，請確認路名與門牌是否正確，或改用下方「直接選里查詢」" };
  }
  const lat = parseFloat(hit.lat), lng = parseFloat(hit.lon);
  return {
    lat, lng, label: hit.display_name,
    approx: usedStep > 0,
    approxNote: usedStep > 0 ? `這是「${chain[usedStep]}」附近的概略位置，正確位置建議把完整地址傳給柚子確認` : "",
    source: "nominatim"
  };
}

/* ---------- 統一入口：本地優先，查不到才退回 Nominatim ----------
 * 回傳：{lat, lng, label, approx, approxNote, source} 或 {error}
 */
async function resolveAddress(district, raw) {
  const parsed = parseAddressInput(raw);
  const local = localAddressLookup(district, parsed);
  if (local) {
    const [neighbor, , , , lat, lng] = local.point;
    const userGaveNumber = !!parsed.num;
    const isApprox = userGaveNumber && local.level > 0;
    const label = district + local.roadKey
      + (parsed.lane ? parsed.lane + "巷" : "") + (parsed.alley ? parsed.alley + "弄" : "") + (parsed.num ? parsed.num + "號" : "")
      + `（官方門牌資料·第${neighbor}鄰）`;
    return {
      lat, lng, label,
      approx: isApprox,
      approxNote: isApprox ? `這是「${local.roadKey}」${LOCAL_APPROX_LABEL[local.level]}附近的概略位置，建議把完整地址傳給柚子確認` : "",
      source: "local"
    };
  }
  return await resolveAddressViaNominatim(district, raw);
}

/* ---------- 縣市／地區／里 下拉選單（共用邏輯） ----------
 * villageGeo 的 features 需含 properties.town / properties.vill
 */
function populateDistrictSelect(selDistrict, villageGeo, onDistrictChange) {
  const townVills = {};
  villageGeo.features.forEach(f => (townVills[f.properties.town] = townVills[f.properties.town] || []).push(f.properties.vill));
  Object.keys(townVills).sort().forEach(t => selDistrict.add(new Option(t, t)));
  selDistrict.onchange = () => onDistrictChange(selDistrict.value, townVills[selDistrict.value] || []);
  return townVills;
}
