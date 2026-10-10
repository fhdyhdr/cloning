import { parse as parseHtml, HTMLElement as ParsedHTMLElement } from "node-html-parser";

const PARSE_OPTIONS = {
  comment: true,
  blockTextElements: { script: true, noscript: true, style: true, pre: true },
} as const;

type FrameworkType = "framer" | "webflow" | "wix" | "generic";

// Vite targets ship plain JSX (.jsx, no TypeScript); Next.js keeps TSX so the
// generated props stay typed.
type OutputLanguage = "jsx" | "tsx";

const fileExtension = (language: OutputLanguage): string => (language === "jsx" ? "jsx" : "tsx");

type ComponentSection = {
  name: string;
  filePath: string;
  code: string;
  imports: Set<string>;
};

// Extracted reusable piece: lives in components/ui/ (small primitives like buttons, nav items, icons)
type ExtractedComponent = {
  name: string;
  dir: "components/ui";
  baked: boolean; // baked: identical innerHTML on every occurrence -> <Name />
  filePath: string;
  code: string;
};

type JsxImportRef = { name: string; path: string };

function detectFramework(html: string): FrameworkType {
  if (html.includes("data-framer-hydrate") || html.includes("data-framer-name")) return "framer";
  if (html.includes("data-webflow-element") || html.includes("w_container")) return "webflow";
  if (html.includes("wix-") || html.includes('class="w-')) return "wix";
  return "generic";
}

// Idempotent: "hero_home_section", "hero-home-section" and "HeroHomeSection"
// all collapse to "HeroHomeSection" (camelCase boundaries are preserved instead
// of being lower-cased away on a second pass).
function toPascalCase(str: string): string {
  const words = str
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("")
    .replace(/^[0-9]+/, "");
}

// Utility prefixes are layout bookkeeping, not identity; dropping them turns
// "u-position-fixed" into a usable "PositionFixed" when nothing better exists.
function prettifyClassToken(token: string): string {
  return token.replace(/^(u-|u_|w-|w_|fw-|fw_|cont-|con-)/i, "");
}

const SECTION_SUFFIX: Record<string, string> = {
  section: "Section",
  article: "Article",
  aside: "Aside",
};

// Value-only markers ("section", "wrap", "container") make names that say
// nothing about the block, so they are never used as the base name.
const GENERIC_NAMES = new Set([
  "Section",
  "Div",
  "Span",
  "Container",
  "Wrap",
  "Wrapper",
  "Main",
  "Content",
  "Component",
  "Block",
  "Row",
  "Layout",
  "Inner",
]);

// Semantic, human file names: <nav> is always Navigation, <footer> is Footer,
// and a <section> derived from "chapters_section" stays "ChaptersSection".
function getSectionName(element: ParsedHTMLElement, index: number): string {
  const tag = element.tagName?.toLowerCase();

  if (tag === "nav") return "Navigation";
  if (tag === "header") return "Header";
  if (tag === "footer") return "Footer";

  const candidates: string[] = [];
  const dataName = element.getAttribute("data-framer-name");
  if (dataName && dataName.length > 2) candidates.push(dataName);
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.length > 2) candidates.push(ariaLabel);
  const id = element.getAttribute("id");
  if (id && id.length > 2) candidates.push(id);

  const className = element.getAttribute("class");
  if (className) {
    const classes = className.split(/\s+/).filter((c) => c.length > 2);
    const descriptive = classes.filter((c) => !UTILITY_CLASS.test(c));
    const utility = classes.filter((c) => UTILITY_CLASS.test(c));
    if (descriptive.length) candidates.push(descriptive[0]!);
    else if (utility.length) candidates.push(prettifyClassToken(utility[0]!));
  }

  const heading = element.querySelector("h1, h2, h3");
  if (heading?.textContent) candidates.push(heading.textContent.trim().slice(0, 40));

  let base = "";
  for (const candidate of candidates) {
    const name = toPascalCase(candidate);
    if (name.length > 2 && !GENERIC_NAMES.has(name)) {
      base = name;
      break;
    }
  }

  const suffix = tag ? SECTION_SUFFIX[tag] : undefined;
  if (suffix) {
    if (!base) return `${suffix}${index}`;
    return base.endsWith(suffix) ? base : `${base}${suffix}`;
  }
  if (base) return base;
  if (tag === "main") return "Main";
  return `Component${index}`;
}

function cleanClassName(className: string): string {
  return className
    .split(/\s+/)
    .filter((cls) => cls && cls.length > 1)
    .join(" ");
}

