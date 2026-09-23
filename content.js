// 디시콘 정보 창(#package_detail)이 뜰 때마다 제목 옆에 "다운" 버튼을 붙인다.
(() => {
  const BTN_CLASS = 'dccon-dl-btn';

  // 갤러리 창은 h4.con_title, 디시콘샵 창은 h4.font_blue라서 h4로 찾고, 없으면 대표 이미지 alt를 쓴다.
  function popupTitle(popup) {
    const h4 = popup.querySelector('.viewtxt_top h4, .info_viewtxt h4');
    return (h4?.textContent || popup.querySelector('.info_viewimg img')?.alt || '').trim();
  }

  function packageInfo(popup) {
    const title = popupTitle(popup) || '이름없는디시콘';
    const images = [...popup.querySelectorAll('.dccon_list img')]
      .map((img) => ({ url: new URL(img.getAttribute('src'), location.href).href, name: (img.getAttribute('title') || img.alt || '').trim() }));
    return { title, images };
  }

  function addButton(popup) {
    const top = popup.querySelector('.viewtxt_top');
    if (!top || top.querySelector('.' + BTN_CLASS)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn_blue small ' + BTN_CLASS;
    btn.textContent = '다운';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;
      const info = packageInfo(popup);
      if (!info.images.length) { btn.textContent = '이미지 없음'; return; }

      btn.disabled = true;
      btn.textContent = `받는 중 0/${info.images.length}`;
      const port = chrome.runtime.connect({ name: 'dccon-download' });
      port.onMessage.addListener((msg) => {
        if (msg.type === 'progress') btn.textContent = `받는 중 ${msg.done}/${msg.total}`;
        if (msg.type === 'finished') {
          btn.textContent = msg.failed ? `완료 (${msg.failed}개 실패)` : '완료 ✓';
          btn.title = `다운로드/${msg.folder}`;
          btn.disabled = false;
          port.disconnect();
        }
      });
      port.onDisconnect.addListener(() => { if (btn.disabled) { btn.textContent = '실패 - 다시 시도'; btn.disabled = false; } });
      port.postMessage({ type: 'download', ...info });
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
