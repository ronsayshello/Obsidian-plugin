"use strict";

const {
  Plugin,
  ItemView,
  Notice,
  MarkdownView,
  PluginSettingTab,
  Setting,
  Menu,
  setIcon,
} = require("obsidian");

/* ------------------------------------------------------------------ *
 *  Constants
 * ------------------------------------------------------------------ */

const VIEW_TYPE = "libreoffice-symbols-view";
const ICON = "sigma";
const MAX_RECENT = 24;
const ALL = "All";
const LONG_PRESS_MS = 500;
const SIZES = ["small", "medium", "large"];

const DEFAULT_SETTINGS = {
  insertMode: "char", // "char" | "entity"
  symbolSize: "medium", // "small" | "medium" | "large"
  showTabs: true,
  showRecent: true,
  showCount: true,
  trailingSpace: false,
  autoClose: false,
  recent: [],
  favorites: [],
};

/* ------------------------------------------------------------------ *
 *  Data helpers
 *  symbols.json format:  { "Category": [ [char, name, entityName?], ... ] }
 *  Code point (U+XXXX) and a fallback numeric entity are computed here.
 * ------------------------------------------------------------------ */

function buildSymbolIndex(data) {
  const list = [];
  for (const [category, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const [char, name, entity] = entry;
      if (!char) continue;
      const hex = char.codePointAt(0).toString(16).toUpperCase();
      list.push({
        char,
        name: name || "",
        category,
        code: "U+" + hex.padStart(4, "0"),
        entity: entity ? `&${entity};` : `&#x${hex};`,
      });
    }
  }
  return list;
}

function matchesQuery(sym, terms) {
  if (terms.length === 0) return true;
  const haystack = [
    sym.char,
    sym.name,
    sym.category,
    sym.code,
    sym.entity,
    sym.code.replace("U+", ""),
    sym.entity.replace(/[&;#]/g, ""),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/* ------------------------------------------------------------------ *
 *  Plugin
 * ------------------------------------------------------------------ */

module.exports = class LibreOfficeSymbolsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.symbols = [];
    this.categories = [];
    this.symbolByChar = new Map();
    this.lastMarkdownLeaf = null;

    await this.loadSymbols();

    this.registerView(VIEW_TYPE, (leaf) => new SymbolsView(leaf, this));

    this.addRibbonIcon(ICON, "Open symbols panel", () => this.activateView());

    this.addCommand({
      id: "open-panel",
      name: "Open Panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "close-panel",
      name: "Close Panel",
      callback: () => this.app.workspace.detachLeavesOfType(VIEW_TYPE),
    });

    this.addSettingTab(new SymbolsSettingTab(this.app, this));

    // Remember the last editor the user was in, because clicking the
    // sidebar makes the sidebar the "active" view.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => this.trackLeaf(leaf))
    );
    this.app.workspace.onLayoutReady(() =>
      this.trackLeaf(this.app.workspace.getMostRecentLeaf())
    );
  }

  onunload() {
    // Views registered with registerView are cleaned up by Obsidian.
  }

  /* ---------- data loading ---------- */

  async loadSymbols() {
    const adapter = this.app.vault.adapter;
    const dir = this.manifest.dir;
    let data = {};

    try {
      data = JSON.parse(await adapter.read(`${dir}/symbols.json`));
    } catch (err) {
      console.error("LibreOffice Symbols: could not read symbols.json", err);
      new Notice("LibreOffice Symbols: could not load symbols.json");
    }

    // Optional user file: add or extend categories without touching symbols.json
    try {
      const customPath = `${dir}/custom-symbols.json`;
      if (await adapter.exists(customPath)) {
        const custom = JSON.parse(await adapter.read(customPath));
        for (const [cat, entries] of Object.entries(custom)) {
          data[cat] = (data[cat] || []).concat(entries);
        }
      }
    } catch (err) {
      console.error("LibreOffice Symbols: could not read custom-symbols.json", err);
      new Notice("LibreOffice Symbols: custom-symbols.json is invalid");
    }

    this.symbols = buildSymbolIndex(data);
    this.categories = Object.keys(data);
    this.symbolByChar = new Map();
    for (const s of this.symbols) {
      if (!this.symbolByChar.has(s.char)) this.symbolByChar.set(s.char, s);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.recent)) this.settings.recent = [];
    if (!Array.isArray(this.settings.favorites)) this.settings.favorites = [];
    if (!SIZES.includes(this.settings.symbolSize)) {
      this.settings.symbolSize = DEFAULT_SETTINGS.symbolSize;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ---------- view handling ---------- */

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  forEachView(fn) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof SymbolsView) fn(leaf.view);
    }
  }

  /** Re-render everything (used after a settings change). */
  refreshAll() {
    this.forEachView((v) => v.refresh());
  }

  refreshRecent() {
    this.forEachView((v) => v.renderRecent());
  }

  refreshFavorites() {
    this.forEachView((v) => {
      v.renderFavorites();
      v.updateFavoriteMarks();
    });
  }

  /* ---------- favourites ---------- */

  isFavorite(char) {
    return this.settings.favorites.includes(char);
  }

  async toggleFavorite(char) {
    const favs = this.settings.favorites;
    const i = favs.indexOf(char);
    if (i >= 0) favs.splice(i, 1);
    else favs.push(char);
    await this.saveSettings();
    this.refreshFavorites();
  }

  /* ---------- editor targeting ---------- */

  trackLeaf(leaf) {
    if (leaf && leaf.view instanceof MarkdownView) {
      this.lastMarkdownLeaf = leaf;
    }
  }

  getTargetEditorView() {
    const leaf = this.lastMarkdownLeaf;
    const stillOpen =
      leaf &&
      leaf.view instanceof MarkdownView &&
      this.app.workspace.getLeavesOfType("markdown").includes(leaf);
    if (stillOpen) return leaf.view;
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  /* ---------- click action ---------- */

  async insertSymbol(sym) {
    let text = this.settings.insertMode === "entity" ? sym.entity : sym.char;
    if (this.settings.trailingSpace) text += " ";

    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      console.error("LibreOffice Symbols: clipboard write failed", err);
    }

    let inserted = false;
    const view = this.getTargetEditorView();
    if (view && view.editor) {
      view.editor.replaceSelection(text);
      inserted = true;
    }

    // Recently used
    this.settings.recent = [
      sym.char,
      ...this.settings.recent.filter((c) => c !== sym.char),
    ].slice(0, MAX_RECENT);
    await this.saveSettings();

    const shown = text.trim();
    let msg;
    if (copied && inserted) msg = `${shown}  copied and inserted`;
    else if (copied) msg = `${shown}  copied (no open note to insert into)`;
    else if (inserted) msg = `${shown}  inserted (clipboard unavailable)`;
    else msg = "Could not copy or insert the symbol";
    new Notice(msg, 1500);

    if (this.settings.autoClose) {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    } else {
      this.refreshRecent();
    }
  }
};