function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// HTML to JSX attribute mapping
const HTML_TO_JSX_ATTR: Record<string, string> = {
  // SVG attributes
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-miterlimit": "strokeMiterlimit",
  "stroke-dasharray": "strokeDasharray",
  "stroke-dashoffset": "strokeDashoffset",
  "stroke-opacity": "strokeOpacity",
  "stop-color": "stopColor",
  "stop-opacity": "stopOpacity",
  "flood-color": "floodColor",
  "flood-opacity": "floodOpacity",
  "lighting-color": "lightingColor",
  "color-interpolation": "colorInterpolation",
  "color-interpolation-filters": "colorInterpolationFilters",
  "color-profile": "colorProfile",
  "color-rendering": "colorRendering",
  "text-anchor": "textAnchor",
  "dominant-baseline": "dominantBaseline",
  "clip-path": "clipPath",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "fill-opacity": "fillOpacity",
  "font-size": "fontSize",
  "font-family": "fontFamily",
  "font-weight": "fontWeight",
  "font-style": "fontStyle",
  "text-length": "textLength",
  "letter-spacing": "letterSpacing",
  "word-spacing": "wordSpacing",
  "marker-end": "markerEnd",
  "marker-mid": "markerMid",
  "marker-start": "markerStart",
  "pointer-events": "pointerEvents",
  "shape-rendering": "shapeRendering",
  "text-rendering": "textRendering",
  "image-rendering": "imageRendering",
  "vector-effect": "vectorEffect",
  "transform-box": "transformBox",
  "paint-order": "paintOrder",
  "baseline-shift": "baselineShift",
  "mask-type": "maskType",
  "marker-units": "markerUnits",
  "pattern-units": "patternUnits",
  "pattern-contentunits": "patternContentUnits",
  "pattern-transform": "patternTransform",
  "clip-pathunits": "clipPathUnits",
  "path-length": "pathLength",
  "specular-exponent": "specularExponent",
  "std-deviation": "stdDeviation",
  "table-values": "tableValues",
  "kernel-matrix": "kernelMatrix",
  "kernel-unit-length": "kernelUnitLength",
  "system-language": "systemLanguage",
  "num-octaves": "numOctaves",
  "start-offset": "startOffset",
  "gradient-units": "gradientUnits",
  "gradient-transform": "gradientTransform",
  "spread-method": "spreadMethod",
  "x-link:href": "xlinkHref",
  "x-link-show": "xlinkShow",
  "x-link-title": "xlinkTitle",
  "xml-space": "xmlSpace",
  "xmlns:xlink": "xmlnsXlink",
  // Common HTML attributes
  tabindex: "tabIndex",
  autocomplete: "autoComplete",
  srcset: "srcSet",
  crossorigin: "crossOrigin",
  formaction: "formAction",
  formmethod: "formMethod",
  formenctype: "formEnctype",
  formnovalidate: "formNoValidate",
  maxlength: "maxLength",
  minlength: "minLength",
  readonly: "readOnly",
  allowfullscreen: "allowFullScreen",
  allowtransparency: "allowTransparency",
  cellpadding: "cellPadding",
  cellspacing: "cellSpacing",
  colspan: "colSpan",
  rowspan: "rowSpan",
  enctype: "enctype",
  novalidate: "noValidate",
  for: "htmlFor",
  hreflang: "hrefLang",
  playsinline: "playsInline",
  contenteditable: "contentEditable",
  spellcheck: "spellCheck",
  charset: "charSet",
  "http-equiv": "httpEquiv",
  datetime: "dateTime",
  acceptcharset: "acceptCharset",
  srcdoc: "srcDoc",
  usemap: "useMap",
  ismap: "isMap",
  frameborder: "frameBorder",
  marginwidth: "marginWidth",
  marginheight: "marginHeight",
  noshade: "noShade",
  compact: "compact",
  declare: "declare",
  event: "event",
  "data-fld": "dataFld",
  "data-formatas": "dataFormatAs",
  "data-page-size": "dataPageSize",
  "data-src": "data-src",
  "dataset-target": "dataset-target",
};

function htmlAttrToJsx(htmlAttr: string): string {
  return HTML_TO_JSX_ATTR[htmlAttr] || htmlAttr;
}

// React types these as numbers, so a string literal ("tabIndex=\"0\"") fails
// `next build`. Emit numeric literals when the source value is an integer.
const NUMERIC_JSX_ATTRS = new Set([
  "tabindex",
  "colspan",
  "rowspan",
  "span",
  "start",
  "size",
  "rows",
  "cols",
  "maxlength",
  "minlength",
  "aria-colcount",
  "aria-colindex",
  "aria-colspan",
  "aria-level",
  "aria-posinset",
  "aria-rowcount",
  "aria-rowindex",
  "aria-rowspan",
  "aria-setsize",
  "aria-valuemax",
  "aria-valuemin",
  "aria-valuenow",
]);

function numericJsxAttribute(htmlKey: string, value: string): string | undefined {
  if (!NUMERIC_JSX_ATTRS.has(htmlKey.toLowerCase())) return undefined;
  return /^-?\d+$/.test(value) ? `{${value}}` : undefined;
}

// SVG element names are case-sensitive in JSX; lowercase HTML parsing loses the
// camelCase (`<clippath>` must become `<clipPath>`).
const JSX_TAG_MAP: Record<string, string> = {
  clippath: "clipPath",
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  foreignobject: "foreignObject",
  textpath: "textPath",
  glyphref: "glyphRef",
  altglyph: "altGlyph",
  altglyphdef: "altGlyphDef",
  altglyphitem: "altGlyphItem",
  animatecolor: "animateColor",
  animatemotion: "animateMotion",
  animatetransform: "animateTransform",
  feblend: "feBlend",
  fecolormatrix: "feColorMatrix",
  fecomponenttransfer: "feComponentTransfer",
  fecomposite: "feComposite",
  feconvolvematrix: "feConvolveMatrix",
  fediffuselighting: "feDiffuseLighting",
  fedisplacementmap: "feDisplacementMap",
  fedistantlight: "feDistantLight",
  fedropshadow: "feDropShadow",
  feflood: "feFlood",
  fefunca: "feFuncA",
  fefuncb: "feFuncB",
  fefuncg: "feFuncG",
  fefuncr: "feFuncR",
  fegaussianblur: "feGaussianBlur",
  feimage: "feImage",
  femerge: "feMerge",
  femergenode: "feMergeNode",
  femorphology: "feMorphology",
  feoffset: "feOffset",
  fepointlight: "fePointLight",
  fespecularlighting: "feSpecularLighting",
  fespotlight: "feSpotLight",
  fetile: "feTile",
  feturbulence: "feTurbulence",
};

function jsxTagName(tag: string): string {
  return JSX_TAG_MAP[tag] ?? tag;
}

// Valid JS/TS identifier: JSX object keys are unquoted only when they match.
const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Convert CSS string to JSX style object
function cssStringToJsxStyle(cssString: string): string {
  const styleObj = new Map<string, string>();

  cssString.split(";").forEach((prop) => {
    const trimmed = prop.trim();
    if (!trimmed) return;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) return;

    const cssProp = trimmed.slice(0, colonIdx).trim();
    const cssValue = trimmed.slice(colonIdx + 1).trim();

    if (!cssProp || !cssValue) return;

    // CSS custom properties (`--token-...`, `--framer-paragraph-spacing`) are
    // valid React style keys only verbatim. Camel-casing them produces
    // "-FramerParagraphSpacing", which no JSX parser accepts.
    let key: string;
    if (cssProp.startsWith("--")) {
      key = JSON.stringify(cssProp);
    } else {
      const camelProp = cssProp.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      key = JS_IDENTIFIER.test(camelProp) ? camelProp : JSON.stringify(camelProp);
    }

    // Handle important flag
    const cleanValue = cssValue.replace(/!important/g, "").trim();

    styleObj.set(key, `"${escapeAttributeValue(cleanValue)}"`);
  });

  if (styleObj.size === 0) return "{}";

  return `{${[...styleObj.entries()].map(([k, v]) => `${k}: ${v}`).join(", ")}}`;
}

