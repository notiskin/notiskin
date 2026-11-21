// What a plugin says it does, and what a scan of its code finds. A review aid, never enforcement: a plugin runs
// with full access inside Notion's page, it can read every page and send data out through an image or a CSS
// url(), and nothing here stops that. The app and the marketplace reviewer see both lists side by side.
//
// A plugin declares what it does in the same header comment as its settings, one line each:
//
//   /**
//    * @notiskin-permission network api.example.com *.example.org
//    * @notiskin-permission storage
//    */
//
// network <host> [<host> ...]  hosts it contacts
// storage                      cookies, localStorage, sessionStorage or IndexedDB
// page-scripts                 Notion's own JavaScript (its globals, React internals)
// dynamic-code                 eval, new Function, import(), script elements
//
// The header is read as text and the code is parsed, never run. A line that doesn't make sense is skipped with a
// sentence in `problems`, the rest still count. The scan reads the code for things that look like each of those and
// can be fooled (it says so with a `hidden-access` note when it sees a name it can't read)
import { parse } from 'acorn';
import { headerComments } from './plugin-settings';

export type PermissionName = 'network' | 'storage' | 'page-scripts' | 'dynamic-code';
export const PERMISSION_NAMES: PermissionName[] = ['network', 'storage', 'page-scripts', 'dynamic-code'];

export interface DeclaredPermissions {
  // in the order of PERMISSION_NAMES
  declared: PermissionName[];
  // hosts from every network line, lowercase, no duplicates
  hosts: string[];
  problems: string[];
}

export interface Evidence {
  category: PermissionName | 'hidden-access';
  line: number;
  what: string;
}

export interface ScanResult {
  detected: PermissionName[];
  // one entry per thing seen, by line, for detected categories
  evidence: Evidence[];
  // hidden-access notes: places where the code reaches for a name the scan can't read
  notes: Evidence[];
  // hosts in web addresses written in the code, for information only
  hosts: string[];
  problems: string[];
}

export interface PermissionReport {
  permissions: DeclaredPermissions;
  scan: ScanResult & {
    // detected but not declared
    undeclared: PermissionName[];
    // hosts in the code that no network line covers
    unlistedHosts: string[];
  };
}

export const MAX_HOSTS_PER_LINE = 10;
export const MAX_HOSTS = 20;
const MAX_LINE_CHARS = 1_000;
const MAX_EVIDENCE = 60;
const TAG = '@notiskin-permission';
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// api.example.com or *.example.com: lowercase letters, digits, dots and dashes, at least two labels after an
// optional leading "*.", so "*.com" (every site) doesn't count as a host
export function isValidHost(host: string): boolean {
  if (host.length > 253) return false;
  const rest = host.startsWith('*.') ? host.slice(2) : host;
  const labels = rest.split('.');
  return labels.length >= 2 && labels.every(l => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]);
}

function sorted(names: Set<PermissionName>): PermissionName[] {
  return PERMISSION_NAMES.filter(n => names.has(n));
}

