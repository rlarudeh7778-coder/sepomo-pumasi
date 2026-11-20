"use strict";
// 세폰모 품앗이 — 휴대폰 화면(설치형 웹앱). 서버 주소는 config.js 한 곳.
const API = (window.APP_CONFIG && window.APP_CONFIG.api) || "/api";
const ua = navigator.userAgent;
const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(ua);
const isKakao = /kakaotalk/i.test(ua);
const isInApp = isKakao || /NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(ua);
const isMobile = isIOS || isAndroid;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const app = document.getElementById("app");

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 저장 못 해도 화면은 동작 */ } },
};
let token = store.get("pm_token");
let S = null; // 서버 상태(/state)
let CONF = null; // 규칙·알림 공개 키(/config)
let ADM = null; // 관리자 화면 자료
let view = location.hash.startsWith("#admin") && !location.hash.startsWith("#admin=") ? "admin" : "home";
let adminTab = "posts";
let authTab = "login";
let skipInstall = sessionStorage.getItem("pm_skip_install") === "1";
let deferredInstall = null;
let showInstallOnce = false;
let skew = 0; // 서버 시계 - 내 시계
const checkMsg = {}; // 글별 마지막 확인 결과
const adminCode = (location.hash.match(/admin=([^&]+)/) || [])[1] || "";
if (adminCode) sessionStorage.setItem("pm_admin_code", decodeURIComponent(adminCode));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const now = () => Date.now() + skew;
const kst = (t) => {
  const d = new Date(t + 9 * 3600e3);
  return { m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), date: d.toISOString().slice(0, 10) };
};
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const hm = (t) => { const k = kst(t); return `${pad(k.h)}:${pad(k.mi)}`; };
const when = (t) => { const k = kst(t); return (k.date === kst(now()).date ? "오늘 " : `${k.m}/${k.d} `) + hm(t); };
const dayName = (date, today) => (date === today ? "오늘" : date === addDays(today, -1) ? "어제" : `${+date.slice(5, 7)}월 ${+date.slice(8)}일`);
const until = (t) => { const k = kst(t); return `${k.m}월 ${k.d}일 ${pad(k.h)}:${pad(k.mi)}`; };
function left(deadline) {
  const ms = deadline - now();
  if (ms <= 0) return "마감 지남";
  const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return h ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
}

async function api(path, body) {
  let r;
  try {
    r = await fetch(API + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("인터넷 연결을 확인해 주세요"), { status: 0 });
  }
  let j = {};
  try { j = await r.json(); } catch { /* 빈 응답 */ }
  if (r.status === 401 && token && path !== "/login" && path !== "/signup") {
    logoutLocal();
    toast(j.error || "다시 로그인해 주세요");
  }
  if (!r.ok) throw Object.assign(new Error(j.error || "오류가 났어요"), { status: r.status, data: j });
  return j;
}

function toast(msg, ms = 3200) {
  document.querySelectorAll(".toast").forEach((e) => e.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 화면 안 묻기 창(브라우저 confirm/prompt 대신) — input 을 주면 글자를 받는다 */
function ask(title, { body = "", ok = "확인", danger = false, input = null } = {}) {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "backdrop";
    bd.innerHTML = `<div class="sheet"><h3>${esc(title)}</h3>${body ? `<p class="muted">${esc(body)}</p>` : ""}
      ${input ? `<input class="inp" id="askInp" ${input.numeric ? 'inputmode="numeric" pattern="[0-9]*"' : ""} value="${esc(input.value || "")}" placeholder="${esc(input.placeholder || "")}">` : ""}
      <div class="row"><button class="btn" data-a="no">취소</button><button class="btn ${danger ? "danger" : "primary"}" data-a="yes">${esc(ok)}</button></div></div>`;
    document.body.appendChild(bd);
    const done = (v) => { bd.remove(); resolve(v); };
    bd.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (e.target === bd || a === "no") done(null);
      if (a === "yes") done(input ? bd.querySelector("#askInp").value.trim() : true);
    });
    bd.querySelector("#askInp")?.focus();
  });
}

function logoutLocal() {
  token = null;
  store.set("pm_token", null);
  S = null;
  ADM = null;
  render();
}

