/**
 * Numbered Headings
 * Numbers the headings on a page: 1, 2, 3 for big headings, and 1.1, 1.2 for the ones under them.
 * It only adds numbers with CSS, it never changes your pages or what is saved in them.
 *
 * @notiskin-setting {"key":"active","type":"toggle","label":"Number the headings","default":true}
 * @notiskin-setting {"key":"sub","type":"toggle","label":"Number the smaller headings too (1.1, 1.1.1)","default":true}
 */
const settings = notiskin.settings;

const style = document.createElement('style');
style.id = 'notiskin-numbered-headings';
document.head.appendChild(style);

// each heading sits two wrappers deep, and those wrappers are siblings, so the counters follow the page order
function heading(kind) {
  return '.notion-page-content div:has(> div > .notion-' + kind + '-block)';
}

function apply() {
  if (!settings.get('active')) {
    style.textContent = '';
    return;
  }
  const rules = [
    '.notion-page-content { counter-reset: ns-h1; }',
    heading('header') + ' { counter-increment: ns-h1; counter-reset: ns-h2 ns-h3; }',
    '.notion-header-block h2::before { content: counter(ns-h1) ". "; }',
  ];
  if (settings.get('sub')) {
    rules.push(
      heading('sub_header') + ' { counter-increment: ns-h2; counter-reset: ns-h3; }',
      heading('sub_sub_header') + ' { counter-increment: ns-h3; }',
      '.notion-sub_header-block h3::before { content: counter(ns-h1) "." counter(ns-h2) " "; }',
      '.notion-sub_sub_header-block h4::before { content: counter(ns-h1) "." counter(ns-h2) "." counter(ns-h3) " "; }'
    );
  }
  style.textContent = rules.join('\n');
}

apply();
settings.onChange(apply);