// SVG presentation attributes that browsers apply to the element but React has
// no camelCase prop for. Emitting them as JSX props makes React warn on SSR
// ("Invalid DOM property") or leak a literal camelCase attribute into the DOM
// where CSS ignores it. These are absorbed into the element's `style` object
// instead (React converts `transformOrigin` back to `transform-origin` in CSS).
const STYLE_ABSORB_ATTRS: Record<string, string> = {
  "transform-origin": "transformOrigin",
};

// Valueless HTML attributes that are still meaningful when empty: emit them
// as `attr=""`, which is exactly what the source document carried.
const EMPTY_ATTR_LITERALS: Record<string, string> = {
  alt: 'alt=""',
  crossorigin: 'crossOrigin="anonymous"',
  crossorigin_anonymous: 'crossOrigin="anonymous"',
};

// HTML boolean attributes spelled without a value. JSX needs them as bare
// props (React's casing), otherwise `disabled` would render as `disabled=""`
// on the wrong key or be dropped entirely.
const BOOLEAN_JSX_ATTRS: Record<string, string> = {
  allowfullscreen: "allowFullScreen",
  allowpaymentrequest: "allowPaymentRequest",
  async: "async",
  autofocus: "autoFocus",
  autoplay: "autoPlay",
  checked: "checked",
  controls: "controls",
  default: "default",
  defer: "defer",
  disabled: "disabled",
  formnovalidate: "formNoValidate",
  hidden: "hidden",
  inert: "inert",
  ismap: "isMap",
  itemscope: "itemScope",
  loop: "loop",
  multiple: "multiple",
  muted: "muted",
  nomodule: "noModule",
  novalidate: "noValidate",
  open: "open",
  playsinline: "playsInline",
  readonly: "readOnly",
  required: "required",
  reversed: "reversed",
  selected: "selected",
};

// ARIA attributes React types as Booleanish, so `aria-hidden=""` (the valueless
// spelling the source uses) is a type error under `next build`. Chrome maps the
// empty value to the same accessibility state as "false" — verified through
// Accessibility.getFullAXTree: `aria-hidden=""` and `aria-hidden="false"` both
// leave the node exposed while `"true"` hides it — so these are emitted as the
// literal `"false"`, which keeps the accessibility behaviour and type-checks.
// String-valued ARIA attributes (aria-label, aria-describedby, ...) keep their
// exact empty value instead.
const ARIA_BOOLEAN_ATTRS = new Set([
  "aria-atomic",
  "aria-busy",
  "aria-checked",
  "aria-current",
  "aria-disabled",
  "aria-expanded",
  "aria-grabbed",
  "aria-haspopup",
  "aria-hidden",
  "aria-invalid",
  "aria-modal",
  "aria-multiselectable",
  "aria-pressed",
  "aria-required",
  "aria-selected",
]);

function convertAttributesToReact(element: ParsedHTMLElement, framework: FrameworkType): string {
  const attrs: string[] = [];
  const styleExtra: string[] = [];
  let rawStyle: string | null = null;
  const rawAttrs = element.attributes;

  for (const [key, value] of Object.entries(rawAttrs)) {
    const lower = key.toLowerCase();

    // Always skip these cloner-specific and inline event-handler attributes.
    // `fetchpriority` is dropped too: React <18.3 warns on the camelCase prop
    // while React 18.3+ warns on the lowercase attribute, so there is no casing
    // that is warning-free across versions. It is only a loading hint.
    if (
      lower.startsWith("data-weaver-") ||
      lower.startsWith("data-site-cloner-") ||
      lower === "fetchpriority" ||
      /^on[a-z]+$/i.test(key)
    ) {
      continue;
    }

    // Valueless attributes are NOT interchangeable with absent ones. Vue's
    // scoped CSS is compiled to `.hero[data-v-a1f66af5]`, so dropping the
    // valueless `data-v-*` scope id un-matches every scoped rule in the
    // document and the layout collapses. HTML boolean attributes (`muted`,
    // `loop`, `autoplay`) and empty-but-meaningful values (`alt=""`) matter the
    // same way. Emits them as bare JSX booleans, empty strings or their React
    // spelling (boolean-ish ARIA attributes land on the equivalent `"false"`,
    // see ARIA_BOOLEAN_ATTRS); anything else that is valueless (a URL attribute
    // with no URL, an empty style, ...) stays dropped.
    if (!value) {
      if (ARIA_BOOLEAN_ATTRS.has(lower)) {
        attrs.push(`${key}="false"`);
      } else if (lower.startsWith("data-") || lower.startsWith("aria-")) {
        attrs.push(`${key}=""`);
      } else if (EMPTY_ATTR_LITERALS[lower]) {
        attrs.push(EMPTY_ATTR_LITERALS[lower]);
      } else if (BOOLEAN_JSX_ATTRS[lower]) {
        attrs.push(BOOLEAN_JSX_ATTRS[lower]);
      }
      continue;
    }

    const absorb = STYLE_ABSORB_ATTRS[lower];
    if (absorb) {
      styleExtra.push(`${absorb}: "${escapeAttributeValue(value)}"`);
      continue;
    }

    const jsxKey = htmlAttrToJsx(lower);

    // For Framer: keep ALL attributes including styles
    if (framework === "framer") {
      if (key === "class") {
        attrs.push(`className="${escapeAttributeValue(cleanClassName(value))}"`);
      } else if (key === "style") {
        // Convert CSS string to JSX style object
        rawStyle = cssStringToJsxStyle(value);
      } else {
        const lower = key.toLowerCase();
        const mapped = HTML_TO_JSX_ATTR[lower] ?? (key !== lower ? key : null);
        const finalKey = mapped ?? lower;
        const numeric = numericJsxAttribute(lower, value);
        if (numeric) attrs.push(`${finalKey}=${numeric}`);
        else attrs.push(`${finalKey}="${escapeAttributeValue(value)}"`);
      }
      continue;
    }

    // For other frameworks: selective filtering
    if (key === "class") {
      const cleaned = cleanClassName(value);
      if (cleaned) attrs.push(`className="${cleaned}"`);
    } else if (key === "for") {
      attrs.push(`htmlFor="${value}"`);
    } else if (key === "style") {
      // Convert CSS string to JSX style object
      rawStyle = cssStringToJsxStyle(value);
    } else if (key.startsWith("data-")) {
      if (value.length < 150) {
        attrs.push(`${key}="${escapeAttributeValue(value)}"`);
      }
    } else if (key.startsWith("aria-")) {
      if (value.length < 150) {
        const numeric = numericJsxAttribute(key, value);
        if (numeric) attrs.push(`${jsxKey}=${numeric}`);
        else attrs.push(`${jsxKey}="${escapeAttributeValue(value)}"`);
      }
    } else if (
      [
        "src",
        "href",
        "alt",
        "title",
        "id",
        "name",
        "type",
        "placeholder",
        "value",
        "role",
        "viewBox",
        "width",
        "height",
      ].includes(key)
    ) {
      if (value.length < 500) {
        attrs.push(`${key}="${escapeAttributeValue(value)}"`);
      }
    } else if (jsxKey !== key) {
      // Use converted JSX attribute name
      const numeric = numericJsxAttribute(key, value);
      if (numeric) attrs.push(`${jsxKey}=${numeric}`);
      else attrs.push(`${jsxKey}="${escapeAttributeValue(value)}"`);
    }
  }

  // Absorbed presentation attributes (e.g. transform-origin) merge into the
  // element's style object so they survive as CSS without React prop warnings.
  if (styleExtra.length) {
    if (rawStyle !== null) {
      const inner = rawStyle.slice(1, -1).trim();
      rawStyle = `{${inner ? `${inner}, ${styleExtra.join(", ")}` : styleExtra.join(", ")}}`;
    } else {
      rawStyle = `{${styleExtra.join(", ")}}`;
    }
  }
  if (rawStyle !== null) attrs.push(`style={${rawStyle}}`);

  return attrs.length ? " " + attrs.join(" ") : "";
}