// ---------------- 처음 · 설치 안내 ----------------
function installGuide() {
  const logo = `<div class="hero"><img src="icons/icon-192.png" alt=""><h1>세폰모 품앗이</h1><p>휴대폰에 앱으로 설치해 주세요</p></div>`;
  if (isInApp) {
    return `${logo}<div class="card"><b>카카오톡·네이버 앱 안에서는 설치가 안 돼요</b>
      <p class="muted small">${isIOS ? "오른쪽 아래 <b>⋯</b> 또는 공유 버튼 → <b>Safari로 열기</b>를 눌러 주세요." : "아래 버튼을 누르면 크롬으로 열려요."}</p>
      ${isKakao ? `<button class="btn primary block" data-act="openExternal">${isIOS ? "Safari로 열기" : "크롬으로 열기"}</button>` : ""}
      </div><button class="btn ghost block" data-act="skipInstall">설치 없이 계속하기</button>`;
  }
  if (isIOS) {
    return `${logo}<div class="card"><b>아이폰 설치 방법 (Safari)</b>
      <ol class="steps">
        <li>화면 아래 가운데 <span class="kbd">공유 ⬆︎</span> 버튼을 눌러요<br><span class="muted small">(주소창이 위에 있으면 주소창 옆 ⋯ → 공유)</span></li>
        <li>목록을 내려 <span class="kbd">홈 화면에 추가</span>를 눌러요</li>
        <li>오른쪽 위 <span class="kbd">추가</span>를 눌러요</li>
        <li>홈 화면에 생긴 <b>품앗이</b> 아이콘으로 열고 <b>알림 허용</b>을 눌러요</li>
      </ol>
      <p class="help">아이폰은 홈 화면에 추가한 앱에서만 알림이 와요(iOS 16.4 이상). Safari가 아니면 Safari로 열어 주세요.</p></div>
      <button class="btn ghost block" data-act="skipInstall">설치 없이 계속하기</button>`;
  }
  return `${logo}<div class="card"><b>안드로이드 설치 방법</b>
    ${deferredInstall ? `<button class="btn primary block" style="margin-top:12px" data-act="install">앱 설치하기</button>` : `
    <ol class="steps"><li>크롬 오른쪽 위 <span class="kbd">⋮</span> 를 눌러요</li><li><span class="kbd">앱 설치</span> 또는 <span class="kbd">홈 화면에 추가</span>를 눌러요</li><li>홈 화면의 <b>품앗이</b> 아이콘으로 열어요</li></ol>`}
    </div><button class="btn ghost block" data-act="skipInstall">설치 없이 계속하기</button>`;
}

