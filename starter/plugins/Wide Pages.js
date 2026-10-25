/**
 * Wide Pages
 * Lets pages use more of the window instead of a narrow column in the middle.
 * It only changes one CSS variable, it never changes your pages.
 *
 * @notiskin-setting {"key":"active","type":"toggle","label":"Widen pages","default":true}
 * @notiskin-setting {"key":"width","type":"number","label":"Page width in pixels","default":1100,"min":720,"max":2400,"step":20}
 * @notiskin-setting {"key":"full","type":"toggle","label":"Use the whole window","default":false,"description":"Ignores the width above."}
 */
const settings = notiskin.settings;

const style = document.createElement('style');
style.id = 'notiskin-wide-pages';
document.head.appendChild(style);

function apply() {
  if (!settings.get('active')) {
    style.textContent = '';
    return;
  }
  const width = settings.get('full') ? '100%' : settings.get('width') + 'px';
  style.textContent = '.layout { --content-width: minmax(auto, ' + width + ') !important; }';
}

apply();
settings.onChange(apply);