function convertElementToJSX(
  element: ParsedHTMLElement,
  depth = 0,
  framework: FrameworkType = "generic",
  extracted?: Map<ParsedHTMLElement, { name: string; baked: boolean }>,
): string {
  const indent = "  ".repeat(depth);
  const tag = element.tagName?.toLowerCase();

  if (!tag) return "";

  // Reusable component reference: this element was hoisted into its own
  // component file. Baked components already carry their subtree, while
  // children-based ones keep their original children at the call site.
  const ext = extracted?.get(element);
  if (ext) {
    if (ext.baked) return `${indent}<${ext.name} />`;
    const extChildren = renderChildren(element, depth + 1, framework, extracted);
    if (extChildren.length === 0) return `${indent}<${ext.name} />`;
    return `${indent}<${ext.name}>\n${extChildren.join("\n")}\n${indent}</${ext.name}>`;
  }

  const classes = element.getAttribute("class") ?? "";

  // Webflow embeds carry raw <style>/<script>/HTML that must stay byte-for-byte
  // (they are design-system snippets and animation hooks). Rendering them via
  // dangerouslySetInnerHTML keeps the section editable while preserving them.
  if (tag !== "script" && tag !== "style" && /\bw-embed\b/.test(classes)) {
    const attrs = convertAttributesToReact(element, framework);
    const inner = element.innerHTML ?? "";
    return `${indent}<${jsxTagName(tag)}${attrs} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(inner)} }} />`;
  }

  if (["script", "link", "meta", "title", "noscript", "template"].includes(tag)) {
    return "";
  }

  // <style> children are plain CSS text; React needs them as a string literal.
  if (tag === "style") {
    return `${indent}<style dangerouslySetInnerHTML={{ __html: ${JSON.stringify(element.innerHTML ?? "")} }} />`;
  }

  const attrs = convertAttributesToReact(element, framework);
  const jsxTag = jsxTagName(tag);

  const children = renderChildren(element, depth + 1, framework, extracted);

  if (children.length === 0) {
    return `${indent}<${jsxTag}${attrs} />`;
  }

  return `${indent}<${jsxTag}${attrs}>\n${children.join("\n")}\n${indent}</${jsxTag}>`;
}

// Renders a text node as JSX text. Plain copy ("Baffait", "é 2026") is emitted
// verbatim — the way a hand-written component reads — instead of always being
// wrapped in a `{"..."}` expression. Text JSX cannot carry as a bare literal
// (`{`, `}`, `<`, `>` are syntax; newlines would be re-flowed by the formatter)
// falls back to the escaped expression so the file always parses and renders
// byte-identical content.
function jsxText(raw: string, indent: string): string {
  const safe = raw.length > 0 && !/[{}<>]/.test(raw) && raw === raw.trim() && !/[\n\r]/.test(raw);
  return safe ? `${indent}  ${raw}` : `${indent}  {${JSON.stringify(raw)}}`;
}