function authView() {
  const isSignup = authTab === "signup";
  const admin = sessionStorage.getItem("pm_admin_code");
  return `<div class="hero"><img src="icons/icon-192.png" alt=""><h1>세폰모 품앗이</h1><p>서로의 카페 글에 댓글·좋아요를 주고받아요</p></div>
  <div class="tabs"><button class="${!isSignup ? "on" : ""}" data-act="authTab" data-v="login">로그인</button><button class="${isSignup ? "on" : ""}" data-act="authTab" data-v="signup">처음이에요 (가입)</button></div>
  <form class="card" id="authForm" autocomplete="on">
    <label class="f">성함</label><input class="inp" name="name" autocomplete="name" placeholder="예) 홍길동" required>
    ${isSignup ? `<label class="f">세폰모 카페 닉네임</label><input class="inp" name="nick" autocomplete="nickname" placeholder="카페에서 쓰는 닉네임 그대로" required>
      <p class="help">댓글·좋아요를 이 닉네임으로 확인해요. 띄어쓰기까지 똑같이 적어 주세요.</p>` : ""}
    <label class="f">비밀번호 (숫자 ${CONF ? CONF.rules.PIN_MIN : 4}~${CONF ? CONF.rules.PIN_MAX : 8}자리)</label>
    <input class="inp" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="${isSignup ? "new-password" : "current-password"}" required>
    ${isSignup ? `<label class="f">비밀번호 한 번 더</label><input class="inp" name="pin2" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" required>` : ""}
    ${isSignup && admin ? `<p class="note">관리자 코드로 가입해요(승인 없이 바로 관리자)</p>` : ""}
    <div class="err" id="authErr"></div>
    <button class="btn primary block" style="margin-top:16px">${isSignup ? "가입 신청" : "로그인"}</button>
    ${isSignup ? `<p class="help">가입하면 관리자가 승인한 뒤 시작할 수 있어요.</p>` : ""}
  </form>`;
}

// ---------------- 알림 ----------------
function pushStatus() {
  if (!pushSupported) return isIOS && !isStandalone() ? "need-install" : "unsupported";
  if (isIOS && !isStandalone()) return "need-install";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted" && store.get("pm_push") === "1") return "on";
  return "off";
}
const b64ToBytes = (s) => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
async function enablePush(silent = false) {
  if (!pushSupported) return;
  if (!CONF) CONF = await api("/config");
  const reg = await navigator.serviceWorker.ready;
  if (!silent) {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("알림이 허용되지 않았어요. 휴대폰 설정에서 알림을 켜 주세요", 5000);
      render();
      return;
    }
  } else if (Notification.permission !== "granted") return;
  let sub = await reg.pushManager.getSubscription();
  const key = b64ToBytes(CONF.vapidPublic);
  if (sub && sub.options && sub.options.applicationServerKey) {
    const old = new Uint8Array(sub.options.applicationServerKey);
    if (old.length !== key.length || old.some((x, i) => x !== key[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api("/push/sub", { sub: sub.toJSON() });
  store.set("pm_push", "1");
  if (!silent) { toast("알림이 켜졌어요 🔔"); render(); }
}

function pushCard() {
  const st = pushStatus();
  if (st === "on") return "";
  if (st === "need-install") return `<div class="card note bad"><b>🔔 알림을 받으려면 홈 화면에 추가해 주세요</b><p class="small" style="margin:4px 0 0">아이폰은 Safari → 공유 → 홈 화면에 추가 → 그 아이콘으로 열어야 알림이 와요.</p><button class="btn sm" style="margin-top:8px" data-act="showInstall">방법 보기</button></div>`;
  if (st === "unsupported") return `<div class="card note bad">이 브라우저는 알림을 못 받아요. 휴대폰의 Safari(아이폰)나 크롬(안드로이드)으로 열어 주세요.</div>`;
  if (st === "denied") return `<div class="card note bad"><b>🔕 알림이 꺼져 있어요</b><p class="small" style="margin:4px 0 0">휴대폰 설정 → 알림 → ${isIOS ? "품앗이" : "크롬(또는 품앗이)"} 에서 알림을 허용해 주세요.</p></div>`;
  return `<div class="card note"><b>🔔 새 글 알림을 켜 주세요</b><p class="small" style="margin:4px 0 8px">새 글이 올라오면 바로 알려 드려요.</p><button class="btn primary block" data-act="enablePush">알림 켜기</button></div>`;
}

// ---------------- 메인 화면 ----------------
function topBar(sub) {
  return `<header class="top"><img class="logo" src="icons/icon-192.png" alt=""><h1>세폰모 품앗이<small>${esc(sub)}</small></h1>
    ${S && S.me.isAdmin ? `<button class="icon-btn" data-act="${view === "admin" ? "home" : "admin"}">${view === "admin" ? "내 화면" : "관리"}</button>` : ""}
    <button class="icon-btn" data-act="menu" aria-label="메뉴">☰</button></header>`;
}

function rulesHtml() {
  const R = CONF ? CONF.rules : null;
  if (!R) return "";
  const pen = R.PENALTY_DAYS === 1 ? "그다음 날까지" : `${R.PENALTY_DAYS}일 뒤까지`;
  return `<ol class="steps">
    <li><b>글을 올리려면</b> 오늘 이미 올라온 다른 분 글에 댓글 + 좋아요를 모두 해야 해요.</li>
    <li>내가 글을 올린 날의 다른 분 글은 <b>올라온 뒤 ${R.DEADLINE_HOURS}시간 안에</b> 꼭 댓글 + 좋아요 (의무).</li>
    <li>마감 ${R.REMIND_BEFORE_HOURS}시간 전까지 안 했으면 알림이 한 번 더 와요.</li>
    <li>마감을 놓치면 <b>${pen} 글을 올릴 수 없어요.</b></li>
    <li>그날 글을 안 올렸다면 의무는 없어요. 해 주시면 기록에 남아요.</li>
    <li>카페 확인은 ${R.CHECK_EVERY_MIN}분마다 자동이고, 「확인」 버튼을 누르면 바로 해요.</li>
    <li>좋아요는 네이버가 최근 3명만 보여 줘서, 못 찾으면 「좋아요 눌렀어요」로 직접 체크해요.</li>
  </ol>`;
}

function myChecks(p) {
  const m = p.my;
  return `<div class="chks"><span class="chk ${m.c ? "on" : ""}">💬 댓글 ${m.c ? "✓" : ""}</span><span class="chk ${m.l ? "on" : ""}">❤️ 좋아요 ${m.l ? (m.lSelf ? "✓(직접)" : "✓") : ""}</span></div>`;
}

function postCard(p, ctx) {
  const done = p.my && p.my.c && p.my.l;
  let tag = "";
  if (p.finalized) tag = `<span class="tag gray">마감됨</span>`;
  else if (p.my && p.my.must && !done) tag = `<span class="tag must">의무 · ${left(p.deadline)}</span>`;
  else if (p.my && !done && p.date === S.today) tag = `<span class="tag">오늘 글 올리려면 필요</span>`;
  else if (done) tag = `<span class="tag ok">완료</span>`;
  const cm = checkMsg[p.id];
  return `<article class="card post">
    <div class="meta"><span class="who">${esc(p.author.name)}</span><span>${when(p.createdAt)}</span></div>
    <div class="subj">${esc(p.subject || "(제목 없음)")}</div>
    <div class="tags">${tag}</div>
    ${p.my ? myChecks(p) : ""}
    ${cm ? `<div class="note ${cm.c && cm.l ? "" : "bad"}">${esc(cm.msg)}</div>` : ""}
    ${p.my && !p.finalized ? `<div class="row"><a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener" data-act="opened">카페에서 열기</a>
      ${done ? "" : `<button class="btn primary" data-act="check" data-id="${p.id}">다 했어요 · 확인</button>`}</div>
      ${cm && cm.canSelfLike ? `<button class="btn yellow block" style="margin-top:8px" data-act="selfLike" data-id="${p.id}">❤️ 좋아요 눌렀어요</button>` : ""}` : ""}
    ${ctx === "mine" || ctx === "admin" ? peopleList(p) : ""}
  </article>`;
}

function peopleList(p) {
  if (!p.people) return "";
  const rows = p.people
    .slice()
    .sort((a, b) => Number(b.must) - Number(a.must) || Number(b.c && b.l) - Number(a.c && a.l))
    .map((x) => `<li><span class="nm">${esc(x.name)} ${x.must ? `<span class="must">의무</span>` : ""}</span>
      <span class="mk ${x.miss && !x.c ? "miss" : x.c ? "on" : ""}">💬 ${x.c ? "✓" : x.miss ? "✗" : "-"}</span>
      <span class="mk ${x.miss && !x.l ? "miss" : x.lSelf ? "self" : x.l ? "on" : ""}">❤️ ${x.l ? (x.lSelf ? "직접" : "✓") : x.miss ? "✗" : "-"}</span></li>`)
    .join("");
  return `<p class="small muted" style="margin:10px 0 0">완료 ${p.doneCount}명 · 의무 ${p.mustCount}명${p.checkError ? ` · ⚠️ ${esc(p.checkError)}` : ""}${p.checkedAt ? ` · 확인 ${hm(p.checkedAt)}` : ""}</p><ul class="people">${rows}</ul>`;
}

function homeView() {
  const me = S.me;
  if (me.status !== "active") {
    return `${topBar(me.name + "님")}
      <div class="card status no"><span class="dot">⏳</span><div><b>관리자 승인을 기다리고 있어요</b><span class="small">승인되면 알림으로 알려 드려요.</span></div></div>
      ${pushCard()}
      <div class="card small muted">가입 정보 · ${esc(me.name)} · 카페 닉네임 「${esc(me.nick)}」</div>`;
  }
  const posts = S.posts;
  const isTodo = (p) => !p.mine && !p.finalized && !(p.my.c && p.my.l) && (p.my.must || p.date === S.today);
  const todo = posts.filter(isTodo).sort((a, b) => Number(b.my.must) - Number(a.my.must) || a.deadline - b.deadline);
  const mine = posts.filter((p) => p.mine);
  const rest = posts.filter((p) => !p.mine && !isTodo(p));
  const cp = S.canPost;
  const banned = me.bannedUntil && me.bannedUntil > now();
  const status = cp.ok
    ? `<div class="card status ok"><span class="dot">✅</span><div><b>오늘 글을 올릴 수 있어요</b><span class="small">아래 버튼으로 내 카페 글 링크를 올려 주세요.</span></div></div>`
    : `<div class="card status ${banned ? "ban" : "no"}"><span class="dot">${banned ? "⛔" : "✋"}</span><div><b>${banned ? `${until(me.bannedUntil)}까지 글 올리기 멈춤` : "지금은 글을 올릴 수 없어요"}</b><ul>${cp.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div></div>`;
  const byDay = (list) => {
    const g = new Map();
    for (const p of list) { if (!g.has(p.date)) g.set(p.date, []); g.get(p.date).push(p); }
    return [...g].map(([d, ps]) => `<div class="sec"><h2>${dayName(d, S.today)}</h2><span class="n">${ps.length}개</span></div>${ps.map((p) => postCard(p, "rest")).join("")}`).join("");
  };
  return `${topBar(`${me.name}님 · ${me.nick}`)}
    ${status}${pushCard()}
    <div class="sec"><h2>해야 할 글</h2><span class="n">${todo.length}개</span></div>
    ${todo.length ? todo.map((p) => postCard(p, "todo")).join("") : `<div class="empty">지금 해야 할 글이 없어요 👏</div>`}
    <div class="sec"><h2>내 글</h2><span class="n">누가 해 줬는지 보여요</span></div>
    ${mine.length ? mine.map((p) => postCard(p, "mine")).join("") : `<div class="empty">최근 올린 글이 없어요</div>`}
    ${rest.length ? byDay(rest) : ""}
    <button class="btn primary fab" data-act="openPost">＋ 내 글 링크 올리기</button>`;
}

function postSheet() {
  const bd = document.createElement("div");
  bd.className = "backdrop";
  bd.innerHTML = `<div class="sheet"><h3>내 글 링크 올리기</h3>
    <p class="muted small" style="margin:0">카페 앱에서 내 글 열기 → 오른쪽 위 <b>공유</b> → <b>링크 복사</b> 후 아래에 붙여 넣어요.</p>
    <textarea class="inp" id="linkInp" style="margin-top:12px" placeholder="https://cafe.naver.com/..."></textarea>
    ${navigator.clipboard && navigator.clipboard.readText ? `<button class="btn sm" style="margin-top:8px" data-a="paste">📋 붙여넣기</button>` : ""}
    <div id="postErr"></div>
    <div class="row"><button class="btn" data-a="no">닫기</button><button class="btn primary" data-a="yes">올리기</button></div></div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (e.target === bd || a === "no") return close();
    if (a === "paste") {
      try { bd.querySelector("#linkInp").value = await navigator.clipboard.readText(); } catch { toast("길게 눌러 붙여넣기 해 주세요"); }
    }
    if (a === "yes") {
      const btn = e.target.closest("button");
      const url = bd.querySelector("#linkInp").value.trim();
      const errEl = bd.querySelector("#postErr");
      if (!url) { errEl.innerHTML = `<p class="err">링크를 붙여 넣어 주세요</p>`; return; }
      btn.disabled = true;
      btn.textContent = "확인하는 중…";
      try {
        const r = await api("/post", { url });
        close();
        toast(`글을 올렸어요. ${r.notified}명에게 알림을 보냈어요 🔔`, 4000);
        await loadState();
      } catch (err) {
        const todo = err.data && err.data.todo;
        errEl.innerHTML = `<p class="err">${esc(err.message)}</p>${todo ? `<ul class="small">${todo.map((t) => `<li>${esc(t.name)} · ${esc(t.subject)}</li>`).join("")}</ul>` : ""}`;
        btn.disabled = false;
        btn.textContent = "올리기";
      }
    }
  });
  bd.querySelector("#linkInp").focus();
}