/* ------------------------------------------------------------------ *
 *  Sidebar view
 * ------------------------------------------------------------------ */

class SymbolsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.query = "";
    this.category = ALL;
    this.longPressFired = false;
    this.pressTimer = null;
    this.lastMenuTime = 0;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Symbols";
  }

  getIcon() {
    return ICON;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("los-container");

    // Search + header (sticky)
    const searchWrap = root.createDiv({ cls: "los-search-wrap" });

    const header = searchWrap.createDiv({ cls: "los-header" });
    header.createDiv({ cls: "los-title", text: "Symbols" });
    const closeBtn = header.createEl("button", {
      cls: "los-close",
      attr: { "aria-label": "Close panel", title: "Close panel" },
    });
    setIcon(closeBtn, "x");
    this.registerDomEvent(closeBtn, "click", () => this.leaf.detach());

    this.searchEl = searchWrap.createEl("input", {
      cls: "los-search",
      type: "search",
      attr: {
        placeholder: "Search name, character, entity or U+code…",
        "aria-label": "Search symbols",
      },
    });
    this.registerDomEvent(this.searchEl, "input", () => {
      this.query = this.searchEl.value;
      this.renderGrid();
    });

    // Sections
    this.tabsEl = root.createDiv({ cls: "los-tabs" });
    this.favEl = root.createDiv({ cls: "los-favs" });
    this.recentEl = root.createDiv({ cls: "los-recent" });
    this.countEl = root.createDiv({ cls: "los-count" });
    this.gridEl = root.createDiv({ cls: "los-grid" });

    this.bindSymbolEvents(this.gridEl);
    this.bindSymbolEvents(this.favEl);
    this.bindSymbolEvents(this.recentEl);

    this.refresh();
  }

  async onClose() {
    window.clearTimeout(this.pressTimer);
    this.contentEl.empty();
  }

  /* ---------- rendering ---------- */

  refresh() {
    this.applyLayout();
    this.renderTabs();
    this.renderFavorites();
    this.renderRecent();
    this.renderGrid();
  }

  applyLayout() {
    const s = this.plugin.settings;
    const root = this.contentEl;

    for (const size of SIZES) root.removeClass(`los-size-${size}`);
    root.addClass(`los-size-${s.symbolSize}`);

    // If the tabs are hidden, don't leave the user filtered on a category
    if (!s.showTabs) this.category = ALL;

    this.tabsEl.toggleClass("is-hidden", !s.showTabs);
    this.countEl.toggleClass("is-hidden", !s.showCount);
  }

  renderTabs() {
    this.tabsEl.empty();
    for (const name of [ALL, ...this.plugin.categories]) {
      const btn = this.tabsEl.createEl("button", {
        cls: "los-tab",
        text: name,
      });
      if (name === this.category) btn.addClass("is-active");
      this.registerDomEvent(btn, "click", () => {
        this.category = name;
        this.renderTabs();
        this.renderGrid();
      });
    }
  }

  renderFavorites() {
    this.favEl.empty();
    const favs = this.plugin.settings.favorites
      .map((c) => this.plugin.symbolByChar.get(c))
      .filter(Boolean);

    if (favs.length === 0) {
      this.favEl.createDiv({
        cls: "los-fav-hint",
        text: "Favourites: right-click (or long-press) a symbol to pin it",
      });
      return;
    }

    this.favEl.createDiv({ cls: "los-fav-label", text: "Favourites" });
    const row = this.favEl.createDiv({ cls: "los-fav-row" });
    for (const sym of favs) this.createSymbolButton(row, sym);
  }

  renderRecent() {
    if (!this.recentEl) return;
    this.recentEl.empty();

    const recent = this.plugin.settings.recent
      .map((c) => this.plugin.symbolByChar.get(c))
      .filter(Boolean);

    const hidden = !this.plugin.settings.showRecent || recent.length === 0;
    this.recentEl.toggleClass("is-hidden", hidden);
    if (hidden) return;

    this.recentEl.createDiv({ cls: "los-recent-label", text: "Recently used" });
    const row = this.recentEl.createDiv({ cls: "los-recent-row" });
    for (const sym of recent) this.createSymbolButton(row, sym);
  }

  renderGrid() {
    this.gridEl.empty();

    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set();
    const results = [];

    for (const sym of this.plugin.symbols) {
      if (this.category !== ALL && sym.category !== this.category) continue;
      if (!matchesQuery(sym, terms)) continue;
      if (this.category === ALL) {
        // The same character can live in more than one category
        if (seen.has(sym.char)) continue;
        seen.add(sym.char);
      }
      results.push(sym);
    }

    this.countEl.setText(
      results.length === 1 ? "1 symbol" : `${results.length} symbols`
    );

    if (results.length === 0) {
      this.gridEl.createDiv({ cls: "los-empty", text: "No symbols found." });
      return;
    }
    for (const sym of results) this.createSymbolButton(this.gridEl, sym);
  }

  createSymbolButton(parent, sym) {
    const btn = parent.createEl("button", {
      cls: "los-symbol",
      text: sym.char,
      attr: {
        title: `${sym.name}\n${sym.code} · ${sym.entity}`,
        "aria-label": `${sym.name} (${sym.code})`,
        "data-char": sym.char,
      },
    });
    if (this.plugin.isFavorite(sym.char)) btn.addClass("is-fav");
    return btn;
  }

  /** Update the favourite highlight on existing buttons without re-rendering. */
  updateFavoriteMarks() {
    this.contentEl.querySelectorAll(".los-symbol").forEach((btn) => {
      const fav = this.plugin.isFavorite(btn.getAttribute("data-char"));
      btn.toggleClass("is-fav", fav);
    });
  }

  /* ---------- events ---------- */

  bindSymbolEvents(el) {
    // Keep focus in the editor when pressing a symbol
    this.registerDomEvent(el, "mousedown", (ev) => {
      if (ev.target.closest(".los-symbol")) ev.preventDefault();
    });

    this.registerDomEvent(el, "click", (ev) => this.onSymbolClick(ev));

    // Right-click (desktop)
    this.registerDomEvent(el, "contextmenu", (ev) => {
      const btn = ev.target.closest(".los-symbol");
      if (!btn) return;
      ev.preventDefault();
      if (Date.now() - this.lastMenuTime < 1000) return; // long-press already handled it
      this.lastMenuTime = Date.now();
      this.showSymbolMenu(btn, { event: ev });
    });

    // Long-press (touch devices)
    this.registerDomEvent(
      el,
      "touchstart",
      (ev) => {
        const btn = ev.target.closest(".los-symbol");
        if (!btn || !ev.touches[0]) return;
        this.longPressFired = false;
        const pos = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
        window.clearTimeout(this.pressTimer);
        this.pressTimer = window.setTimeout(() => {
          this.longPressFired = true;
          if (Date.now() - this.lastMenuTime < 1000) return;
          this.lastMenuTime = Date.now();
          this.showSymbolMenu(btn, { pos });
        }, LONG_PRESS_MS);
      },
      { passive: true }
    );

    const cancelPress = () => window.clearTimeout(this.pressTimer);
    this.registerDomEvent(el, "touchmove", cancelPress, { passive: true });
    this.registerDomEvent(el, "touchend", cancelPress, { passive: true });
    this.registerDomEvent(el, "touchcancel", cancelPress, { passive: true });
  }

  showSymbolMenu(btn, where) {
    const sym = this.plugin.symbolByChar.get(btn.getAttribute("data-char"));
    if (!sym) return;

    const fav = this.plugin.isFavorite(sym.char);
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(fav ? "Remove from favourites" : "Add to favourites")
        .setIcon(fav ? "star-off" : "star")
        .onClick(() => this.plugin.toggleFavorite(sym.char))
    );

    if (where.event) menu.showAtMouseEvent(where.event);
    else menu.showAtPosition(where.pos);
  }

  async onSymbolClick(ev) {
    // A long-press just opened the menu; swallow the click that follows it
    if (this.longPressFired) {
      this.longPressFired = false;
      return;
    }

    const btn = ev.target.closest(".los-symbol");
    if (!btn) return;
    const sym = this.plugin.symbolByChar.get(btn.getAttribute("data-char"));
    if (!sym) return;

    btn.addClass("los-flash");
    window.setTimeout(() => btn.removeClass("los-flash"), 250);

    await this.plugin.insertSymbol(sym);
  }
}