function renderChildren(
  element: ParsedHTMLElement,
  childDepth: number,
  framework: FrameworkType,
  extracted?: Map<ParsedHTMLElement, { name: string; baked: boolean }>,
): string[] {
  const indent = "  ".repeat(childDepth - 1);
  const children: string[] = [];
  let hasElementChildren = false;

  // A parent that mixes text and element children (e.g.
  // `Créatif discret, <span>je donne vie</span> aux idées`) needs the text kept in
  // the `{"..."}` form: JSX strips the newline+indent whitespace around a bare
  // literal, which would fuse "discret," onto "je" and change the rendered copy.
  // Only when the element's entire content is text (a `<span>Baffait</span>` or an
  // `<a>mail@x</a>`, no element siblings) is the plain, hand-written-looking
  // literal safe — that is the common, high-value case.
  for (const node of element.childNodes) {
    if (node.nodeType === 1) {
      const tag = (node as ParsedHTMLElement).tagName?.toLowerCase();
      if (tag && !["script", "noscript", "template"].includes(tag)) {
        hasElementChildren = true;
        break;
      }
    }
  }

  for (const child of element.childNodes) {
    if (child.nodeType === 1) {
      const childElement = child as ParsedHTMLElement;
      const childTag = childElement.tagName?.toLowerCase();
      if (childTag && !["script", "noscript", "template"].includes(childTag)) {
        const jsx = convertElementToJSX(childElement, childDepth, framework, extracted);
        if (jsx) children.push(jsx);
      }
    } else if (child.nodeType === 3) {
      // Significant text is preserved whether it sits before OR after an element
      // child: markup like `<span class="first-letter">L</span>uke` (the "uke"
      // text node trails the span) must keep that trailing copy or the name
      // collapses to "L". Whitespace-only text is dropped (layout noise the JSX
      // re-indent reproduces).
      const trimmed = (child.textContent ?? "").trim();
      if (trimmed) {
        children.push(
          hasElementChildren ? `${indent}  {${JSON.stringify(trimmed)}}` : jsxText(trimmed, indent),
        );
      }
    }
  }

  return children;
}

// Fidelity-preserving section renderer. Rendering the original HTML verbatim
// via dangerouslySetInnerHTML (instead of rebuilding each element as React
// components) keeps layout, hydration data and animation hooks pixel-perfect
// while still living inside a proper Vite/Next.js project. This path is used
// for every framework (Framer, Webflow, Wix, generic) because framework-driven
// sites — especially Webflow with its w-embed embeds, dynamic interactions and
// GSAP/ScrollTrigger tweens — fall apart the moment their markup is recompiled
// into per-element React components. The consolidated /js/main.js and
// /js/main.mjs run afterwards against the very same DOM the original page had.
function createFramerSiteComponent(
  html: string,
  language: OutputLanguage = "tsx",
): {
  sections: ComponentSection[];
  components: ExtractedComponent[];
  layout: string;
  framework: FrameworkType;
} {
  const root = parseHtml(html, PARSE_OPTIONS);
  const htmlElement = root.querySelector("html");
  const body = root.querySelector("body");
  const innerMarkup = body ? body.innerHTML : html;
  const markupLiteral = JSON.stringify(innerMarkup);

  // Webflow reads data-wf-site on <html>, Framer reads data-framer-* attributes
  // and any theme id/class keeps CSS selectors working, so the source document
  // attributes travel with the component and are re-applied at mount time.
  const originAttrs = (element: ParsedHTMLElement | null): Record<string, string> => {
    if (!element) return {};
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(element.attributes)) {
      if (!value) continue;
      if (["data-weaver-hide", "data-weaver-selected", "data-weaver-selector"].includes(key))
        continue;
      attrs[key] = value;
    }
    return attrs;
  };
  const htmlAttrsLiteral = JSON.stringify(originAttrs(htmlElement));
  const bodyAttrsLiteral = JSON.stringify(originAttrs(body));

  const name = "SiteContent";
  const section: ComponentSection = {
    name,
    filePath: `components/section/${name}.${fileExtension(language)}`,
    imports: new Set<string>(),
    code: `import { useEffect } from "react";

export function ${name}() {
  const htmlAttrs: Record<string, string> = ${htmlAttrsLiteral};
  const bodyAttrs: Record<string, string> = ${bodyAttrsLiteral};

  useEffect(() => {
    for (const [key, value] of Object.entries(htmlAttrs)) {
      if (value) document.documentElement.setAttribute(key, value);
    }
    for (const [key, value] of Object.entries(bodyAttrs)) {
      if (value) document.body.setAttribute(key, value);
    }
  }, []);

  const markup: string = ${markupLiteral};

  return <div id="site-cloner-root" dangerouslySetInnerHTML={{ __html: markup }} />;
}
`,
  };

  return {
    sections: [section],
    components: [],
    layout: `<SiteContent />`,
    framework: "framer",
  };
}

// JSX/TSX per-section output: the page is split into one editable React
// component per section (nav, hero, each <section>, footer, ...), composed in
// the generated App/page component. Webflow w-embeds keep their raw HTML via
// dangerouslySetInnerHTML so design-system styles and snippets survive, and the
// consolidated /js/main.js still loads afterwards to drive animations. This is
// the default for Vite and Next.js because editing real JSX beats a giant HTML
// string inside dangerouslySetInnerHTML.
const SPLIT_TAGS = new Set(["section", "nav", "header", "footer", "article", "aside"]);
const SKIP_TAGS = new Set(["script", "noscript", "template", "link", "meta", "title", "style"]);

const TOP_SECTION_CLASS =
  /(?:^|\s)(?:header|hero|navbar|banner|footer|cta_section|cta-section)(?:\s|$)/i;

function isSectionElement(element: ParsedHTMLElement): boolean {
  const tag = element.tagName?.toLowerCase();
  if (!tag || SKIP_TAGS.has(tag)) return false;
  if (SPLIT_TAGS.has(tag)) return true;

  const role = element.getAttribute("role");
  if (role && ["region", "banner", "navigation", "contentinfo", "complementary"].includes(role)) {
    return true;
  }

  if (tag === "div") {
    const cls = element.getAttribute("class") || "";
    const id = element.getAttribute("id") || "";
    if (TOP_SECTION_CLASS.test(cls) || TOP_SECTION_CLASS.test(id)) {
      return elementSubtreeCount(element) >= 3;
    }
  }

  return false;
}

// Page sections are the document's real content blocks: <section> plus the
// nav/header/footer/article/aside landmarks. Builders nest sections (Webflow
// wraps about/clients/services inside a parent section), so every split tag is
// collected, including ones inside another split tag; a nested section becomes
// its own editable file and is referenced from its parent.
function collectSectionElements(root: ParsedHTMLElement, out: ParsedHTMLElement[]): void {
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) continue;
    const element = child as ParsedHTMLElement;
    const tag = element.tagName?.toLowerCase();
    if (!tag || SKIP_TAGS.has(tag)) continue;
    if (isSectionElement(element)) out.push(element);
    collectSectionElements(element, out);
  }
}

