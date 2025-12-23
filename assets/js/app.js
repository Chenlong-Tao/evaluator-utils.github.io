(() => {
  /**
   * @param {Element | Document} el
   * @param {string} selector
   * @returns {HTMLElement | null}
   */
  const qs = (el, selector) => /** @type {HTMLElement | null} */ (el.querySelector(selector));

  /**
   * @param {Element | Document} el
   * @param {string} selector
   * @returns {HTMLElement[]}
   */
  const qsa = (el, selector) => Array.from(el.querySelectorAll(selector)).filter((n) => n instanceof HTMLElement);

  /**
   * @param {string} text
   */
  const toast = (text) => {
    const node = document.getElementById("toast");
    if (!node) return;
    node.textContent = text;
    node.classList.add("show");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => node.classList.remove("show"), 1600);
  };
  toast._t = 0;

  /**
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        document.body.removeChild(ta);
        return false;
      }
    }
  };

  // --- Theme ---------------------------------------------------------------
  const THEME_KEY = "eu_theme";
  const CHAT_CREATE_DRAFT_KEY = "eu_chat_create_draft_v1";

  /**
   * @param {"light" | "dark"} theme
   */
  const applyTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
  };

  /**
   * @returns {"light" | "dark"}
   */
  const getPreferredTheme = () => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    const mql = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)");
    return mql && mql.matches ? "light" : "dark";
  };

  /**
   * @param {"light" | "dark"} theme
   */
  const persistTheme = (theme) => localStorage.setItem(THEME_KEY, theme);

  const initTheme = () => {
    const theme = getPreferredTheme();
    applyTheme(theme);
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      const next = current === "light" ? "dark" : "light";
      applyTheme(next);
      persistTheme(next);
      toast(`已切换到${next === "light" ? "浅色" : "深色"}主题`);
    });
  };

  // --- Chat Completions Create Editor --------------------------------------
  
  /**
   * @param {string} type
   * @returns {string}
   */
  const niceType = (type) => {
    let t = type
      .replace(/Optional\[(.+)\]/, "$1")
      .replace(/Union\[(.+)\]/, "$1")
      .replace("str", "String")
      .replace("int", "Int")
      .replace("bool", "Boolean")
      .replace("float", "Float")
      .replace("Dict", "Object")
      .replace("List", "Array")
      .replace("Iterable", "Array");
    if (t.length > 30) return "Complex"; // simplify long types
    return t;
  };

  /**
   * @param {string} s
   * @returns {string}
   */
  const trimOrEmpty = (s) => (s || "").trim();

  /**
   * @param {string} s
   * @returns {number | undefined}
   */
  const parseFloatOpt = (s) => {
    const t = trimOrEmpty(s);
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * @param {string} s
   * @returns {number | undefined}
   */
  const parseIntOpt = (s) => {
    const t = trimOrEmpty(s);
    if (!t) return undefined;
    if (!/^-?\d+$/.test(t)) return undefined;
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) ? n : undefined;
  };

  /**
   * @template T
   * @param {string} s
   * @returns {T | undefined}
   */
  const parseJsonOpt = (s) => {
    const t = trimOrEmpty(s);
    if (!t) return undefined;
    return /** @type {T} */ (JSON.parse(t));
  };

  /**
   * @param {unknown} v
   * @returns {boolean}
   */
  const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

  /**
   * @param {HTMLElement} wrap
   * @param {string[]} errors
   */
  const renderErrors = (wrap, errors) => {
    if (!errors.length) {
      wrap.classList.remove("show");
      wrap.innerHTML = "";
      return;
    }
    wrap.classList.add("show");
    const items = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("");
    wrap.innerHTML = `<ul>${items}</ul>`;
  };

  /**
   * @param {string} s
   * @returns {string}
   */
  const escapeHtml = (s) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  /**
   * @typedef {{ name: string; type: string; required: boolean; description: string }} SdkField
   */

  /**
   * @typedef {{ sdk: { name: string; version: string }; endpoint: string; body_fields?: SdkField[]; fields?: SdkField[]; request_options?: SdkField[] }} SdkSchema
   */

  /**
   * @returns {Promise<SdkSchema>}
   */
  const loadSdkSchema = async () => {
    const res = await fetch("assets/data/openai-1.99.9-chat-completions-create.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`加载 schema 失败：${res.status}`);
    return /** @type {Promise<SdkSchema>} */ (res.json());
  };

  /**
   * @param {string} typeStr
   * @returns {boolean}
   */
  const isBoolType = (typeStr) => /\bbool\b/.test(typeStr) || /Optional\[bool\]/.test(typeStr);

  /**
   * @param {string} typeStr
   * @returns {boolean}
   */
  const isIntType = (typeStr) => /\bint\b/.test(typeStr) || /Optional\[int\]/.test(typeStr);

  /**
   * @param {string} typeStr
   * @returns {boolean}
   */
  const isFloatType = (typeStr) => /\bfloat\b/.test(typeStr) || /Optional\[float\]/.test(typeStr);

  /**
   * @param {string} typeStr
   * @returns {boolean}
   */
  const isStringType = (typeStr) => {
    // We only treat the *top-level* type as string-ish.
    // Important: avoid matching container types like Dict[str, str] / List[str] just because they contain "str".
    const t = (typeStr || "").replace(/\s+/g, "");
    const unwrapOptional = (x) => {
      const m = x.match(/^Optional\[(.+)\]$/);
      return m ? m[1] : x;
    };
    const base = unwrapOptional(t);
    if (base === "str") return true;
    if (!base.startsWith("Union[")) return false;
    // Split Union[...] members at top-level commas.
    const inner = base.slice("Union[".length, -1); // assume trailing ]
    /** @type {string[]} */
    const parts = [];
    let cur = "";
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "[" || ch === "(" || ch === "{") depth++;
      else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur) parts.push(cur);
    return parts.map(unwrapOptional).some((p) => p === "str");
  };

  /**
   * @param {string} typeStr
   * @returns {string[] | null}
   */
  const parseLiteralOptionsFromType = (typeStr) => {
    const m = typeStr.match(/Literal\[(.+)\]/);
    if (!m) return null;
    // naive parse: "a", "b"
    const raw = m[1];
    const opts = Array.from(raw.matchAll(/"([^"]+)"/g)).map((x) => x[1]);
    return opts.length ? opts : null;
  };

  /**
   * @param {string} description
   * @returns {string[] | null}
   */
  const parseBacktickedOptionsFromDescription = (description) => {
    const d = description || "";
    const looksLikeEnum =
      /supported values are/i.test(d) || /supported values/i.test(d) || /currently supported/i.test(d) || /possible values/i.test(d);
    if (!looksLikeEnum) return null;
    const opts = Array.from(d.matchAll(/`([^`]+)`/g))
      .map((m) => m[1])
      .filter((s) => s && s.length <= 32);
    const uniq = Array.from(new Set(opts));
    return uniq.length >= 2 ? uniq : null;
  };

  /**
   * @param {SdkField} f
   * @returns {"bool" | "int" | "float" | "string" | "string_select" | "stop_lines" | "checks" | "json"}
   */
  const fieldKind = (f) => {
    if (f.name === "stop") return "stop_lines";
    const lit = parseLiteralOptionsFromType(f.type);
    if (lit && /List\[Literal\[/.test(f.type)) return "checks";
    if (isBoolType(f.type)) return "bool";
    if (isIntType(f.type)) return "int";
    if (isFloatType(f.type)) return "float";
    if (isStringType(f.type)) {
      const fromDesc = parseBacktickedOptionsFromDescription(f.description);
      if (fromDesc) return "string_select";
      return "string";
    }
    return "json";
  };

  /**
   * @param {SdkField} f
   * @returns {HTMLElement}
   */
  const renderField = (f) => {
    const kind = fieldKind(f);
    const wrap = document.createElement("div");
    wrap.className = "param-item";
    wrap.setAttribute("data-field", f.name);
    wrap.setAttribute("data-kind", kind);
    wrap.setAttribute("data-type", f.type);
    wrap.setAttribute("data-required", f.required ? "true" : "false");

    // Determine size for layout
    const isSmall = kind === "bool" || kind === "int" || kind === "float" || kind === "string_select" || kind === "string";
    wrap.setAttribute("data-size", isSmall ? "small" : "large");

    const title = `${f.name}${f.required ? " *" : ""}`; 
    const descHtml = escapeHtml(f.description || "").replaceAll("\n", "<br />");
    const prettyType = niceType(f.type);

    const head = document.createElement("div");
    head.className = "param-head";
    head.innerHTML = `
      <div class="param-name-wrap">
        <div class="param-name">${escapeHtml(title)}</div>
        ${f.required ? '<div class="badge badge-req">必填</div>' : ""}
      </div>
      <div class="param-type" title="${escapeHtml(f.type)}">${escapeHtml(prettyType)}</div>
    `;
    wrap.appendChild(head);

    const field = document.createElement("div");
    field.className = "field";

    /** @type {HTMLElement} */
    let input;
    if (kind === "bool") {
      const sel = document.createElement("select");
      sel.className = "input";
      sel.setAttribute("data-role", "value");
      sel.innerHTML = `<option value="">默认 / 不传</option><option value="false">false (关闭)</option><option value="true">true (开启)</option>`;
      input = sel;
    } else if (kind === "int" || kind === "float") {
      const inp = document.createElement("input");
      inp.className = "input";
      inp.setAttribute("data-role", "value");
      inp.setAttribute("placeholder", kind === "int" ? "整数" : "数字");
      inp.setAttribute("inputmode", kind === "int" ? "numeric" : "decimal");
      input = inp;
    } else if (kind === "string_select") {
      const sel = document.createElement("select");
      sel.className = "input";
      sel.setAttribute("data-role", "value");
      const opts = parseBacktickedOptionsFromDescription(f.description || "") || [];
      sel.innerHTML = `<option value="">默认 / 不传</option>${opts.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}`;
      input = sel;
    } else if (kind === "string") {
      const inp = document.createElement("input");
      inp.className = "input";
      inp.setAttribute("data-role", "value");
      inp.setAttribute("placeholder", "输入文本...");
      input = inp;
    } else if (kind === "stop_lines") {
      const ta = document.createElement("textarea");
      ta.className = "textarea";
      ta.setAttribute("data-role", "value");
      ta.setAttribute("spellcheck", "false");
      ta.setAttribute("placeholder", "每行一个停止词 (stop sequence)");
      input = ta;
    } else if (kind === "checks") {
      const lit = parseLiteralOptionsFromType(f.type) || [];
      const box = document.createElement("div");
      box.className = "checks";
      box.setAttribute("data-role", "value");
      box.innerHTML = lit
        .map(
          (o) =>
            `<label class="check"><input type="checkbox" value="${escapeHtml(o)}" /> <span>${escapeHtml(o)}</span></label>`,
        )
        .join("");
      input = box;
    } else {
      const ta = document.createElement("textarea");
      ta.className = "textarea";
      ta.setAttribute("data-role", "value");
      ta.setAttribute("spellcheck", "false");
      const looksArray = /Iterable\[|List\[|Sequence\[/.test(f.type);
      ta.setAttribute("placeholder", looksArray ? "JSON 数组 [...]" : "JSON 对象 {...}");
      input = ta;
    }

    field.appendChild(input);

    const help = document.createElement("div");
    help.className = "help muted";
    help.innerHTML = descHtml || `<span class="muted">暂无说明</span>`;
    field.appendChild(help);

    wrap.appendChild(field);
    return wrap;
  };

  /**
   * @param {HTMLElement} root
   */
  const initChatCreateEditor = (root) => {
    const modelEl = /** @type {HTMLInputElement | null} */ (qs(root, '[data-role="model"]'));
    const paramSearchEl = /** @type {HTMLInputElement | null} */ (qs(root, '[data-role="paramSearch"]'));
    const autoParamsEl = qs(root, '[data-role="autoParams"]');
    const requestOptionsEl = qs(root, '[data-role="requestOptions"]');
    const outputEl = /** @type {HTMLTextAreaElement | null} */ (qs(root, '[data-role="output"]'));
    const outputDisplayEl = qs(root, '[data-role="output-display"]');
    const hintEl = qs(root, '[data-role="hint"]');
    const errorsEl = qs(root, '[data-role="errors"]');
    const extraEl = /** @type {HTMLTextAreaElement | null} */ (qs(root, '[data-role="extra"]'));

    if (!outputEl || !hintEl || !errorsEl || !modelEl || !autoParamsEl || !requestOptionsEl) return;

    /**
     * @returns {Record<string, unknown>}
     */
    const readDraft = () => {
      try {
        const raw = localStorage.getItem(CHAT_CREATE_DRAFT_KEY);
        if (!raw) return {};
        const v = JSON.parse(raw);
        return isPlainObject(v) ? /** @type {Record<string, unknown>} */ (v) : {};
      } catch {
        return {};
      }
    };

    /**
     * @param {Record<string, unknown>} draft
     */
    const writeDraft = (draft) => {
      try {
        localStorage.setItem(CHAT_CREATE_DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // ignore quota / private mode errors
      }
    };

    const clearDraft = () => {
      try {
        localStorage.removeItem(CHAT_CREATE_DRAFT_KEY);
      } catch {
        // ignore
      }
    };

    /**
     * @returns {Record<string, unknown>}
     */
    const snapshotForm = () => {
      /** @type {Record<string, unknown>} */
      const draft = {};

      const model = trimOrEmpty(modelEl.value);
      if (model) draft.model = model;
      if (extraEl && trimOrEmpty(extraEl.value)) draft.extra = extraEl.value;

      /** @type {Record<string, unknown>} */
      const auto = {};
      qsa(autoParamsEl, "[data-field]").forEach((item) => {
        const name = item.getAttribute("data-field") || "";
        if (!name) return;
        const kind = item.getAttribute("data-kind") || "json";
        const vEl = qs(item, '[data-role="value"]');
        if (!vEl) return;

        if (kind === "checks") {
          const checked = qsa(vEl, 'input[type="checkbox"]').filter((c) => /** @type {HTMLInputElement} */ (c).checked);
          auto[name] = checked.map((c) => /** @type {HTMLInputElement} */ (c).value);
          return;
        }

        if (vEl instanceof HTMLInputElement || vEl instanceof HTMLTextAreaElement || vEl instanceof HTMLSelectElement) {
          if (vEl.value !== "") auto[name] = vEl.value;
        }
      });
      draft.auto = auto;

      /** @type {Record<string, unknown>} */
      const opts = {};
      qsa(requestOptionsEl, "[data-field]").forEach((item) => {
        const name = item.getAttribute("data-field") || "";
        if (!name) return;
        const kind = item.getAttribute("data-kind") || "json";
        const vEl = qs(item, '[data-role="value"]');
        if (!vEl) return;

        if (kind === "checks") {
          const checked = qsa(vEl, 'input[type="checkbox"]').filter((c) => /** @type {HTMLInputElement} */ (c).checked);
          opts[name] = checked.map((c) => /** @type {HTMLInputElement} */ (c).value);
          return;
        }

        if (vEl instanceof HTMLInputElement || vEl instanceof HTMLTextAreaElement || vEl instanceof HTMLSelectElement) {
          if (vEl.value !== "") opts[name] = vEl.value;
        }
      });
      draft.options = opts;

      return draft;
    };

    /**
     * @param {Record<string, unknown>} draft
     */
    const applyDraft = (draft) => {
      if (typeof draft.model === "string") modelEl.value = draft.model;
      if (extraEl && typeof draft.extra === "string") extraEl.value = draft.extra;

      const auto = isPlainObject(draft.auto) ? /** @type {Record<string, unknown>} */ (draft.auto) : {};
      qsa(autoParamsEl, "[data-field]").forEach((item) => {
        const name = item.getAttribute("data-field") || "";
        if (!name) return;
        if (!(name in auto)) return;
        const kind = item.getAttribute("data-kind") || "json";
        const vEl = qs(item, '[data-role="value"]');
        if (!vEl) return;

        if (kind === "checks") {
          const want = Array.isArray(auto[name]) ? auto[name].map(String) : [];
          qsa(vEl, 'input[type="checkbox"]').forEach((c) => {
            const cc = /** @type {HTMLInputElement} */ (c);
            cc.checked = want.includes(cc.value);
          });
          return;
        }

        if (vEl instanceof HTMLInputElement || vEl instanceof HTMLTextAreaElement || vEl instanceof HTMLSelectElement) {
          vEl.value = typeof auto[name] === "string" ? auto[name] : String(auto[name] ?? "");
        }
      });

      const opts = isPlainObject(draft.options) ? /** @type {Record<string, unknown>} */ (draft.options) : {};
      qsa(requestOptionsEl, "[data-field]").forEach((item) => {
        const name = item.getAttribute("data-field") || "";
        if (!name) return;
        if (!(name in opts)) return;
        const kind = item.getAttribute("data-kind") || "json";
        const vEl = qs(item, '[data-role="value"]');
        if (!vEl) return;

        if (kind === "checks") {
          const want = Array.isArray(opts[name]) ? opts[name].map(String) : [];
          qsa(vEl, 'input[type="checkbox"]').forEach((c) => {
            const cc = /** @type {HTMLInputElement} */ (c);
            cc.checked = want.includes(cc.value);
          });
          return;
        }

        if (vEl instanceof HTMLInputElement || vEl instanceof HTMLTextAreaElement || vEl instanceof HTMLSelectElement) {
          vEl.value = typeof opts[name] === "string" ? opts[name] : String(opts[name] ?? "");
        }
      });
    };

    /** @type {number} */
    let persistTimer = 0;
    const schedulePersist = () => {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => writeDraft(snapshotForm()), 120);
    };

    const reset = () => {
      modelEl.value = "";
      if (extraEl) extraEl.value = "";
      // reset all auto fields
      qsa(autoParamsEl, "[data-field]").forEach((item) => {
        const kind = item.getAttribute("data-kind") || "";
        const v = qs(item, '[data-role="value"]');
        if (!v) return;
        if (kind === "checks") {
          qsa(v, 'input[type="checkbox"]').forEach((c) => {
            /** @type {HTMLInputElement} */ (c).checked = false;
          });
          return;
        }
        if (v instanceof HTMLInputElement || v instanceof HTMLTextAreaElement || v instanceof HTMLSelectElement) v.value = "";
      });
      // reset request options
      qsa(requestOptionsEl, "[data-field]").forEach((item) => {
        const kind = item.getAttribute("data-kind") || "";
        const v = qs(item, '[data-role="value"]');
        if (!v) return;
        if (kind === "checks") {
          qsa(v, 'input[type="checkbox"]').forEach((c) => {
            /** @type {HTMLInputElement} */ (c).checked = false;
          });
          return;
        }
        if (v instanceof HTMLInputElement || v instanceof HTMLTextAreaElement || v instanceof HTMLSelectElement) v.value = "";
      });
      sync();
      clearDraft();
      // Clear output but show hint
      if (outputEl) outputEl.value = "";
      if (outputDisplayEl) outputDisplayEl.textContent = "";
      hintEl.textContent = "参数已重置";
    };

    /**
     * @returns {{ ok: boolean; errors: string[]; body?: Record<string, unknown>; options?: Record<string, unknown>; merged?: Record<string, unknown> }}
     */
    const validateAndBuild = () => {
      /** @type {string[]} */
      const errors = [];

      const model = trimOrEmpty(modelEl.value);

      /** @type {Record<string, unknown>} */
      const autoValues = {};
      qsa(autoParamsEl, "[data-field]").forEach((item) => {
        const name = item.getAttribute("data-field") || "";
        if (!name) return;
        const kind = item.getAttribute("data-kind") || "json";
        const required = item.getAttribute("data-required") === "true";

        const vEl = qs(item, '[data-role="value"]');
        if (!vEl) return;

        /** @type {unknown} */
        let value = undefined;

        try {
          if (kind === "checks") {
            const checked = qsa(vEl, 'input[type="checkbox"]').filter((c) => /** @type {HTMLInputElement} */ (c).checked);
            value = checked.length ? checked.map((c) => /** @type {HTMLInputElement} */ (c).value) : undefined;
          } else if (kind === "bool") {
            const s = vEl instanceof HTMLSelectElement ? vEl.value : "";
            value = s === "" ? undefined : s === "true";
          } else if (kind === "int") {
            const s = vEl instanceof HTMLInputElement ? vEl.value : "";
            if (trimOrEmpty(s)) {
              const n = parseIntOpt(s);
              if (n === undefined) throw new Error("必须是整数");
              value = n;
            }
          } else if (kind === "float") {
            const s = vEl instanceof HTMLInputElement ? vEl.value : "";
            if (trimOrEmpty(s)) {
              const n = parseFloatOpt(s);
              if (n === undefined) throw new Error("必须是数字");
              value = n;
            }
          } else if (kind === "string" || kind === "string_select") {
            const s =
              vEl instanceof HTMLInputElement || vEl instanceof HTMLSelectElement ? vEl.value : vEl instanceof HTMLTextAreaElement ? vEl.value : "";
            value = trimOrEmpty(s) ? trimOrEmpty(s) : undefined;
          } else if (kind === "stop_lines") {
            const s = vEl instanceof HTMLTextAreaElement ? vEl.value : "";
            const lines = s
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean);
            value = lines.length === 0 ? undefined : lines.length === 1 ? lines[0] : lines;
          } else {
            const s = vEl instanceof HTMLTextAreaElement ? vEl.value : "";
            if (trimOrEmpty(s)) value = parseJsonOpt(s);
          }
        } catch (ex) {
          errors.push(`${name} 解析失败：${ex instanceof Error ? ex.message : "未知错误"}`);
          return;
        }

        if (required && value === undefined) errors.push(`${name} 为必填字段。`);
        if (value !== undefined) autoValues[name] = value;
      });

      /** @type {Record<string, unknown>} */
      const optionValues = {};
      qsa(requestOptionsEl, "[data-field]").forEach((item) => {
        const name = item.getAttribute("data-field") || "";
        if (!name) return;
        const kind = item.getAttribute("data-kind") || "json";
        const required = item.getAttribute("data-required") === "true";

        const vEl = qs(item, '[data-role="value"]');
        if (!vEl) return;

        /** @type {unknown} */
        let value = undefined;

        try {
          if (kind === "checks") {
            const checked = qsa(vEl, 'input[type="checkbox"]').filter((c) => /** @type {HTMLInputElement} */ (c).checked);
            value = checked.length ? checked.map((c) => /** @type {HTMLInputElement} */ (c).value) : undefined;
          } else if (kind === "bool") {
            const s = vEl instanceof HTMLSelectElement ? vEl.value : "";
            value = s === "" ? undefined : s === "true";
          } else if (kind === "int") {
            const s = vEl instanceof HTMLInputElement ? vEl.value : "";
            if (trimOrEmpty(s)) {
              const n = parseIntOpt(s);
              if (n === undefined) throw new Error("必须是整数");
              value = n;
            }
          } else if (kind === "float") {
            const s = vEl instanceof HTMLInputElement ? vEl.value : "";
            if (trimOrEmpty(s)) {
              const n = parseFloatOpt(s);
              if (n === undefined) throw new Error("必须是数字");
              value = n;
            }
          } else if (kind === "string" || kind === "string_select") {
            const s =
              vEl instanceof HTMLInputElement || vEl instanceof HTMLSelectElement ? vEl.value : vEl instanceof HTMLTextAreaElement ? vEl.value : "";
            value = trimOrEmpty(s) ? trimOrEmpty(s) : undefined;
          } else if (kind === "stop_lines") {
            const s = vEl instanceof HTMLTextAreaElement ? vEl.value : "";
            const lines = s
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean);
            value = lines.length === 0 ? undefined : lines.length === 1 ? lines[0] : lines;
          } else {
            const s = vEl instanceof HTMLTextAreaElement ? vEl.value : "";
            if (trimOrEmpty(s)) value = parseJsonOpt(s);
          }
        } catch (ex) {
          errors.push(`${name} 解析失败：${ex instanceof Error ? ex.message : "未知错误"}`);
          return;
        }

        if (required && value === undefined) errors.push(`${name} 为必填字段。`);
        if (value !== undefined) optionValues[name] = value;
      });

      // Common numeric range checks (SDK doc says these ranges)
      if (typeof autoValues.temperature === "number" && (autoValues.temperature < 0 || autoValues.temperature > 2)) errors.push("temperature 范围为 0~2。");
      if (typeof autoValues.top_p === "number" && (autoValues.top_p < 0 || autoValues.top_p > 1)) errors.push("top_p 范围为 0~1。");
      if (typeof autoValues.presence_penalty === "number" && (autoValues.presence_penalty < -2 || autoValues.presence_penalty > 2))
        errors.push("presence_penalty 范围为 -2~2。");
      if (typeof autoValues.frequency_penalty === "number" && (autoValues.frequency_penalty < -2 || autoValues.frequency_penalty > 2))
        errors.push("frequency_penalty 范围为 -2~2。");
      if (autoValues.logit_bias !== undefined && !isPlainObject(autoValues.logit_bias)) errors.push("logit_bias 必须是 JSON object（token_id → int）。");

      /** @type {Record<string, unknown> | undefined} */
      let extra;
      if (extraEl && trimOrEmpty(extraEl.value)) {
        try {
          const v = parseJsonOpt(extraEl.value);
          if (!isPlainObject(v)) errors.push("extra 必须是 JSON object。");
          else extra = v;
        } catch (ex) {
          errors.push(`extra JSON 解析失败：${ex instanceof Error ? ex.message : "未知错误"}`);
        }
      }

      /** @type {Record<string, unknown>} */
      const body = {};
      if (model) body.model = model;
      Object.assign(body, autoValues);
      if (extra) Object.assign(body, extra);

      /** @type {Record<string, unknown>} */
      const merged = {};
      Object.assign(merged, body);
      Object.assign(merged, optionValues);
      return { ok: errors.length === 0, errors, body, options: optionValues, merged };
    };

    const sync = () => {
      const res = validateAndBuild();
      renderErrors(errorsEl, res.errors);
      // Always show best-effort JSON output, even when validation fails.
      const compact = JSON.stringify(res.merged || {});
      const pretty = JSON.stringify(res.merged || {}, null, 2);
      
      if (outputEl) outputEl.value = compact;
      if (outputDisplayEl) outputDisplayEl.textContent = pretty;

      hintEl.textContent = res.ok
        ? "校验通过：可复制总 JSON。"
        : "未通过校验：输出框仍会实时展示当前可解析的总 JSON（错误字段已忽略），请修正错误后再复制。";
      return res;
    };

    root.addEventListener("click", async (e) => {
      const t = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target : null);
      if (!t) return;
      const btn = t.closest("[data-action]");
      if (!(btn instanceof HTMLElement)) return;
      const action = btn.getAttribute("data-action") || "";

      if (action === "reset") {
        reset();
        toast("已重置");
        return;
      }

      if (action === "copy-output") {
        const res = sync();
        if (!res || !res.ok) {
          toast("当前未通过校验，无法复制（请先修正错误）");
          return;
        }
        const text = outputEl.value;
        const ok = await copyToClipboard(text);
        toast(ok ? "已复制到剪贴板" : "复制失败（浏览器权限限制）");
        return;
      }
    });

    root.addEventListener("input", () => {
      sync();
      schedulePersist();
    });
    root.addEventListener("change", () => {
      sync();
      schedulePersist();
    });

    // Render auto params from schema, then reset.
    loadSdkSchema()
      .then((schema) => {
        const bodyFields = (schema.body_fields || schema.fields || []).filter((f) => f.name !== "model" && f.name !== "messages");
        const optFields = schema.request_options || [];
        autoParamsEl.innerHTML = "";
        requestOptionsEl.innerHTML = "";
        bodyFields.forEach((f) => autoParamsEl.appendChild(renderField(f)));
        optFields.forEach((f) => requestOptionsEl.appendChild(renderField(f)));
        if (paramSearchEl) {
          paramSearchEl.addEventListener("input", () => {
            const q = trimOrEmpty(paramSearchEl.value).toLowerCase();
            const apply = (host) => {
              qsa(host, "[data-field]").forEach((item) => {
                const name = (item.getAttribute("data-field") || "").toLowerCase();
                item.style.display = !q || name.includes(q) ? "grid" : "none";
              });
            };
            apply(autoParamsEl);
            apply(requestOptionsEl);
          });
        }
        // Prefer restoring last draft; fallback to a clean reset.
        const draft = readDraft();
        reset();
        if (Object.keys(draft).length) {
          applyDraft(draft);
          sync();
        }
      })
      .catch((e) => {
        renderErrors(errorsEl, [`加载参数元数据失败：${e instanceof Error ? e.message : String(e)}`]);
        outputEl.value = "";
        hintEl.textContent = "无法加载参数清单，请刷新或检查 assets/data 文件是否存在。";
      });
  };

  const initYear = () => {
    const y = document.getElementById("year");
    if (y) y.textContent = String(new Date().getFullYear());
  };

  // boot
  initTheme();
  const editor = document.querySelector('[data-tool="chat-create"]');
  if (editor instanceof HTMLElement) initChatCreateEditor(editor);
  initYear();
})();