export function parsePermissionDeclarations(source: string): DeclaredPermissions {
  const declared = new Set<PermissionName>();
  const hosts: string[] = [];
  const problems: string[] = [];
  let hostLimitHit = false;
  for (const rawLine of headerComments(source).split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*\*?\s*/, '').trim();
    if (line !== TAG && !line.startsWith(`${TAG} `) && !line.startsWith(`${TAG}\t`)) continue;
    if (line.length > MAX_LINE_CHARS) {
      problems.push(`A permission line is longer than ${MAX_LINE_CHARS} characters, skipped.`);
      continue;
    }
    const [name, ...args] = line.slice(TAG.length).trim().split(/\s+/).filter(Boolean);
    if (!name) {
      problems.push('Skipped a permission line with no name. Use network, storage, page-scripts or dynamic-code.');
      continue;
    }
    if (name === 'network') {
      if (!args.length) {
        problems.push('Skipped a network line that names no hosts, like: network api.example.com');
        continue;
      }
      if (args.length > MAX_HOSTS_PER_LINE) {
        problems.push(`Skipped a network line with more than ${MAX_HOSTS_PER_LINE} hosts. Split it over more lines.`);
        continue;
      }
      const bad = args.find(h => !isValidHost(h));
      if (bad !== undefined) {
        problems.push(`Skipped a network line: "${bad.slice(0, 60)}" isn't a host name like api.example.com or *.example.com (lowercase, no https://).`);
        continue;
      }
      declared.add('network');
      for (const host of args) {
        if (hosts.includes(host)) continue;
        if (hosts.length >= MAX_HOSTS) {
          if (!hostLimitHit) problems.push(`Only the first ${MAX_HOSTS} hosts are used.`);
          hostLimitHit = true;
          break;
        }
        hosts.push(host);
      }
      continue;
    }
    if (name === 'storage' || name === 'page-scripts' || name === 'dynamic-code') {
      if (args.length) {
        problems.push(`Skipped "${name} ${args.join(' ').slice(0, 40)}": ${name} takes nothing after it.`);
        continue;
      }
      declared.add(name);
      continue;
    }
    problems.push(`Skipped an unknown permission "${name.slice(0, 40)}". Use network, storage, page-scripts or dynamic-code.`);
  }
  return { declared: sorted(declared), hosts, problems };
}

// ---- the scan ----

interface Node {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && typeof (v as Node).type === 'string';

// the objects that hold the page's globals
const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);
const HIDDEN_ACCESS_OBJECTS = new Set([...GLOBAL_OBJECTS, 'document']);

// browser globals that mean a category whenever the code reaches for them
const GLOBALS: Record<string, [PermissionName, string]> = {
  fetch: ['network', 'fetch'],
  XMLHttpRequest: ['network', 'XMLHttpRequest'],
  WebSocket: ['network', 'WebSocket'],
  EventSource: ['network', 'EventSource'],
  Image: ['network', 'new Image'],
  RTCPeerConnection: ['network', 'RTCPeerConnection'],
  open: ['network', 'window.open'],
  localStorage: ['storage', 'localStorage'],
  sessionStorage: ['storage', 'sessionStorage'],
  indexedDB: ['storage', 'indexedDB'],
  cookieStore: ['storage', 'cookieStore'],
  eval: ['dynamic-code', 'eval'],
  Function: ['dynamic-code', 'Function'],
  WebAssembly: ['dynamic-code', 'WebAssembly'],
  Worker: ['dynamic-code', 'Worker'],
  SharedWorker: ['dynamic-code', 'SharedWorker'],
};

// own keys only, so "constructor" or "toString" don't find Object's
function lookup(table: Record<string, [PermissionName, string]>, name: string): [PermissionName, string] | undefined {
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
}

// property names that mean a category on any object
const PROPERTIES: Record<string, [PermissionName, string]> = {
  sendBeacon: ['network', 'navigator.sendBeacon'],
  cookie: ['storage', 'document.cookie'],
  localStorage: ['storage', 'localStorage'],
  sessionStorage: ['storage', 'sessionStorage'],
  indexedDB: ['storage', 'indexedDB'],
  cookieStore: ['storage', 'cookieStore'],
};

// calling one of these with HTML can load images and other files
const HTML_CALLS = new Set(['insertAdjacentHTML', 'createContextualFragment', 'setHTMLUnsafe']);
const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
// setting one of these on an element loads (or sends to) an address
const URL_PROPERTIES = new Set(['src', 'href', 'srcset', 'action', 'formAction', 'poster']);
const URL_ATTRIBUTES = new Set(['src', 'href', 'srcset', 'action', 'formaction', 'poster', 'xlink:href']);
// elements that load something from an address
const LOADING_TAGS = new Set(['img', 'script', 'link', 'iframe', 'frame', 'video', 'audio', 'source', 'embed', 'object', 'image', 'track']);
const TIMER_CALLS = new Set(['setTimeout', 'setInterval', 'setImmediate']);