function menuSheet() {
  const bd = document.createElement("div");
  bd.className = "backdrop";
  bd.innerHTML = `<div class="sheet"><h3>품앗이 규칙</h3>${rulesHtml()}
    <div class="row"><button class="btn" data-a="test">🔔 알림 시험</button><button class="btn" data-a="install">설치 방법</button></div>
    <div class="row"><button class="btn danger" data-a="logout">로그아웃</button><button class="btn primary" data-a="no">닫기</button></div></div>`;
  document.body.appendChild(bd);
  bd.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (e.target === bd || a === "no") return bd.remove();
    if (a === "test") {
      try {
        if (pushStatus() !== "on") await enablePush();
        const r = await api("/push/test", {});
        toast(r.sent ? "알림을 보냈어요. 곧 울려요" : "알림 받을 기기가 없어요. 알림을 먼저 켜 주세요");
      } catch (err) { toast(err.message); }
    }
    if (a === "install") { bd.remove(); skipInstall = false; sessionStorage.removeItem("pm_skip_install"); showInstallOnce = true; render(); }
    if (a === "logout") {
      bd.remove();
      try { await api("/logout", {}); } catch { /* 이미 풀림 */ }
      logoutLocal();
    }
  });
}

// ---------------- 관리자 ----------------
function adminView() {
  if (!ADM) return `${topBar("관리자")}<div class="empty">불러오는 중…</div>`;
  const tabs = `<div class="tabs">${[["posts", "글 현황"], ["members", `회원 ${ADM.activeCount}/${ADM.rules.MAX_MEMBERS}`], ["settings", "설정"]]
    .map(([k, n]) => `<button class="${adminTab === k ? "on" : ""}" data-act="adminTab" data-v="${k}">${n}</button>`).join("")}</div>`;
  let body = "";
  if (adminTab === "posts") {
    const g = new Map();
    for (const p of ADM.posts) { if (!g.has(p.date)) g.set(p.date, []); g.get(p.date).push(p); }
    body = g.size
      ? [...g].map(([d, ps]) => `<div class="sec"><h2>${dayName(d, ADM.today)}</h2><span class="n">글 ${ps.length}개 · 글쓴 사람 ${new Set(ps.map((p) => p.author.id)).size}명</span></div>
        ${ps.map((p) => `<details class="card post" data-pid="${p.id}" ${d === ADM.today ? "open" : ""}><summary>
          <div class="meta"><span class="who">${esc(p.author.name)}</span><span>${when(p.createdAt)} · ${p.finalized ? "마감됨" : left(p.deadline)}</span></div>
          <div class="subj">${esc(p.subject)}</div>
          <div class="tags"><span class="tag ${p.doneCount >= p.mustCount ? "ok" : "must"}">의무 ${p.mustCount}명 중 완료 ${p.people.filter((x) => x.must && x.c && x.l).length}</span><span class="tag gray">전체 완료 ${p.doneCount}명</span></div></summary>
          ${peopleList(p)}
          <div class="acts"><a class="btn sm" href="${esc(p.url)}" target="_blank" rel="noopener">카페 글</a><button class="btn sm" data-act="admRecheck" data-id="${p.id}">지금 확인</button><button class="btn sm danger" data-act="admDelPost" data-id="${p.id}">목록에서 빼기</button></div>
        </details>`).join("")}`).join("")
      : `<div class="empty">최근 ${ADM.rules.KEEP_DAYS}일 동안 올라온 글이 없어요</div>`;
  } else if (adminTab === "members") {
    const pend = ADM.members.filter((m) => m.status === "pending");
    const act = ADM.members.filter((m) => m.status === "active");
    const mcard = (m) => {
      const s = m.stat30;
      const rate = s && s.must ? Math.round((s.done / s.must) * 100) + "%" : "-";
      return `<div class="card"><div class="mrow"><div class="nm"><b>${esc(m.name)}</b> ${m.isAdmin ? `<span class="tag">관리자</span>` : ""}
        <div class="small muted">카페 닉네임 「${esc(m.nick)}」 ${m.cafeLinked ? "· 카페 확인됨 ✓" : "· 카페 확인 전"}</div></div></div>
        ${m.status === "active" ? `<div class="stat"><span class="tag gray">30일 의무 ${s ? s.must : 0}</span><span class="tag ok">완료 ${s ? s.done : 0} (${rate})</span><span class="tag ${s && s.miss ? "must" : "gray"}">놓침 ${s ? s.miss : 0}</span><span class="tag gray">글 ${s ? s.posts : 0}</span>
          ${m.bannedUntil ? `<span class="tag must">${until(m.bannedUntil)}까지 정지</span>` : ""}</div>` : `<div class="small muted">신청 ${when(m.createdAt)}</div>`}
        <div class="acts">${m.status === "pending" ? `<button class="btn sm primary" data-act="admMember" data-a="approve" data-id="${m.id}">승인</button><button class="btn sm danger" data-act="admMember" data-a="remove" data-id="${m.id}">거절</button>` : `
          ${m.bannedUntil ? `<button class="btn sm" data-act="admMember" data-a="unban" data-id="${m.id}">정지 풀기</button>` : ""}
          <button class="btn sm" data-act="admMember" data-a="nick" data-id="${m.id}">닉네임 고치기</button>
          <button class="btn sm" data-act="admMember" data-a="resetpin" data-id="${m.id}">비밀번호 새로</button>
          ${m.isAdmin ? "" : `<button class="btn sm danger" data-act="admMember" data-a="remove" data-id="${m.id}">내보내기</button>`}`}</div></div>`;
    };
    body = `${pend.length ? `<div class="sec"><h2>승인 기다림</h2><span class="n">${pend.length}명</span></div>${pend.map(mcard).join("")}` : ""}
      <div class="sec"><h2>활동 회원</h2><span class="n">${act.length}/${ADM.rules.MAX_MEMBERS}명</span></div>${act.map(mcard).join("")}`;
  } else {
    const appUrl = location.origin + location.pathname;
    body = `<div class="card"><b>세폰모 카페</b><p class="small muted" style="margin:4px 0 8px">${ADM.cafe ? `등록됨: ${esc(ADM.cafe.name || "")} (번호 ${esc(ADM.cafe.id)})` : "아직 등록 안 됨 — 이 카페 글만 올릴 수 있게 해요"}</p>
      <input class="inp" id="cafeInp" placeholder="세폰모 카페 주소나 아무 글 링크"><button class="btn primary block" style="margin-top:8px" data-act="admCafe">카페 등록</button></div>
      <div class="card"><b>회원 초대 링크</b><p class="small muted" style="margin:4px 0 8px">카톡으로 이 주소를 보내 주세요. 가입하면 「회원」 탭에서 승인해요.</p>
      <input class="inp" readonly value="${esc(appUrl)}"><button class="btn block" style="margin-top:8px" data-act="copy" data-v="${esc(appUrl)}">주소 복사</button></div>
      <div class="card"><b>규칙</b>${rulesHtml()}</div>`;
  }
  return `${topBar("관리자 화면")}${tabs}${body}`;
}