type JsxCtx = {
  sections: ComponentSection[];
  components: ExtractedComponent[];
  usedNames: Set<string>;
  language: OutputLanguage;
};

function elementSubtreeCount(element: ParsedHTMLElement): number {
  let count = 1;
  for (const child of element.childNodes) {
    if (child.nodeType === 1) count += elementSubtreeCount(child as ParsedHTMLElement);
  }
  return count;
}

type ExtractGroup = {
  elements: ParsedHTMLElement[];
  baseName: string;
  size: number;
};

// Classes that are pure layout/utility tokens or unique-hash identifiers; they
// make terrible component names and would collide across the page (Utext2..9).
const UTILITY_CLASS =
  /^(u-|u_|w-|w_|fw-|fw_|cont-|con-|container|btn-|framer-|css-|jsx-|is-|has-|style-)[a-z0-9_-]*$/i;

// Children-based ("not baked") extraction only makes sense for content
// primitives: controls, list items, headings, media. Wrapping <div>/<span>
// layout shells turn into meaningless UI files (ServicesHomeCardBottomText), so
// unless their whole subtree is identical (baked) they stay inline in the
// section that uses them.
const PRIMITIVE_TAGS = new Set([
  "a",
  "button",
  "li",
  "label",
  "input",
  "select",
  "textarea",
  "summary",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "figcaption",
  "td",
  "th",
  "dt",
  "dd",
]);

function pickBaseName(classes: string[], classFreq: Map<string, number>): string {
  const candidates = classes
    .map((cls) => ({ cls, freq: classFreq.get(cls) ?? Infinity }))
    .filter((c) => /^[a-z]/i.test(c.cls) && c.cls.length >= 2)
    .sort((a, b) => {
      // Prefer descriptive (non-utility) classes; within those, tie-break by
      // rarity (more specific = better component name), then by length.
      const aUtil = UTILITY_CLASS.test(a.cls) ? 1 : 0;
      const bUtil = UTILITY_CLASS.test(b.cls) ? 1 : 0;
      if (aUtil !== bUtil) return aUtil - bUtil;
      if (a.freq !== b.freq) return a.freq - b.freq;
      return b.cls.length - a.cls.length;
    });
  return candidates[0]?.cls ?? classes[0] ?? "Component";
}

const UI_STRUCTURAL_CLASS =
  /(?:[-_]wrap|[-_]wrapper|[-_]container|[-_]layout|[-_]element|[-_]line|[-_]text|[-_]box|[-_]spacer|[-_]divider)$/i;

function isUiPrimitive(
  c: ParsedHTMLElement,
  classes: string[],
): { name: string; baked: boolean; dynamicAttributes?: boolean } | null {
  const tag = c.tagName?.toLowerCase();
  if (!tag || SKIP_TAGS.has(tag) || SPLIT_TAGS.has(tag)) return null;

  const specificToken = classes.find(
    (cls) => !UTILITY_CLASS.test(cls) && cls.length > 3 && !/^(btn|button|icon)$/i.test(cls),
  );

  if (tag === "button") {
    const name = toPascalCase(specificToken ? prettifyClassToken(specificToken) : "Button");
    return { name: name || "Button", baked: false, dynamicAttributes: true };
  }
  if (
    tag === "svg" &&
    (c.parentNode as ParsedHTMLElement | undefined)?.tagName?.toLowerCase() !== "svg"
  ) {
    const name = toPascalCase(specificToken ? prettifyClassToken(specificToken) : "Icon");
    return { name: name || "Icon", baked: true };
  }

  if (classes.some((cls) => UI_STRUCTURAL_CLASS.test(cls))) return null;

  const iconToken = classes.find((cls) =>
    /(?:^|[-_])(icon|logo|badge|avatar|thumb)(?:[-_]|$)/i.test(cls),
  );
  if (iconToken) {
    const token = specificToken || iconToken;
    const name = toPascalCase(prettifyClassToken(token));
    return { name: name || "Icon", baked: true };
  }

  const btnToken = classes.find((cls) =>
    /(?:^|[-_])(btn|button|clickable[-_]?btn)(?:[-_]|$)/i.test(cls),
  );
  if (btnToken) {
    const token = specificToken || btnToken;
    const name = toPascalCase(prettifyClassToken(token));
    return { name: name || "Button", baked: !c.textContent.trim() };
  }

  return null;
}