// Notion's own code: React's internal keys on elements, and globals Notion's bundle leaves on window
const REACT_KEYS = /(__reactFiber|__reactProps|__reactContainer|__reactInternalInstance|__reactEventHandlers|_reactRootContainer|_reactInternals)/;
const PAGE_GLOBAL = /^(__notion|__NEXT_DATA__$|__REDUX|webpackChunk|__webpack_require__$|__REACT_DEVTOOLS_GLOBAL_HOOK__$)/;

const WEB_ADDRESS = /\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi;

function line(node: Node): number {
  return node.loc?.start.line ?? 0;
}

function parseCode(code: string): Node | null {
  const base = { ecmaVersion: 'latest' as const, locations: true, allowHashBang: true };
  for (const sourceType of ['script', 'module'] as const) {
    try {
      return parse(code, { ...base, sourceType, allowReturnOutsideFunction: sourceType === 'script', allowAwaitOutsideFunction: true }) as unknown as Node;
    } catch {}
  }
  return null;
}

// every name the code declares itself (variables, functions, classes, parameters, catch clauses), so a plugin's own
// `open` or `fetch` function isn't taken for the browser's. Shadowing isn't tracked: a name declared anywhere counts
function declaredNames(root: Node): Set<string> {
  const names = new Set<string>();
  const addPattern = (p: unknown): void => {
    if (!isNode(p)) return;
    if (p.type === 'Identifier') names.add(p.name as string);
    else if (p.type === 'ObjectPattern') for (const prop of p.properties as Node[]) addPattern(prop.type === 'RestElement' ? prop.argument : prop.value);
    else if (p.type === 'ArrayPattern') for (const el of p.elements as unknown[]) addPattern(el);
    else if (p.type === 'RestElement') addPattern(p.argument);
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
  };
  walk(root, node => {
    if (node.type === 'VariableDeclarator') addPattern(node.id);
    if (/Function/.test(node.type)) {
      addPattern(node.id);
      for (const p of (node.params as unknown[]) ?? []) addPattern(p);
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') addPattern(node.id);
    if (node.type === 'CatchClause') addPattern(node.param);
    if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') addPattern(node.local);
  });
  return names;
}

function walk(node: Node, visit: (node: Node, parent: Node | null) => void, parent: Node | null = null): void {
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, node);
    } else if (isNode(value)) {
      walk(value, visit, node);
    }
  }
}

// the property a member expression names, if the scan can read it: a.b, a['b'], a[`b`]
function propertyName(member: Node): string | null {
  const prop = member.property as Node;
  if (!member.computed) return prop.type === 'Identifier' || prop.type === 'PrivateIdentifier' ? (prop.name as string) : null;
  if (prop.type === 'Literal' && typeof prop.value === 'string') return prop.value;
  if (prop.type === 'TemplateLiteral' && (prop.expressions as unknown[]).length === 0) return ((prop.quasis as Node[])[0].value as { cooked: string }).cooked;
  return null;
}

function stringValue(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) return ((node.quasis as Node[])[0].value as { cooked: string }).cooked;
  return null;
}

// text built from strings, so a timer given 'code' or 'co' + 'de' or `code ${x}` counts as text
function looksLikeText(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'TemplateLiteral') return true;
  if (node.type === 'BinaryExpression' && node.operator === '+') return looksLikeText(node.left) || looksLikeText(node.right);
  return false;
}

function objectName(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === 'Identifier') return node.name as string;
  if (node.type === 'MemberExpression') return propertyName(node);
  return null;
}