// ---------------- 그리기 · 불러오기 ----------------
/** 주기적으로 다시 그릴 때: 글자를 입력 중이면 건너뛴다 */
function softRender() {
  const a = document.activeElement;
  if (a && app.contains(a) && /INPUT|TEXTAREA/.test(a.tagName)) return;
  render();
}

function render() {
  const opened = new Map([...app.querySelectorAll("details[data-pid]")].map((d) => [d.dataset.pid, d.open])); // 관리자 글 펼침 상태 유지
  draw();
  app.querySelectorAll("details[data-pid]").forEach((d) => { if (opened.has(d.dataset.pid)) d.open = opened.get(d.dataset.pid); });
}

function draw() {
  const mustGuide = isMobile && !isStandalone() && !skipInstall;
  if (!token) {
    app.innerHTML = mustGuide || showInstallOnce ? installGuide() : authView();
    showInstallOnce = false;
    return;
  }
  if (showInstallOnce) { showInstallOnce = false; app.innerHTML = installGuide(); return; }
  if (!S) { app.innerHTML = `<div class="hero"><img src="icons/icon-192.png" alt=""><p>불러오는 중…</p></div>`; return; }
  app.innerHTML = view === "admin" && S.me.isAdmin ? adminView() : homeView();
}

async function loadState(full = false, soft = false) {
  try {
    const st = await api(full ? "/refresh" : "/state", full ? {} : undefined);
    skew = st.now - Date.now();
    S = st;
    if (view === "admin" && S.me.isAdmin) ADM = await api("/admin", {});
  } catch (e) {
    if (e.status !== 401 && !soft) toast(e.message);
  }
  soft ? softRender() : render();
}

