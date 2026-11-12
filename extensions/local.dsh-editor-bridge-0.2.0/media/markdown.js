/*
 * 极简 Markdown → HTML（侧栏专用）。
 *
 * 为什么自己写：webview 的 CSP 很窄、侧栏只需要标题/列表/代码块/行内代码/
 * 粗斜体/链接这几种；第三方渲染器体积大且要额外放开 CSP。这里先整体转义，
 * 再还原自己生成的标签，XSS 面天然很小。
 *
 * 暴露到 window.DshMarkdown.render，供 chat.js 与单元测试共用。
 */

(function () {
  /** HTML 转义，所有用户/模型文本进入 DOM 前必须过这一层。 */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /**
   * 渲染一段 Markdown 为 HTML 字符串。
   * @param {string} source 模型输出的原始文本（可能是流式未闭合片段）
   * @returns {string} 可直接赋给 innerHTML 的 HTML
   */
  function render(source) {
    let text = String(source == null ? '' : source);

    // 流式输出时围栏可能还没闭合；先补齐，避免半截代码块落到行内样式里。
    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 === 1) text += '\n```';

    // 1) 抽出围栏代码块（先抽走，后续转义与行内替换不会破坏代码内容）。
    const blocks = [];
    text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const index = blocks.length;
      blocks.push({ lang: String(lang || '').trim(), code });
      return `\u0000B${index}\u0000`;
    });

    // 2) 整体转义，之后只还原自己生成的标签。
    text = escapeHtml(text);

    // 3) 行内代码先占位，避免其中的 * _ [ ] 被当成标记。
    const inlines = [];
    text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
      const index = inlines.length;
      inlines.push(code);
      return `\u0000I${index}\u0000`;
    });

    // 4) 行内语法：粗体、斜体、链接。
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[\s(（])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');

    // 5) 行级结构：标题、有序/无序列表、引用、段落。
    const out = [];
    let list = '';
    const closeList = () => { if (list) { out.push(`</${list}>`); list = ''; } };
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = Math.min(6, heading[1].length + 2);
        out.push(`<h${level}>${heading[2]}</h${level}>`);
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || ordered) {
        const want = bullet ? 'ul' : 'ol';
        if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
        out.push(`<li>${(bullet || ordered)[1]}</li>`);
        continue;
      }
      closeList();
      if (!line) continue;
      if (/^&gt;\s?/.test(line)) {
        out.push(`<blockquote>${line.replace(/^&gt;\s?/, '')}</blockquote>`);
        continue;
      }
      out.push(`<p>${line}</p>`);
    }
    closeList();

    // 6) 还原行内代码与代码块。
    let html = out.join('\n');
    html = html.replace(/\u0000I(\d+)\u0000/g, (_m, index) => `<code>${inlines[Number(index)]}</code>`);
    html = html.replace(/\u0000B(\d+)\u0000/g, (_m, index) => {
      const block = blocks[Number(index)];
      const lang = escapeHtml(block.lang || 'code');
      return '<div class="code">'
        + `<div class="code-bar"><span>${lang}</span>`
        + `<button class="copy" type="button" data-code="${encodeURIComponent(block.code)}">复制</button></div>`
        + `<pre><code>${escapeHtml(block.code)}</code></pre></div>`;
    });
    return html;
  }

  window.DshMarkdown = { render, escapeHtml };
}());