export function scanPlugin(code: string): ScanResult {
  const root = parseCode(String(code ?? ''));
  if (!root) return { detected: [], evidence: [], notes: [], hosts: [], problems: ["Couldn't read the code to scan it."] };

  const own = declaredNames(root);
  const detected = new Set<PermissionName>();
  const evidence: Evidence[] = [];
  const notes: Evidence[] = [];
  const hosts = new Set<string>();
  const seen = new Set<string>();

  const add = (category: Evidence['category'], node: Node, what: string): void => {
    const key = `${category}|${line(node)}|${what}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (category === 'hidden-access') {
      if (notes.length < MAX_EVIDENCE) notes.push({ category, line: line(node), what });
      return;
    }
    detected.add(category);
    if (evidence.length < MAX_EVIDENCE) evidence.push({ category, line: line(node), what });
  };

  const checkText = (text: string, node: Node): void => {
    if (/url\s*\(/i.test(text)) add('network', node, 'CSS url( in text');
    if (/@import/i.test(text)) add('network', node, 'CSS @import in text');
    if (/<\s*(img|script|iframe|link|object|embed)\b/i.test(text)) add('network', node, 'HTML that loads something, in text');
    const react = text.match(REACT_KEYS);
    if (react) add('page-scripts', node, `React internal key ${react[1]}`);
    if (PAGE_GLOBAL.test(text)) add('page-scripts', node, `Notion's own global ${text.slice(0, 40)}`);
    for (const m of text.matchAll(WEB_ADDRESS)) hosts.add(m[1].toLowerCase().replace(/\.$/, ''));
  };

  // a name that means something on its own (a global) or as a property of the page's global objects
  const checkGlobalName = (name: string, node: Node, how: string): void => {
    const rule = lookup(GLOBALS, name);
    if (rule) add(rule[0], node, how === 'global' ? rule[1] : `${how}.${name}`);
    if (PAGE_GLOBAL.test(name)) add('page-scripts', node, `Notion's own global ${name}`);
  };

  const checkPropertyName = (name: string, node: Node): void => {
    const rule = lookup(PROPERTIES, name);
    if (rule) add(rule[0], node, rule[1]);
    const react = name.match(REACT_KEYS);
    if (react) add('page-scripts', node, `React internal key ${react[1]}`);
  };

  walk(root, (node, parent) => {
    switch (node.type) {
      case 'Identifier': {
        const name = node.name as string;
        if (own.has(name) || !parent) break;
        // not a reference: a.name, { name: 1 }, class { name() {} }, labels
        if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) break;
        if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed && parent.value !== node) break;
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement' || parent.type === 'MetaProperty') break;
        if (parent.type === 'ExportSpecifier' || parent.type === 'ImportSpecifier') break;
        checkGlobalName(name, node, 'global');
        break;
      }
      case 'MemberExpression': {
        const name = propertyName(node);
        const obj = node.object as Node;
        const objName = obj.type === 'Identifier' && !own.has(obj.name as string) ? (obj.name as string) : null;
        if (name === null) {
          if (objName && HIDDEN_ACCESS_OBJECTS.has(objName)) add('hidden-access', node, `${objName}[...] with a name the scan can't read`);
          break;
        }
        if (objName && GLOBAL_OBJECTS.has(objName)) checkGlobalName(name, node, objName);
        checkPropertyName(name, node);
        break;
      }
      case 'ObjectPattern': {
        // const { fetch, localStorage } = window
        for (const prop of node.properties as Node[]) {
          if (prop.type !== 'Property' || prop.computed) continue;
          const key = prop.key as Node;
          const name = key.type === 'Identifier' ? (key.name as string) : stringValue(key);
          if (!name) continue;
          const rule = lookup(GLOBALS, name);
          if (rule) add(rule[0], prop, `takes ${name} out of an object`);
          checkPropertyName(name, prop);
        }
        break;
      }
      case 'AssignmentExpression': {
        const target = node.left as Node;
        if (target.type === 'MemberExpression') {
          const name = propertyName(target);
          if (name && HTML_PROPERTIES.has(name)) add('network', node, `sets ${name}, which can load images or other files`);
          if (name && URL_PROPERTIES.has(name)) add('network', node, `sets .${name}`);
          if (name === 'location') add('network', node, 'sets location');
        } else if (target.type === 'Identifier' && target.name === 'location' && !own.has('location')) {
          add('network', node, 'sets location');
        }
        break;
      }
      case 'CallExpression':
      case 'NewExpression': {
        const callee = node.callee as Node;
        const args = node.arguments as Node[];
        const name = callee.type === 'MemberExpression' ? propertyName(callee) : callee.type === 'Identifier' && !own.has(callee.name as string) ? (callee.name as string) : null;
        if (!name) break;
        if (callee.type === 'MemberExpression') {
          if (HTML_CALLS.has(name)) add('network', node, `${name}(), which can load images or other files`);
          if ((name === 'write' || name === 'writeln') && objectName(callee.object) === 'document') add('network', node, `document.${name}()`);
          if (name === 'submit' || name === 'requestSubmit') add('network', node, `submits a form (.${name}())`);
          if ((name === 'assign' || name === 'replace') && objectName(callee.object) === 'location') add('network', node, `location.${name}()`);
          // (() => {}).constructor('code') builds a function from text, like new Function
          if (name === 'constructor' && args.length) add('dynamic-code', node, 'calls .constructor() directly, which can build code from text');
          if (name === 'setAttribute' || name === 'setAttributeNS') {
            const attr = stringValue(args[name === 'setAttribute' ? 0 : 1]);
            // a flag set to a fixed text (setAttribute(name, '')) can't carry an address
            if (attr === null) {
              if (stringValue(args[name === 'setAttribute' ? 1 : 2]) === null) add('hidden-access', node, `${name}() with a name the scan can't read`);
            }
            else if (URL_ATTRIBUTES.has(attr.toLowerCase())) add('network', node, `${name}('${attr}')`);
          }
        }
        if (name === 'createElement' || name === 'createElementNS') {
          const tag = stringValue(args[name === 'createElement' ? 0 : 1]);
          if (tag === null) add('hidden-access', node, `${name}() with a tag the scan can't read`);
          else if (LOADING_TAGS.has(tag.toLowerCase())) {
            add('network', node, `${name}('${tag}')`);
            if (tag.toLowerCase() === 'script') add('dynamic-code', node, `${name}('script')`);
          }
        }
        if (TIMER_CALLS.has(name) && looksLikeText(args[0])) add('dynamic-code', node, `${name}() with text instead of a function`);
        break;
      }
      case 'ImportExpression':
        add('dynamic-code', node, 'import()');
        break;
      case 'Literal':
        if (typeof node.value === 'string') checkText(node.value, node);
        break;
      case 'TemplateElement': {
        const cooked = (node.value as { cooked: string | null }).cooked;
        if (cooked) checkText(cooked, node);
        break;
      }
    }
  });

  evidence.sort((a, b) => a.line - b.line);
  notes.sort((a, b) => a.line - b.line);
  return { detected: sorted(detected), evidence, notes, hosts: [...hosts].sort(), problems: [] };
}

