'use strict';
(() => {
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = String(text); return el; };
  const entities = text => String(text || '').replace(/&(?:#(x[\da-f]+|\d+)|(amp|lt|gt|quot|apos|nbsp));/gi, (raw, number, name) => {
    if (name) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' })[name.toLowerCase()];
    const code = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  });
  if (window.marked) window.marked.use({ gfm: true, breaks: true, extensions: [
    { name: 'mathBlock', level: 'block', start: text => { const match = /\$\$|\\\[/.exec(text); return match?.index; }, tokenizer(text) {
      const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(text);
      if (match) return { type: 'mathBlock', raw: match[0], text: match[1] || match[2] };
    } },
    { name: 'mathInline', level: 'inline', start: text => { const match = /\$(?!\s)|\\\(/.exec(text); return match?.index; }, tokenizer(text) {
      const match = /^(?:\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)|\\\(([^\n]+?)\\\))/.exec(text);
      if (match) return { type: 'mathInline', raw: match[0], text: match[1] || match[2] };
    } },
  ] });
  function math(text, display) {
    const el = node(display ? 'div' : 'span', display ? 'math-block' : 'math-inline');
    try {
      if (!window.katex || String(text).length > 8000) throw new Error('Formula unavailable');
      // Native MathML avoids inline-style/font dependencies; links, HTML and external images remain untrusted.
      window.katex.render(text, el, { displayMode: display, output: 'mathml', trust: false, throwOnError: true, strict: 'error', maxExpand: 200, maxSize: 20 });
    } catch { el.append(node('code', 'math-source', text)); }
    return el;
  }
  function render(element, value, hooks = {}) {
    element.replaceChildren(); element.classList.add('rich-content');
    const input = String(value || '');
    if (!window.marked || input.length > 150000) { if (hooks.text) hooks.text(element, input); else element.textContent = input; return; }
    let budget = 6000;
    const text = (target, content) => { if (hooks.text) hooks.text(target, entities(content)); else target.append(document.createTextNode(entities(content))); };
    const walk = (target, tokens, depth = 0) => {
      if (depth > 30 || budget <= 0) { target.append(document.createTextNode('[内容较长，请查看原文]')); return; }
      for (const token of tokens || []) {
        if (--budget < 0) break;
        let child;
        switch (token.type) {
          case 'space': break;
          case 'text': if (token.tokens) walk(target, token.tokens, depth + 1); else text(target, token.text); break;
          case 'escape': text(target, token.text); break;
          case 'html': target.append(document.createTextNode(token.raw || token.text || '')); break;
          case 'br': target.append(node('br')); break;
          case 'hr': target.append(node('hr')); break;
          case 'mathInline': case 'mathBlock': target.append(math(token.text, token.type === 'mathBlock')); break;
          case 'strong': case 'em': case 'del': child = node(token.type); walk(child, token.tokens, depth + 1); target.append(child); break;
          case 'heading': child = node('h' + Math.max(2, Math.min(6, token.depth))); walk(child, token.tokens, depth + 1); target.append(child); break;
          case 'paragraph': case 'blockquote': child = node(token.type === 'paragraph' ? 'p' : 'blockquote'); walk(child, token.tokens, depth + 1); target.append(child); break;
          case 'code': {
            const box = node('div', 'code-block'), header = node('div', 'code-heading'), copy = node('button', 'text-button', '复制代码');
            header.append(node('span', '', String(token.lang || '代码').slice(0, 60)), copy); copy.type = 'button';
            copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(token.text); copy.textContent = '已复制'; } catch { copy.textContent = '请长按选择复制'; } });
            const pre = node('pre'), code = node('code', '', token.text); pre.append(code); box.append(header, pre); target.append(box); break;
          }
          case 'codespan': child = /[\\/]|\.[a-z\d]{1,8}(?::\d+)?$/i.test(token.text) ? hooks.link?.(token.text, token.text) : null; target.append(child || node('code', '', entities(token.text))); break;
          case 'link': case 'image': {
            const label = entities(token.text || token.href || '文件'); child = hooks.link?.(token.href, label);
            target.append(child || document.createTextNode(label)); break;
          }
          case 'list': {
            child = node(token.ordered ? 'ol' : 'ul'); if (token.ordered && Number.isSafeInteger(token.start)) child.start = token.start;
            for (const item of token.items || []) { const li = node('li'); if (item.task) { const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = item.checked; checkbox.disabled = true; li.append(checkbox); } walk(li, item.tokens, depth + 1); child.append(li); }
            target.append(child); break;
          }
          case 'table': {
            const wrap = node('div', 'markdown-table-scroll'), table = node('table'), head = node('thead'), header = node('tr'), body = node('tbody');
            for (const cell of token.header || []) { const th = node('th'); th.scope = 'col'; walk(th, cell.tokens, depth + 1); header.append(th); } head.append(header);
            for (const cells of token.rows || []) { const row = node('tr'); for (const cell of cells) { const td = node('td'); walk(td, cell.tokens, depth + 1); row.append(td); } body.append(row); }
            table.append(head, body); wrap.append(table); target.append(wrap); break;
          }
          default: text(target, token.raw || token.text || '');
        }
      }
    };
    try { walk(element, window.marked.lexer(input)); }
    catch { element.replaceChildren(document.createTextNode(input)); }
  }
  function safeUrl(value) {
    if (typeof value !== 'string' || !value.startsWith('/api/')) return null;
    try { const url = new URL(value, location.origin); return url.origin === location.origin && /^\/api\/(?:attachments|projects)\//.test(url.pathname) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  function fileType(name) {
    const extension = String(name || '').split('.').at(-1).toLowerCase();
    return /^(zip|7z|rar|gz|tar)$/.test(extension) ? 'ZIP' : extension === 'pdf' ? 'PDF' : /^(docx?|odt)$/.test(extension) ? 'DOC' : /^(xlsx?|csv|tsv)$/.test(extension) ? 'XLS' : /^(pptx?|odp)$/.test(extension) ? 'PPT' : /^(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(extension) ? 'IMG' : /^(js|mjs|ts|tsx|jsx|py|cs|cpp|go|rs|java|html|css|json|xml|yaml|yml|sh|ps1)$/.test(extension) ? 'CODE' : 'TXT';
  }
  function card(attachment, onPreview) {
    const box = node('div', 'attachment-card'); box.dataset.attachmentId = attachment.id || '';
    const preview = safeUrl(attachment.previewUrl), download = safeUrl(attachment.downloadUrl);
    const image = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(attachment.mime || '') && preview;
    const type = fileType(attachment.name);
    const glyph = node('span', 'attachment-glyph', attachment.kind === 'image' ? '▧' : type); glyph.dataset.type = type;
    if (image) { const img = node('img'); img.src = preview; img.alt = ''; img.loading = 'lazy'; img.addEventListener('error', () => glyph.replaceChildren(document.createTextNode('▧'))); glyph.replaceChildren(img); }
    const info = node('div', 'attachment-info'); info.append(node('strong', '', attachment.name || '附件'));
    const size = Number(attachment.size); info.append(node('small', '', `${attachment.kind === 'image' ? '图片' : type + ' 文件'}${attachment.size != null && Number.isFinite(size) ? ' · ' + (size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : size >= 1024 ? Math.ceil(size / 1024) + ' KB' : size + ' B') : ''}`));
    const button = node('button', 'attachment-preview'); button.type = 'button'; button.append(glyph, info); button.disabled = !preview; button.setAttribute('aria-label', '预览 ' + (attachment.name || '附件')); button.addEventListener('click', () => onPreview(attachment)); box.append(button);
    if (download) { const link = node('a', 'attachment-download', '下载'); link.href = download; link.download = attachment.name || ''; link.setAttribute('aria-label', '下载 ' + (attachment.name || '附件')); box.append(link); }
    return box;
  }
  window.CodexRich = Object.freeze({ render, safeUrl, card, fileType });
})();
