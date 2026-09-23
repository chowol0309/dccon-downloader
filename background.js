// 통합 폴더: 다운로드 폴더 기준 상대 경로
const ROOT_FOLDER = '디시콘';
const CONCURRENCY = 4;

// 디시콘 이미지는 Referer가 디시 주소가 아니면 403을 준다.
// 확장(탭 밖, tabId -1)에서 보내는 이미지 요청에만 Referer를 붙인다.
const REFERER_RULE = {
  id: 1,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://gall.dcinside.com/' }],
  },
  condition: {
    regexFilter: '^https?://dcimg[0-9]*\\.dcinside\\.com/',
    resourceTypes: ['xmlhttprequest', 'other'],
    tabIds: [chrome.tabs.TAB_ID_NONE],
  },
};
const ruleReady = chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERER_RULE.id], addRules: [REFERER_RULE] });

const EXT_BY_TYPE = { 'image/png': 'png', 'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/bmp': 'bmp' };

// 윈도우 파일 이름에 못 쓰는 문자와 끝의 점·공백을 정리한다.
function sanitize(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80);
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned) || !cleaned ? fallback : cleaned;
}

function extFor(contentType, disposition) {
  const fromDisposition = /filename="?[^";]*\.([a-z0-9]+)"?/i.exec(disposition || '');
  if (fromDisposition) return fromDisposition[1].toLowerCase();
  return EXT_BY_TYPE[(contentType || '').split(';')[0].trim()] || 'png';
}

function toDataUrl(buffer, contentType) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${contentType || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function downloadOne(image, index, total, folder) {
  const res = await fetch(image.url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('이미지가 아님: ' + type);
  const ext = extFor(type, res.headers.get('content-disposition'));
  const number = String(index + 1).padStart(Math.max(2, String(total).length), '0');
  const label = sanitize(image.name, '');
  const filename = `${folder}/${number}${label && label !== String(index + 1) ? '_' + label : ''}.${ext}`;
  await chrome.downloads.download({
    url: toDataUrl(await res.arrayBuffer(), type),
    filename,
    conflictAction: 'overwrite',
    saveAs: false,
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dccon-download') return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'download') return;
    await ruleReady;
    const folder = `${ROOT_FOLDER}/${sanitize(msg.title, '이름없는디시콘')}`;
    const images = msg.images;
    let done = 0, failed = 0, next = 0;
    const post = (m) => { try { port.postMessage(m); } catch (_) { /* 창이 닫힘 */ } };

    async function worker() {
      while (next < images.length) {
        const i = next++;
        try { await downloadOne(images[i], i, images.length, folder); }
        catch (err) { failed++; console.warn('[디시콘 다운로더]', images[i].url, err); }
        done++;
        post({ type: 'progress', done, total: images.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, images.length) }, worker));
    post({ type: 'finished', failed, folder });
  });
});