// Detect elements that repeat >=2 times across the page with the same tag and
// class signature, or discrete UI primitives (buttons, icons, badges), and
// turn them into reusable components under components/ui/.
function buildExtractionPlan(
  body: ParsedHTMLElement,
  usedNames: Set<string>,
  language: OutputLanguage,
  maxComponents = 80,
): {
  map: Map<ParsedHTMLElement, { name: string; baked: boolean }>;
  components: ExtractedComponent[];
} {
  const groups = new Map<string, ExtractGroup>();
  const classFreq = new Map<string, number>();
  const uniqueName = (base: string): string => {
    const name = toPascalCase(base) || "Component";
    let candidate = name;
    for (let i = 2; usedNames.has(candidate); i += 1) candidate = `${name}${i}`;
    usedNames.add(candidate);
    return candidate;
  };

  const allElements: ParsedHTMLElement[] = [];
  const collect = (el: ParsedHTMLElement): void => {
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;
      const c = child as ParsedHTMLElement;
      allElements.push(c);
      for (const cls of (c.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) {
        classFreq.set(cls, (classFreq.get(cls) ?? 0) + 1);
      }
      collect(c);
    }
  };
  collect(body);

  for (const c of allElements) {
    const tag = c.tagName?.toLowerCase();
    if (!tag || SKIP_TAGS.has(tag) || SPLIT_TAGS.has(tag)) continue;
    const classAttr = c.getAttribute("class");
    if (!classAttr || !classAttr.trim()) continue;
    const cls = classAttr.split(/\s+/).filter(Boolean).sort();
    // Only lift elements that carry at least one descriptive (non-utility)
    // className: pure utility wrappers (u-*, w-variant hashes, ...) only add
    // noise as components (WVariantXXX, UAlignmentCenter, ...).
    if (!cls.some((name) => !UTILITY_CLASS.test(name))) continue;
    const sig = `${tag} ${cls.join(" ")}`;
    const size = elementSubtreeCount(c);
    if (size > 300 || size < 2) continue;
    const existing = groups.get(sig);
    if (existing) {
      existing.elements.push(c);
    } else {
      groups.set(sig, { elements: [c], baseName: pickBaseName(cls, classFreq), size });
    }
  }

  const map = new Map<ParsedHTMLElement, { name: string; baked: boolean }>();
  const components: ExtractedComponent[] = [];
  const claimed = new Set<ParsedHTMLElement>();

  // 1. Extract distinct UI primitives into components/ui/
  for (const c of allElements) {
    if (claimed.has(c)) continue;
    if (components.length >= maxComponents) break;
    const classAttr = c.getAttribute("class") ?? "";
    const cls = classAttr.split(/\s+/).filter(Boolean);
    const prim = isUiPrimitive(c, cls);
    if (!prim) continue;

    const name = uniqueName(prim.name);
    const baked = prim.baked;
    const dir = "components/ui" as const;

    let code: string;
    if (baked) {
      const jsx = convertElementToJSX(c, 1, "framer");
      code = `export function ${name}() {\n  return (\n${jsx}\n  );\n}\n`;
    } else {
      const tag = c.tagName.toLowerCase();
      const attrs = convertAttributesToReact(c, "framer");
      code =
        language === "jsx"
          ? `export function ${name}({ children }) {\n  return (\n  <${tag}${attrs}>\n    {children}\n  </${tag}>\n  );\n}\n`
          : `import type { ReactNode } from "react";

export function ${name}({ children }: { children?: ReactNode }) {
  return (\n  <${tag}${attrs}>\n    {children}\n  </${tag}>\n  );\n}
`;
    }

    components.push({
      name,
      dir,
      baked,
      filePath: `${dir}/${name}.${fileExtension(language)}`,
      code,
    });

    map.set(c, { name, baked });
    const mark = (node: ParsedHTMLElement): void => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        const cc = child as ParsedHTMLElement;
        claimed.add(cc);
        mark(cc);
      }
    };
    mark(c);
  }

  // 2. Extract repeated blocks into components/ui/
  const sorted = [...groups.values()]
    .filter((g) => g.elements.length >= 2)
    .sort((a, b) => a.size - b.size);

  for (const group of sorted) {
    if (components.length >= maxComponents) break;
    const els = group.elements.filter((el) => !claimed.has(el));
    if (els.length < 2) continue;

    const baked = els.every((el) => el.innerHTML === els[0]?.innerHTML);
    if (!baked) {
      const tag = els[0]!.tagName?.toLowerCase() ?? "";
      if (!PRIMITIVE_TAGS.has(tag) || group.size > 24) continue;
    }
    const name = uniqueName(group.baseName);
    const dir = "components/ui" as const;

    let code: string;
    const firstExtracted = els[0]!;
    if (baked) {
      const jsx = convertElementToJSX(firstExtracted, 1, "framer");
      code = `export function ${name}() {\n  return (\n${jsx}\n  );\n}\n`;
    } else {
      const tag = firstExtracted.tagName.toLowerCase();
      const attrs = convertAttributesToReact(firstExtracted, "framer");
      code =
        language === "jsx"
          ? `export function ${name}({ children }) {\n  return (\n  <${tag}${attrs}>\n    {children}\n  </${tag}>\n  );\n}\n`
          : `import type { ReactNode } from "react";

export function ${name}({ children }: { children?: ReactNode }) {
  return (\n  <${tag}${attrs}>\n    {children}\n  </${tag}>\n  );\n}
`;
    }

    components.push({
      name,
      dir,
      baked,
      filePath: `${dir}/${name}.${fileExtension(language)}`,
      code,
    });

    for (const el of els) {
      map.set(el, { name, baked });
      const mark = (node: ParsedHTMLElement): void => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          const cc = child as ParsedHTMLElement;
          claimed.add(cc);
          mark(cc);
        }
      };
      mark(el);
    }
  }

  return { map, components };
}

function jsxComponentCode(
  name: string,
  body: string,
  importNames: string[] = [],
  extraImports: string[] = [],
): string {
  const imports = [
    ...importNames.map((importName) => `import { ${importName} } from "./${importName}";`),
    ...extraImports,
  ].join("\n");
  const header = imports ? `${imports}\n\n` : "";
  return `${header}export function ${name}() {\n  return (\n${body}\n  );\n}\n`;
}