async function boot() {
  try { CONF = await api("/config"); } catch { /* 나중에 다시 */ }
  render();
  if (token) {
    await loadState(true);
    if (pushStatus() === "on" || (pushSupported && Notification.permission === "granted")) enablePush(true).catch(() => {});
  }
}

// ---------------- 누르기 ----------------
app.addEventListener("submit", async (e) => {
  if (e.target.id !== "authForm") return;
  e.preventDefault();
  const f = new FormData(e.target);
  const errEl = document.getElementById("authErr");
  const btn = e.target.querySelector("button.primary");
  errEl.textContent = "";
  if (authTab === "signup" && f.get("pin") !== f.get("pin2")) { errEl.textContent = "비밀번호 두 개가 달라요"; return; }
  btn.disabled = true;
  try {
    const body = { name: f.get("name"), pin: f.get("pin") };
    if (authTab === "signup") { body.nick = f.get("nick"); body.admin = sessionStorage.getItem("pm_admin_code") || ""; }
    const r = await api(authTab === "signup" ? "/signup" : "/login", body);
    token = r.token;
    store.set("pm_token", token);
    sessionStorage.removeItem("pm_admin_code");
    if (location.hash.includes("admin=")) history.replaceState(null, "", location.pathname);
    S = null;
    render();
    await loadState(true);
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
  }
});

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const id = Number(el.dataset.id);
  try {
    if (act === "authTab") { authTab = el.dataset.v; render(); }
    else if (act === "skipInstall") { skipInstall = true; sessionStorage.setItem("pm_skip_install", "1"); render(); }
    else if (act === "showInstall") { showInstallOnce = true; render(); }
    else if (act === "install" && deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); }
    else if (act === "openExternal") {
      location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href);
    }
    else if (act === "enablePush") { el.disabled = true; await enablePush(); }
    else if (act === "menu") menuSheet();
    else if (act === "openPost") postSheet();
    else if (act === "admin") { view = "admin"; history.replaceState(null, "", "#admin"); ADM = null; render(); ADM = await api("/admin", {}); render(); }
    else if (act === "home") { view = "home"; history.replaceState(null, "", location.pathname); render(); }
    else if (act === "check") {
      el.disabled = true;
      el.textContent = "카페에서 확인하는 중…";
      checkMsg[id] = await api("/check", { postId: id });
      await loadState();
    }
    else if (act === "selfLike") {
      const ok = await ask("좋아요를 누르셨나요?", { body: "네이버가 최근 3명만 보여 줘서 자동으로 못 찾았어요. 누르셨다면 직접 체크해 주세요.", ok: "네, 눌렀어요" });
      if (!ok) return;
      await api("/selflike", { postId: id });
      checkMsg[id] = { c: true, l: true, msg: "좋아요를 직접 체크했어요 👍" };
      await loadState();
    }
    else if (act === "adminTab") { adminTab = el.dataset.v; render(); }
    else if (act === "admRecheck") { el.disabled = true; const r = await api("/admin/post", { id, action: "recheck" }); toast(r.ok ? "카페에서 다시 확인했어요" : r.error || "카페를 읽지 못했어요"); await loadState(); }
    else if (act === "admDelPost") {
      if (!(await ask("이 글을 목록에서 뺄까요?", { body: "알림·의무·기록 계산에서 빠져요(카페 글은 그대로).", ok: "빼기", danger: true }))) return;
      await api("/admin/post", { id, action: "delete" }); await loadState();
    }
    else if (act === "admMember") {
      const a = el.dataset.a;
      const m = ADM.members.find((x) => x.id === id);
      const body = { id, action: a };
      if (a === "remove" && !(await ask(m.status === "pending" ? `${m.name}님 가입을 거절할까요?` : `${m.name}님을 내보낼까요?`, { body: "진행 중인 그분 글은 목록에서 빠지고, 앱에서 로그아웃돼요.", ok: m.status === "pending" ? "거절" : "내보내기", danger: true }))) return;
      if (a === "nick") { const v = await ask(`${m.name}님 카페 닉네임`, { input: { value: m.nick }, ok: "바꾸기" }); if (!v) return; body.nick = v; }
      if (a === "resetpin") {
        const v = await ask(`${m.name}님 새 비밀번호`, { body: `숫자 ${ADM.rules.PIN_MIN}~${ADM.rules.PIN_MAX}자리. 정해서 그분께 알려 주세요.`, input: { numeric: true }, ok: "바꾸기" });
        if (!v) return; body.pin = v;
      }
      await api("/admin/member", body);
      toast({ approve: "승인했어요", remove: "처리했어요", unban: "정지를 풀었어요", nick: "닉네임을 바꿨어요", resetpin: "비밀번호를 바꿨어요" }[a] || "처리했어요");
      await loadState();
    }
    else if (act === "admCafe") {
      const v = document.getElementById("cafeInp").value.trim();
      if (!v) return toast("카페 주소를 붙여 넣어 주세요");
      const r = await api("/admin/settings", { cafe: v });
      toast(`카페 등록: ${r.cafe.name || r.cafe.id}`); await loadState();
    }
    else if (act === "copy") {
      try { await navigator.clipboard.writeText(el.dataset.v); toast("복사했어요"); } catch { toast("길게 눌러 복사해 주세요"); }
    }
  } catch (err) {
    toast(err.message, 4500);
    if (el.tagName === "BUTTON") el.disabled = false;
    if (act === "check") await loadState();
  }
});

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstall = e; if (!token) render(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && token && S) loadState(S.me.status === "active", true); });
setInterval(() => { if (document.visibilityState === "visible" && token && S) loadState(false, true); }, 30_000); // 실시간 표 — 30초마다

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