/* ------------------------------------------------------------------ *
 *  Settings tab
 * ------------------------------------------------------------------ */

class SymbolsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();

    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshAll();
    };

    /* ----- Appearance ----- */
    new Setting(containerEl).setName("Appearance").setHeading();

    new Setting(containerEl)
      .setName("Symbol size")
      .setDesc("Font and button size of the symbols in the grid.")
      .addDropdown((dd) =>
        dd
          .addOption("small", "Small")
          .addOption("medium", "Medium")
          .addOption("large", "Large")
          .setValue(settings.symbolSize)
          .onChange(async (value) => {
            settings.symbolSize = value;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Show category tabs")
      .setDesc("Hide the tabs to get more room for the grid.")
      .addToggle((t) =>
        t.setValue(settings.showTabs).onChange(async (value) => {
          settings.showTabs = value;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Show recently used row")
      .addToggle((t) =>
        t.setValue(settings.showRecent).onChange(async (value) => {
          settings.showRecent = value;
          await save();
        })
      );

    new Setting(containerEl)
      .setName("Show symbol count")
      .setDesc('The "123 symbols" line above the grid.')
      .addToggle((t) =>
        t.setValue(settings.showCount).onChange(async (value) => {
          settings.showCount = value;
          await save();
        })
      );

    /* ----- Behaviour ----- */
    new Setting(containerEl).setName("Behaviour").setHeading();

    new Setting(containerEl)
      .setName("Insert as")
      .setDesc(
        "Insert (and copy) the character itself, or its HTML entity such as &rarr;."
      )
      .addDropdown((dd) =>
        dd
          .addOption("char", "Character (→)")
          .addOption("entity", "HTML entity (&rarr;)")
          .setValue(settings.insertMode)
          .onChange(async (value) => {
            settings.insertMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Add a trailing space")
      .setDesc("Add a space after the symbol when inserting and copying.")
      .addToggle((t) =>
        t.setValue(settings.trailingSpace).onChange(async (value) => {
          settings.trailingSpace = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Close panel after inserting")
      .setDesc("Close the panel automatically after each symbol is inserted.")
      .addToggle((t) =>
        t.setValue(settings.autoClose).onChange(async (value) => {
          settings.autoClose = value;
          await this.plugin.saveSettings();
        })
      );

    /* ----- Data ----- */
    new Setting(containerEl).setName("Data").setHeading();

    new Setting(containerEl)
      .setName("Recently used")
      .setDesc("Clear the recently used symbols.")
      .addButton((btn) =>
        btn.setButtonText("Clear").onClick(async () => {
          settings.recent = [];
          await this.plugin.saveSettings();
          this.plugin.refreshRecent();
        })
      );

    new Setting(containerEl)
      .setName("Favourites")
      .setDesc(
        "Right-click (or long-press on touch devices) a symbol to add or remove it."
      )
      .addButton((btn) =>
        btn.setButtonText("Clear all").onClick(async () => {
          settings.favorites = [];
          await this.plugin.saveSettings();
          this.plugin.refreshFavorites();
        })
      );
  }
}