export function createJsxSectionComponents(
  html: string,
  language: OutputLanguage = "tsx",
): {
  sections: ComponentSection[];
  components: ExtractedComponent[];
  layout: string;
  framework: FrameworkType;
} {
  const root = parseHtml(html, PARSE_OPTIONS);
  const htmlElement = root.querySelector("html");
  const body = root.querySelector("body");
  const framework = detectFramework(html);

  const ctx: JsxCtx = { sections: [], components: [], usedNames: new Set(), language };

  const uniqueName = (base: string): string => {
    const name = toPascalCase(base) || "Section";
    let candidate = name;
    for (let i = 2; ctx.usedNames.has(candidate); i += 1) candidate = `${name}${i}`;
    ctx.usedNames.add(candidate);
    return candidate;
  };

  // Reusable components are extracted up-front so section/group names never
  // collide with them and sections can import them via relative paths.
  const plan = body
    ? buildExtractionPlan(body, ctx.usedNames, language)
    : { map: undefined, components: [] };
  ctx.components = plan.components;

  // Sections live in components/section, so an extracted component is either a
  // sibling folder (../ui/Button); a nested section is a sibling file.
  const refImportLine = (name: string, selfName: string): string => {
    if (name === selfName) return "";
    const comp = ctx.components.find((c) => c.name === name);
    if (comp) {
      const folder = comp.dir === "components/ui" ? "ui/" : "";
      return `import { ${name} } from "../${folder}${name}";`;
    }
    if (sectionNames.has(name)) return `import { ${name} } from "./${name}";`;
    return "";
  };

  // Split the page into its real sections (see collectSectionElements). Anything
  // that is not a section is part of the page shell: wrapper divs, transition
  // overlays, scroll shims, badge/sprite containers. Those stay inline in the
  // composed page component instead of becoming bogus section files.
  const sectionElements: ParsedHTMLElement[] = [];
  if (body) collectSectionElements(body, sectionElements);

  // Div-only pages expose no landmarks; fall back to treating substantial
  // top-level blocks as sections so the output is still split into editable
  // files rather than one monolithic page.
  if (sectionElements.length === 0 && body) {
    for (const child of body.childNodes) {
      if (child.nodeType !== 1) continue;
      const element = child as ParsedHTMLElement;
      const tag = element.tagName?.toLowerCase();
      if (!tag || SKIP_TAGS.has(tag)) continue;
      if (elementSubtreeCount(element) < 8) continue;
      sectionElements.push(element);
    }
  }

  const sectionNames = new Set<string>();
  const sectionMap = new Map<ParsedHTMLElement, { name: string; baked: boolean }>();
  const pageMap = new Map<ParsedHTMLElement, { name: string; baked: boolean }>(plan.map);
  sectionElements.forEach((element, index) => {
    const name = uniqueName(getSectionName(element, index));
    sectionNames.add(name);
    sectionMap.set(element, { name, baked: true });
    pageMap.set(element, { name, baked: true });
  });

  for (const element of sectionElements) {
    const name = sectionMap.get(element)!.name;
    // The section renders its own subtree verbatim; extracted pieces become
    // references, and any (rare) nested section also becomes a reference.
    const innerMap = new Map(plan.map);
    for (const [sectionElement, info] of sectionMap) {
      if (sectionElement !== element) innerMap.set(sectionElement, info);
    }
    const jsx = convertElementToJSX(element, 1, "framer", innerMap);
    const imported = [
      ...new Set(
        [...jsx.matchAll(/<([A-Z][A-Za-z0-9_]*)(?:[\s/>]|$)/g)]
          .map((match) => match[1] ?? "")
          .filter((ref) => ref !== name),
      ),
    ]
      .map((ref) => refImportLine(ref, name))
      .filter(Boolean);
    ctx.sections.push({
      name,
      filePath: `components/section/${name}.${fileExtension(language)}`,
      imports: new Set<string>(),
      code: jsxComponentCode(name, jsx, [], imported),
    });
  }

  // Restore <html>/<body> attributes (Webflow reads data-wf-site on <html>,
  // and <body class="..."> carries layout/theme selectors).
  const originAttrs = (element: ParsedHTMLElement | null): Record<string, string> => {
    if (!element) return {};
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(element.attributes)) {
      if (!value) continue;
      if (["data-weaver-hide", "data-weaver-selected", "data-weaver-selector"].includes(key))
        continue;
      attrs[key] = value;
    }
    return attrs;
  };
  const htmlAttrsLiteral = JSON.stringify(originAttrs(htmlElement));
  const bodyAttrsLiteral = JSON.stringify(originAttrs(body));

  ctx.usedNames.add("RootAttrs");
  const rootAttrsCode =
    language === "jsx"
      ? `import { useEffect } from "react";

export function RootAttrs() {
  const htmlAttrs = ${htmlAttrsLiteral};
  const bodyAttrs = ${bodyAttrsLiteral};

  useEffect(() => {
    for (const [key, value] of Object.entries(htmlAttrs)) {
      if (value) document.documentElement.setAttribute(key, value);
    }
    for (const [key, value] of Object.entries(bodyAttrs)) {
      if (value) document.body.setAttribute(key, value);
    }
  }, []);

  return null;
}
`
      : `import { useEffect } from "react";

export function RootAttrs() {
  const htmlAttrs: Record<string, string> = ${htmlAttrsLiteral};
  const bodyAttrs: Record<string, string> = ${bodyAttrsLiteral};

  useEffect(() => {
    for (const [key, value] of Object.entries(htmlAttrs)) {
      if (value) document.documentElement.setAttribute(key, value);
    }
    for (const [key, value] of Object.entries(bodyAttrs)) {
      if (value) document.body.setAttribute(key, value);
    }
  }, []);

  return null;
}
`;
  ctx.sections.push({
    name: "RootAttrs",
    filePath: `components/section/RootAttrs.${fileExtension(language)}`,
    imports: new Set<string>(),
    code: rootAttrsCode,
  });

  const topLevel = body ? renderChildren(body, 1, "framer", pageMap).join("\n") : "";
  const layout = `<RootAttrs />\n${topLevel}`.trimEnd();

  return { sections: ctx.sections, components: ctx.components, layout, framework };
}

export function convertHtmlToReactComponents(
  html: string,
  language: OutputLanguage = "tsx",
): {
  sections: ComponentSection[];
  components: ExtractedComponent[];
  layout: string;
  framework: FrameworkType;
} {
  // Default output: real JSX/TSX components, one file per section, composed in
  // the generated Home/page component (edit-friendly) instead of one giant HTML
  // string rendered through dangerouslySetInnerHTML.
  return createJsxSectionComponents(html, language);
}

export function extractCleanHtml(html: string): string {
  const root = parseHtml(html, PARSE_OPTIONS);

  for (const el of root.querySelectorAll("[data-site-cloner-selector]")) {
    el.remove();
  }
  for (const el of root.querySelectorAll("script[data-site-cloner-selector]")) {
    el.remove();
  }
  for (const el of root.querySelectorAll("style[data-site-cloner-selector]")) {
    el.remove();
  }

  for (const el of root.querySelectorAll("[data-weaver-hide]")) {
    el.removeAttribute("data-weaver-hide");
  }
  for (const el of root.querySelectorAll("[data-weaver-selected]")) {
    el.removeAttribute("data-weaver-selected");
  }

  return root.toString();
}
