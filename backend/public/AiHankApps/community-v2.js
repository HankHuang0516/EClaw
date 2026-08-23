(() => {
  'use strict';

  const apps = {
    'EClawbot': { id: 'eclawbot', shots: ['eclawbot/01.jpg','eclawbot/02.jpg','eclawbot/03.jpg','eclawbot/04.jpg','eclawbot/05.jpg','eclawbot/06.jpg'] },
    '活字戰紀：雙城烽火': { id: 'typeforge-twin-cities', shots: ['typeforge/01.jpg','typeforge/02.jpg','typeforge/03.jpg','typeforge/04.jpg','typeforge/05.jpg','typeforge/06.jpg','typeforge/07.jpg','typeforge/08.jpg'] },
    'Weesh': { id: 'weesh', shots: ['weesh/01.png','weesh/02.png','weesh/03.png','weesh/04.png','weesh/05.png'] },
    '世界末日了沒': { id: 'doomsday-index', shots: ['doomsday/01.jpg','doomsday/02.jpg','doomsday/03.jpg','doomsday/04.jpg'] },
    '夢話夥伴': { id: 'dreambuddy', shots: ['dreambuddy/01.jpg','dreambuddy/02.jpg','dreambuddy/03.jpg'] },
    '房東投報快算': { id: 'property-roi', shots: ['property/01.jpg','property/02.jpg','property/03.jpg','property/04.jpg'] },
    '活字戰記：巔峰之戰': { id: 'summit-battle', shots: [] },
    '浪浪地圖': { id: 'stray-map', shots: ['straymap/01.jpg','straymap/02.jpg','straymap/03.jpg','straymap/04.jpg','straymap/05.jpg','straymap/06.jpg','straymap/07.jpg','straymap/08.jpg','straymap/09.jpg','straymap/10.jpg','straymap/11.jpg','straymap/12.jpg','straymap/13.jpg'] },
    '睡公園：免費生存地圖': { id: 'sleep-park', shots: ['sleeppark/01.jpg','sleeppark/02.jpg','sleeppark/03.jpg','sleeppark/04.jpg'] },
    '這樣出門': { id: 'chumen', shots: ['chumen/01.jpg','chumen/02.jpg','chumen/03.jpg','chumen/04.jpg','chumen/05.jpg'] },
    '遺名之歌': { id: 'echoes-of-names', shots: [] }
  };

  const apiBase = location.hostname === 'eclawbot.com' || location.hostname === 'www.eclawbot.com'
    ? ''
    : 'https://eclawbot.com';
  const assetBase = location.protocol === 'file:' ? 'public/promo/' : 'promo/';
  const visitorKey = 'aihankapps-visitor-id';
  const nicknameKey = 'aihankapps-nickname';

  function visitorId() {
    let value = localStorage.getItem(visitorKey);
    if (!value) {
      value = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(visitorKey, value);
    }
    return value;
  }

  function findCards() {
    return [...document.querySelectorAll('h3')].map(heading => {
      const config = apps[heading.textContent.trim()];
      if (!config) return null;
      return { heading, config, card: heading.closest('article, .app-card, .card') || heading.parentElement.parentElement };
    }).filter(Boolean);
  }

  function addGallery(card, heading, config) {
    card.querySelectorAll('.promo-media').forEach(node => node.remove());
    if (!config.shots.length) return;
    const gallery = document.createElement('div');
    gallery.className = 'store-gallery';
    gallery.setAttribute('aria-label', `${heading.textContent.trim()} 商店宣傳圖`);
    const track = document.createElement('div');
    track.className = 'store-gallery-track';
    config.shots.forEach((shot, index) => {
      const figure = document.createElement('figure');
      figure.className = 'store-shot';
      const image = document.createElement('img');
      image.src = assetBase + shot;
      image.alt = `${heading.textContent.trim()} 宣傳圖 ${index + 1}`;
      image.loading = 'lazy';
      const count = document.createElement('span');
      count.className = 'store-shot-count';
      count.textContent = `${index + 1} / ${config.shots.length}`;
      figure.append(image, count);
      track.appendChild(figure);
    });
    gallery.appendChild(track);
    const head = card.querySelector('.card-head') || heading.parentElement;
    head.insertAdjacentElement('afterend', gallery);
  }

  function makeCommentItem(comment) {
    const item = document.createElement('li');
    item.className = 'comment-item';
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = comment.nickname;
    const time = document.createElement('time');
    time.dateTime = comment.createdAt;
    time.textContent = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(comment.createdAt));
    const body = document.createElement('p');
    body.className = 'comment-body';
    body.textContent = comment.content;
    meta.append(author, time);
    item.append(meta, body);
    return item;
  }

  async function request(path, options = {}) {
    const response = await fetch(apiBase + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '目前無法連線，請稍後再試。');
    return data;
  }

  function addCommunity(card, config) {
    const section = document.createElement('section');
    section.className = 'app-community';
    section.dataset.appId = config.id;
    const actions = document.createElement('div');
    actions.className = 'community-actions';
    const like = document.createElement('button');
    like.type = 'button';
    like.className = 'like-button';
    like.innerHTML = '<span class="like-heart" aria-hidden="true">♡</span><span class="like-label">喜歡</span> <span class="like-count">0</span>';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'discussion-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '留言討論 0';
    actions.append(like, toggle);

    const panel = document.createElement('div');
    panel.className = 'discussion-panel';
    panel.hidden = true;
    const form = document.createElement('form');
    form.className = 'comment-form';
    const nickField = document.createElement('div');
    nickField.className = 'comment-field';
    nickField.innerHTML = '<label>暱稱</label>';
    const nickname = document.createElement('input');
    nickname.name = 'nickname';
    nickname.maxLength = 30;
    nickname.required = true;
    nickname.placeholder = '怎麼稱呼你？';
    nickname.value = localStorage.getItem(nicknameKey) || '';
    nickField.appendChild(nickname);
    const textField = document.createElement('div');
    textField.className = 'comment-field';
    textField.innerHTML = '<label>留言</label>';
    const content = document.createElement('textarea');
    content.name = 'content';
    content.maxLength = 500;
    content.rows = 2;
    content.required = true;
    content.placeholder = '分享你的想法或使用心得';
    textField.appendChild(content);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'comment-submit';
    submit.textContent = '送出';
    form.append(nickField, textField, submit);
    const list = document.createElement('ul');
    list.className = 'comment-list';
    const note = document.createElement('p');
    note.className = 'community-note';
    note.textContent = '載入討論中…';
    panel.append(form, list, note);
    section.append(actions, panel);
    card.appendChild(section);

    function render(data) {
      like.classList.toggle('is-liked', Boolean(data.liked));
      like.querySelector('.like-heart').textContent = data.liked ? '♥' : '♡';
      like.querySelector('.like-count').textContent = String(data.likeCount || 0);
      const comments = data.comments || [];
      toggle.textContent = `留言討論 ${data.commentCount ?? comments.length}`;
      list.replaceChildren(...comments.map(makeCommentItem));
      note.classList.remove('is-error');
      note.textContent = comments.length ? '每款 APP 都有自己的獨立討論。' : '還沒有留言，歡迎留下第一則想法。';
    }

    const load = () => request(`/api/app-portfolio/apps/${config.id}/community?visitorId=${encodeURIComponent(visitorId())}`).then(render);
    load().catch(error => { note.textContent = error.message; note.classList.add('is-error'); });

    like.addEventListener('click', async () => {
      like.disabled = true;
      try {
        const data = await request(`/api/app-portfolio/apps/${config.id}/like`, {
          method: 'POST', body: JSON.stringify({ visitorId: visitorId() })
        });
        render({ ...data, comments: [...list.children].map(() => null).filter(Boolean) });
        await load();
      } catch (error) {
        note.textContent = error.message;
        note.classList.add('is-error');
      } finally { like.disabled = false; }
    });

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) load().catch(error => { note.textContent = error.message; note.classList.add('is-error'); });
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      localStorage.setItem(nicknameKey, nickname.value.trim());
      try {
        await request(`/api/app-portfolio/apps/${config.id}/comments`, {
          method: 'POST',
          body: JSON.stringify({ visitorId: visitorId(), nickname: nickname.value, content: content.value })
        });
        content.value = '';
        await load();
      } catch (error) {
        note.textContent = error.message;
        note.classList.add('is-error');
      } finally { submit.disabled = false; }
    });
  }

  function normalizeStoreControls(card) {
    const cardText = card.textContent;
    const readyWords = '正式版|已發布|已可發布';
    [...card.querySelectorAll('a')].forEach(link => {
      const text = link.textContent.trim();
      const platform = text.includes('Google Play') ? 'Google Play' : text.includes('App Store') ? 'App Store' : null;
      if (!platform) return;
      const platformStatus = new RegExp(`${platform}\\s*[：:]?[^・\\n]*(${readyWords})`).test(cardText);
      const linkStatus = new RegExp(readyWords).test(text);
      if (platformStatus || linkStatus) {
        link.textContent = platform === 'Google Play' ? '▶ Google Play' : '● App Store';
        return;
      }
      const development = document.createElement('span');
      development.className = 'store-development';
      development.textContent = `${platform} 開發中`;
      link.replaceWith(development);
    });
    [...card.querySelectorAll('p, .store-status, .availability, .release-status')].forEach(node => {
      const text = node.textContent.trim();
      if (text.includes('Google Play：') || text.includes('App Store：')) node.remove();
    });
  }

  function reorderCategories() {
    const priority = new Map([['遊戲', 0], ['公益', 1], ['生活', 2]]);
    const headings = [...document.querySelectorAll('h2')];
    const sections = headings.map(heading => ({
      heading,
      section: heading.closest('.category-section, section')
    })).filter(item => item.section);
    if (!sections.length) return;
    const parent = sections[0].section.parentElement;
    if (!parent || sections.some(item => item.section.parentElement !== parent)) return;
    sections.sort((a, b) => {
      const rank = item => {
        const name = [...priority.keys()].find(key => item.heading.textContent.trim().startsWith(key));
        return name ? priority.get(name) : Number.MAX_SAFE_INTEGER;
      };
      return rank(a) - rank(b);
    });
    sections.forEach(item => parent.appendChild(item.section));
  }

  function enhance() {
    reorderCategories();
    findCards().forEach(({ card, heading, config }) => {
      if (!card || card.dataset.communityReady) return;
      card.dataset.communityReady = 'true';
      normalizeStoreControls(card);
      addGallery(card, heading, config);
      addCommunity(card, config);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhance);
  else enhance();
})();
