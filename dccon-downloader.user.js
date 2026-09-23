// ==UserScript==
// @name         디시콘 다운로더
// @namespace    local.dccon.downloader
// @version      2.0.0
// @description  디시콘 정보 창에 다운 버튼을 추가해서 고른 통합 폴더/<디시콘 이름>/ 에 바로 저장합니다.
// @homepageURL  https://github.com/chowol0309/dccon-downloader
// @downloadURL  https://raw.githubusercontent.com/chowol0309/dccon-downloader/main/dccon-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/chowol0309/dccon-downloader/main/dccon-downloader.user.js
// @match        *://*.dcinside.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      dcinside.com
// @run-at       document-idle
// ==/UserScript==

// 브라우저 다운로드 대신 파일 시스템 접근 API로 통합 폴더에 직접 쓴다.
// 그래서 "다운로드 전에 저장 위치 묻기" 설정이 켜져 있어도 파일마다 묻지 않는다.
(function () {
  'use strict';

  const CONCURRENCY = 4;
  const BTN_CLASS = 'dccon-dl-btn';
  const EXT_BY_TYPE = { 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp' };

  // ---- 통합 폴더 핸들 저장 (IndexedDB) ----
  const DB_NAME = 'dccon-downloader', STORE = 'kv', KEY = 'rootDir';
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const loadRoot = () => idb('readonly', (s) => s.get(KEY)).catch(() => null);
  const saveRoot = (handle) => idb('readwrite', (s) => s.put(handle, KEY));

  // 클릭 직후(사용자 동작 안)에 불러야 권한 창을 띄울 수 있다.
  async function getRootDir(forcePick) {
    let root = forcePick ? null : await loadRoot();
    if (root) {
      const opts = { mode: 'readwrite' };
      if ((await root.queryPermission(opts)) === 'granted' || (await root.requestPermission(opts)) === 'granted') return root;
    }
    // Tampermonkey 샌드박스의 window 대신 실제 페이지 window의 함수를 쓴다.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const picker = pageWindow.showDirectoryPicker || window.showDirectoryPicker;
    if (!picker) throw new Error('이 브라우저는 폴더 선택(showDirectoryPicker)을 지원하지 않습니다.');
    root = await picker.call(pageWindow.showDirectoryPicker ? pageWindow : window, { id: 'dccon-root', mode: 'readwrite', startIn: 'downloads' });
    await saveRoot(root);
    return root;
  }

  // 윈도우 파일 이름에 못 쓰는 문자와 끝의 점·공백을 정리한다.
  function sanitize(name, fallback) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 80);
    return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned) || !cleaned ? fallback : cleaned;
  }

  // 갤러리 창은 h4.con_title, 디시콘샵 창은 h4.font_blue라서 h4로 찾고, 없으면 대표 이미지 alt를 쓴다.
  function popupTitle(popup) {
    const h4 = popup.querySelector('.viewtxt_top h4, .info_viewtxt h4');
    return (h4?.textContent || popup.querySelector('.info_viewimg img')?.alt || '').trim();
  }

  function header(headers, name) {
    const m = new RegExp('^' + name + ':\\s*(.*)$', 'im').exec(headers || '');
    return m ? m[1].trim() : '';
  }

  function extFor(contentType, disposition) {
    const fromDisposition = /filename="?[^";]*\.([a-z0-9]+)"?/i.exec(disposition || '');
    if (fromDisposition) return fromDisposition[1].toLowerCase();
    return EXT_BY_TYPE[contentType.split(';')[0].trim()] || 'png';
  }

  // 디시콘 이미지는 Referer가 디시 주소가 아니면 403을 준다.
  function fetchImage(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        headers: { Referer: location.origin + '/' },
        timeout: 30000,
        onload(res) {
          const type = header(res.responseHeaders, 'content-type');
          if (res.status < 200 || res.status >= 300) return reject(new Error('HTTP ' + res.status));
          if (!type.startsWith('image/')) return reject(new Error('이미지가 아님: ' + type));
          resolve({ blob: res.response, ext: extFor(type, header(res.responseHeaders, 'content-disposition')) });
        },
        onerror: () => reject(new Error('요청 실패')),
        ontimeout: () => reject(new Error('시간 초과')),
      });
    });
  }

  async function writeFile(dir, name, blob) {
    const file = await dir.getFileHandle(name, { create: true });
    const out = await file.createWritable();
    await out.write(blob);
    await out.close();
  }

  function collect(popup) {
    return {
      title: popupTitle(popup),
      images: [...popup.querySelectorAll('.dccon_list img')].map((img) => ({
        url: new URL(img.getAttribute('src'), location.href).href,
        name: (img.getAttribute('title') || img.alt || '').trim(),
      })),
    };
  }

  async function downloadPackage(pkg, root, onProgress) {
    const folderName = sanitize(pkg.title, '이름없는디시콘');
    const dir = await root.getDirectoryHandle(folderName, { create: true });
    const images = pkg.images;
    const width = Math.max(2, String(images.length).length);
    let done = 0, failed = 0, next = 0;

    async function worker() {
      while (next < images.length) {
        const i = next++;
        try {
          const { blob, ext } = await fetchImage(images[i].url);
          const label = sanitize(images[i].name, '');
          const number = String(i + 1).padStart(width, '0');
          await writeFile(dir, `${number}${label && label !== String(i + 1) ? '_' + label : ''}.${ext}`, blob);
        } catch (err) {
          failed++;
          console.warn('[디시콘 다운로더]', images[i].url, err);
        }
        onProgress(++done, images.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length) }, worker));
    return { failed, folder: `${root.name}/${folderName}`, total: images.length };
  }

  // 폴더 선택·저장은 최상위 창에서만 한다. (다른 주소의 iframe 안에서는 폴더 선택 창을 띄울 수 없다)
  async function runInThisWindow(pkg, repick, onProgress) {
    try {
      const root = await getRootDir(repick);
      return await downloadPackage(pkg, root, onProgress);
    } catch (err) {
      if (!(err && err.name === 'AbortError')) alert(`디시콘 다운로더 오류\n\n${(err && err.name) || 'Error'}: ${(err && err.message) || err}`);
      throw err;
    }
  }

  const IS_TOP = window.top === window;
  const isDcOrigin = (origin) => /^https?:\/\/([a-z0-9-]+\.)*dcinside\.com$/i.test(origin);
  const MSG = '__dcconDownloader';

  if (IS_TOP) {
    // iframe 안의 버튼이 보낸 다운로드 요청을 대신 처리한다.
    window.addEventListener('message', (ev) => {
      const data = ev.data;
      if (!data || data[MSG] !== 'start' || !isDcOrigin(ev.origin) || !ev.source) return;
      const reply = (msg) => ev.source.postMessage({ [MSG]: msg.type, id: data.id, ...msg }, ev.origin);
      reply({ type: 'ack' });
      runInThisWindow(data.pkg, data.repick, (done, total) => reply({ type: 'progress', done, total }))
        .then((result) => reply({ type: 'finished', result }))
        .catch((err) => reply({ type: 'error', name: (err && err.name) || 'Error', message: String((err && err.message) || err) }));
    });
  }

  // iframe 안이면 최상위 창에 요청을 넘기고 진행 상황을 받는다.
  function runViaTop(pkg, repick, onProgress) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      let acked = false;
      const timer = setTimeout(() => {
        if (acked) return;
        window.removeEventListener('message', onMessage);
        reject(new Error('바깥 페이지에서 스크립트가 응답하지 않습니다. 바깥 페이지를 새로고침해 보세요.'));
      }, 3000);
      function onMessage(ev) {
        const data = ev.data;
        if (!data || data.id !== id || !isDcOrigin(ev.origin)) return;
        if (data[MSG] === 'ack') acked = true;
        else if (data[MSG] === 'progress') onProgress(data.done, data.total);
        else if (data[MSG] === 'finished' || data[MSG] === 'error') {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (data[MSG] === 'finished') resolve(data.result);
          else reject(Object.assign(new Error(data.message), { name: data.name }));
        }
      }
      window.addEventListener('message', onMessage);
      window.top.postMessage({ [MSG]: 'start', id, pkg, repick }, '*');
    });
  }

  function addButton(popup) {
    const top = popup.querySelector('.viewtxt_top');
    if (!top || top.querySelector('.' + BTN_CLASS)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn_blue small ' + BTN_CLASS;
    btn.style.marginLeft = '4px';
    btn.textContent = '다운';
    btn.title = 'Shift+클릭: 통합 폴더 다시 고르기';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '받는 중';
      const onProgress = (done, total) => { btn.textContent = `받는 중 ${done}/${total}`; };
      try {
        const pkg = collect(popup);
        const result = IS_TOP ? await runInThisWindow(pkg, e.shiftKey, onProgress) : await runViaTop(pkg, e.shiftKey, onProgress);
        if (!result.total) btn.textContent = '이미지 없음';
        else btn.textContent = result.failed ? `완료 (${result.failed}개 실패)` : '완료 ✓';
        btn.title = `${result.folder} 에 저장됨 (Shift+클릭: 통합 폴더 다시 고르기)`;
      } catch (err) {
        console.warn('[디시콘 다운로더]', err);
        btn.textContent = err && err.name === 'AbortError' ? '다운' : '실패 - 다시 시도';
        btn.title = `${(err && err.name) || 'Error'}: ${(err && err.message) || err}`;
      }
      btn.disabled = false;
    });

    const titleEl = top.querySelector('h4');
    if (titleEl) titleEl.after(btn); else top.appendChild(btn);
  }

  function scan() {
    document.querySelectorAll('#package_detail').forEach(addButton);
  }

  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