function hostCovered(host: string, declared: string[]): boolean {
  return declared.some(d => (d.startsWith('*.') ? host === d.slice(2) || host.endsWith(d.slice(1)) : host === d));
}

// network counts as declared when there is any network line; addresses in the code that no line covers are listed
// for information
export function comparePermissions(permissions: DeclaredPermissions, scan: ScanResult): PermissionReport['scan'] {
  return {
    ...scan,
    undeclared: scan.detected.filter(c => !permissions.declared.includes(c)),
    unlistedHosts: scan.hosts.filter(h => !hostCovered(h, permissions.hosts)),
  };
}

export function pluginPermissionReport(code: string): PermissionReport {
  const permissions = parsePermissionDeclarations(code);
  return { permissions, scan: comparePermissions(permissions, scanPlugin(code)) };
}

export interface PermissionChanges {
  // declared in the new code and not the old
  added: PermissionName[];
  addedHosts: string[];
  // found by the scan in the new code and not the old
  newlyFound: PermissionName[];
}

export function permissionChanges(oldCode: string, newCode: string): PermissionChanges & { report: PermissionReport } {
  const before = pluginPermissionReport(oldCode);
  const after = pluginPermissionReport(newCode);
  return {
    added: after.permissions.declared.filter(n => !before.permissions.declared.includes(n)),
    addedHosts: after.permissions.hosts.filter(h => !before.permissions.hosts.includes(h)),
    newlyFound: after.scan.detected.filter(n => !before.scan.detected.includes(n)),
    report: after,
  };
}
