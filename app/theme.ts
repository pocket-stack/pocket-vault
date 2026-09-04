// app/theme.ts — the design system: every colour, gradient and control shape
// the two screens share, plus the geometry they are laid out on. The register
// is classic Aqua / iOS 6, which the console's LCDs show well: light
// surfaces, blue-gray toolbars, glossy blue for a selection, white cells with
// gray rules.
//
// Tokens are whole class-string literals because the compiler collects class
// strings from source at build time; a string assembled at runtime styles
// nothing. Geometry lives beside the tokens so a control's box and its paint
// stay in one file.

// ── Palette (documentation; the literals below repeat these values) ────────
//   paper       #ffffff   ink       #1c1c1e   ink-2     #5b616b
//   dim         #a2a8b2   rule      #c9ced4   panel     #e6e8ec
//   chrome-hi   #b2becf → #8d9cb4   chrome-lo #7d8ea8 → #66778f
//   blue        #5b9bf3 → #2b6fd6   link      #1b4fa8   wiki  #2a63c8
//   callout     #eaf1fb / border #b8cbe8      code-bg   #f2f3f6
//   caret       #1e60d8   selection #b3d7ff    tag       #7a5ea8

// ── Geometry: the top screen ───────────────────────────────────────────────
export const NAV_H = 30;
/** Shoulder pills in the navigation bar. Both are plain rounded pills — the
 *  left one is NOT drawn as an arrow; it names the vault, it does not go
 *  back one step. */
export const PILL_W = 22;
export const PILL_H = 20;
export const NAV_BTN_H = 22;
export const NAV_LEFT_W = 96;
export const NAV_RIGHT_W = 104;

// ── Geometry: the bottom screen ────────────────────────────────────────────
export const TABS_Y = 4;
export const TABS_H = 22;
export const TABS_X = 6;
export const TABS_W = 264;
export const SEARCH_X = 276;
export const SEARCH_W = 38;

export const PANE_Y = 30;
export const PANE_H = 180;
export const TREE_X = 4;
export const TREE_W = 132;
export const TREE_HEADER_H = 16;
export const TREE_FOOTER_H = 16;
export const TREE_ROW_H = 18;
export const LIST_X = 140;
export const LIST_W = 158;
export const LIST_ROW_H = 30;
export const STRIP_X = 302;
export const STRIP_W = 14;

export const TOOLBAR_Y = 214;
export const TOOLBAR_H = 22;

/** The held-shoulder menu: a panel under the top screen's corner, mirrored
 *  as touch rows on the bottom screen. */
export const MENU_W = 152;
export const MENU_ROW_H = 18;
export const MENU_TOP = NAV_H + 2;
export const DECK_MENU_TOP = 34;
export const DECK_MENU_ROW_H = 26;

// ── Surfaces ───────────────────────────────────────────────────────────────
export const SCREEN = "relative w-full h-full bg-[#e6e8ec] overflow-hidden";
export const PAPER = "relative w-full h-full bg-white overflow-hidden";

/** The navigation bar: two gradient halves, a light top rule, a dark bottom
 *  one. */
export const NAV = "absolute left-0 right-0 top-0 h-[30] bg-[#6d7e99]";
export const NAV_HI = "absolute left-0 right-0 top-0 h-[15] bg-gradient-to-b from-[#b2becf] to-[#8d9cb4]";
export const NAV_LO = "absolute left-0 right-0 top-[15] h-[15] bg-gradient-to-b from-[#7d8ea8] to-[#66778f]";
export const NAV_RULE_TOP = "absolute left-0 right-0 top-0 h-[1] bg-[#ccd4df]";
export const NAV_RULE_BOTTOM = "absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]";
export const NAV_TITLE_SHADOW = "absolute top-[6] text-base text-[#3c4d6480] font-bold";
export const NAV_TITLE = "absolute top-[7] text-base text-white font-bold";
/** Any box whose content must not spill past it. Text does not clip itself. */
export const CLIP = "absolute overflow-hidden";

/** A navigation-bar button: a bevelled rounded rect. */
export const NAV_BUTTON = "absolute top-[4] h-[22] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]";
export const NAV_BUTTON_ON = "absolute top-[4] h-[22] rounded-[4] border border-[#25507f] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const NAV_BUTTON_GLOSS = "absolute left-[2] right-[2] top-[1] h-[1] bg-[#c8d1de80]";
export const NAV_BUTTON_LABEL_SHADOW = "absolute top-[3] text-center text-xs text-[#39495f80] font-bold";
export const NAV_BUTTON_LABEL = "absolute top-[4] text-center text-xs text-white font-bold";
/** The shoulder pill inside a navigation button: L and R, never an arrow. */
export const PILL = "absolute top-[1] w-[22] h-[20] rounded-[3] border border-[#5a6a84] bg-gradient-to-b from-[#f2f5f9] to-[#ccd6e4]";
export const PILL_TEXT = "absolute left-0 right-0 top-[3] text-center text-xs text-[#2f3d52] font-bold";

/** Link indicator dots in the navigation bar. */
export const DOT_LINKED = "absolute w-[7] h-[7] rounded-full bg-[#7be08a] border border-[#2f7a3a]";
export const DOT_SEARCHING = "absolute w-[7] h-[7] rounded-full bg-[#f5c04b] border border-[#8a6a12]";
export const DOT_ABSENT = "absolute w-[7] h-[7] rounded-full bg-[#e46a6a] border border-[#8a2b2b]";

/** The page readout floating over the paper's bottom-right corner. */
export const PAGE_BADGE = "absolute right-[3] bottom-[2] h-[13] rounded-[3] bg-[#ffffffdd] border border-[#d5d8de]";
export const PAGE_TEXT = "absolute left-0 right-0 top-0 text-center text-xs text-[#5b616b]";

// ── Segmented control ──────────────────────────────────────────────────────
export const SEG = "absolute h-[22] rounded-[5] border border-[#7c7c82] bg-gradient-to-b from-[#fbfbfb] to-[#dedede] overflow-hidden";
export const SEG_ITEM = "absolute top-0 h-[20] items-center justify-center";
/** Corner radii are per node, so a selected end segment is a rounded block
 *  plus a square patch on its inner side; that keeps the outer corner inside
 *  the track's own radius instead of overflowing it. */
export const SEG_ITEM_ON = "absolute top-0 h-[20] items-center justify-center bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const SEG_ITEM_ON_END = "absolute top-0 h-[20] items-center justify-center rounded-[4] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const SEG_ITEM_ON_PATCH = "absolute top-0 h-[20] w-[6] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const SEG_TEXT = "text-xs text-[#3c3c3c] font-bold";
export const SEG_TEXT_ON = "text-xs text-white font-bold";
export const SEG_DIVIDER = "absolute top-0 w-[1] h-[20] bg-[#a9a9ae]";

// ── Panes, cells, fields ───────────────────────────────────────────────────
export const PANE = "absolute rounded-[4] border border-[#a8abb2] bg-white overflow-hidden";
export const PANE_HEADER = "absolute left-0 right-0 top-0 h-[16] bg-gradient-to-b from-[#eef0f3] to-[#dfe2e7]";
export const PANE_HEADER_TEXT = "absolute left-[6] top-[1] text-xs text-[#5b616b] font-bold";
export const PANE_FOOTER = "absolute left-0 right-0 bottom-0 h-[16] bg-gradient-to-b from-[#eef0f3] to-[#dfe2e7]";
export const PANE_FOOTER_TEXT = "absolute left-[6] top-[1] text-xs text-[#5b616b]";
export const PANE_RULE = "absolute left-0 right-0 h-[1] bg-[#c9ced4]";

export const CELL = "absolute left-0 right-0 top-0 bg-white";
export const CELL_ON = "absolute left-0 right-0 top-0 bg-gradient-to-b from-[#4c9bf5] to-[#0a63dd]";
export const CELL_RULE = "absolute left-0 right-0 bottom-0 h-[1] bg-[#e2e5ea]";
export const CELL_RULE_ON = "absolute left-0 right-0 bottom-0 h-[1] bg-[#0a55c4]";
export const CELL_TITLE = "absolute top-[2] text-xs text-[#1c1c1e] font-bold";
export const CELL_TITLE_ON = "absolute top-[2] text-xs text-white font-bold";
export const CELL_SUB = "absolute top-[15] text-xs text-[#8a8f98]";
export const CELL_SUB_ON = "absolute top-[15] text-xs text-[#d6e4ff]";
export const CELL_META = "absolute top-[2] text-xs text-[#8a8f98]";
export const CELL_META_ON = "absolute top-[2] text-xs text-[#d6e4ff]";

/** Tree rows: a folder with a disclosure triangle and a count, or a note. */
export const TREE_TEXT = "absolute top-[2] text-xs text-[#1c1c1e]";
export const TREE_TEXT_ON = "absolute top-[2] text-xs text-white font-bold";
export const TREE_COUNT = "absolute right-[5] top-[2] text-xs text-[#8a8f98]";
export const TREE_COUNT_ON = "absolute right-[5] top-[2] text-xs text-[#d6e4ff]";
export const TREE_TRI_CLOSED = "absolute w-[5] h-[7] bg-[#7d838d]";
export const TREE_TRI_OPEN = "absolute w-[7] h-[5] bg-[#5b616b]";
export const ICON_NOTE = "absolute w-[8] h-[10] rounded-[1] bg-white border border-[#9aa1ad]";
export const ICON_NOTE_ON = "absolute w-[8] h-[10] rounded-[1] bg-[#e8f1ff] border border-[#cfe0f7]";
export const ICON_NOTE_LINE = "absolute left-[1] right-[1] h-[1] bg-[#c3c9d2]";
export const ICON_FOLDER = "absolute w-[11] h-[9] rounded-[1] bg-gradient-to-b from-[#8fb8e8] to-[#5f8fc8]";
export const ICON_FOLDER_TAB = "absolute w-[5] h-[2] rounded-[1] bg-[#8fb8e8]";

export const FIELD = "absolute h-[22] rounded-[11] bg-white border border-[#9aa0a8]";
export const FIELD_TEXT = "absolute left-[10] top-[3] text-xs text-[#1c1c1e]";
export const FIELD_PLACEHOLDER = "absolute left-[10] top-[3] text-xs text-[#8b9199]";

// ── Toolbar ────────────────────────────────────────────────────────────────
export const TOOLBAR = "absolute left-0 right-0 bottom-0 h-[26] bg-gradient-to-b from-[#c9ced6] to-[#b3b9c3]";
export const TOOLBAR_RULE = "absolute left-0 right-0 top-0 h-[1] bg-[#8f959f]";
export const TOOL_BUTTON = "absolute h-[20] rounded-[4] border border-[#7f858f] bg-gradient-to-b from-[#fbfcfd] to-[#dfe3e9]";
export const TOOL_BUTTON_ON = "absolute h-[20] rounded-[4] border border-[#25507f] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const TOOL_TEXT = "absolute left-0 right-0 top-[3] text-center text-xs text-[#1c1c1e] font-bold";
export const TOOL_TEXT_ON = "absolute left-0 right-0 top-[3] text-center text-xs text-white font-bold";

// ── Held-shoulder menu ─────────────────────────────────────────────────────
export const MENU = "absolute rounded-[5] border border-[#5a6a84] bg-gradient-to-b from-[#f6f8fa] to-[#dde2ea]";
export const MENU_ROW = "absolute left-[1] right-[1] h-[18]";
export const MENU_ROW_ON = "absolute left-[1] right-[1] h-[18] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const MENU_TEXT = "absolute left-[8] top-[2] text-xs text-[#1c1c1e]";
export const MENU_TEXT_ON = "absolute left-[8] top-[2] text-xs text-white font-bold";
export const MENU_HINT = "absolute right-[6] top-[2] text-xs text-[#8a8f98]";
export const MENU_HINT_ON = "absolute right-[6] top-[2] text-xs text-[#d6e4ff]";
export const MENU_DIM = "absolute left-0 right-0 top-0 bottom-0 bg-[#0b1a2e66]";
export const DECK_MENU_ROW = "absolute left-[10] right-[10] h-[26] rounded-[4] border border-[#7f858f] bg-gradient-to-b from-[#fbfcfd] to-[#e2e6ec]";
export const DECK_MENU_ROW_ON = "absolute left-[10] right-[10] h-[26] rounded-[4] border border-[#25507f] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const DECK_MENU_TEXT = "absolute left-[12] top-[5] text-sm text-[#1c1c1e]";
export const DECK_MENU_TEXT_ON = "absolute left-[12] top-[5] text-sm text-white font-bold";
export const DECK_MENU_TITLE = "absolute left-0 right-0 top-[10] text-center text-xs text-[#5b616b] font-bold";

// ── The document (top screen) ──────────────────────────────────────────────
export const DOC_ROW = "absolute left-0 right-0";
export const DOC_ROW_CARET = "absolute left-0 right-0 bg-[#f4f7fd]";
/** A boxed block: code, and a quote read as a callout. */
export const BOX_CODE = "absolute left-[6] right-[6] bg-[#f2f3f6]";
export const BOX_CODE_EDGE = "absolute left-[6] right-[6] h-[1] bg-[#dfe1e6]";
export const BOX_CALLOUT = "absolute left-[6] right-[6] bg-[#eaf1fb]";
export const BOX_CALLOUT_EDGE = "absolute left-[6] right-[6] h-[1] bg-[#b8cbe8]";
export const BOX_CALLOUT_BAR = "absolute left-[6] w-[1] top-0 bottom-0 bg-[#b8cbe8]";
export const BOX_CALLOUT_BAR_R = "absolute right-[6] w-[1] top-0 bottom-0 bg-[#b8cbe8]";
export const DOC_HR = "absolute left-[12] right-[12] top-[5] h-[1] bg-[#c9ced4]";
export const DOC_CARET = "absolute w-[2] bg-[#1e60d8]";
export const DOC_SELECTION = "absolute top-0 bottom-0 bg-[#b3d7ff]";
export const CHECKBOX = "absolute w-[12] h-[12] rounded-[2] bg-white border border-[#8a93a3]";
export const CHECKBOX_ON = "absolute w-[12] h-[12] rounded-[2] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6] border border-[#25507f]";
export const CHECKBOX_TICK_A = "absolute w-[2] h-[5] bg-white";
export const CHECKBOX_TICK_B = "absolute w-[2] h-[8] bg-white";

export const SPLASH_TITLE = "text-2xl text-[#1c1c1e] font-bold";
export const SPLASH_SUB = "text-sm text-[#5b616b] mt-[6]";
export const SPLASH_HINT = "text-xs text-[#8a8f98] mt-[16]";

// ── Keyboard (the edit deck) ───────────────────────────────────────────────
export const KEY = "absolute items-center justify-center rounded-[4] border border-[#8e8f94] bg-gradient-to-b from-[#fdfdfd] to-[#e9e9ec]";
export const KEY_DARK = "absolute items-center justify-center rounded-[4] border border-[#6f7681] bg-gradient-to-b from-[#a9b0bb] to-[#8b93a1]";
export const KEY_HOT = "absolute items-center justify-center rounded-[4] border border-[#1f57b0] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const KEY_TEXT = "text-sm text-[#1c1c1e]";
export const KEY_TEXT_DARK = "text-xs text-white font-bold";
export const KEY_TEXT_HOT = "text-sm text-white font-bold";
export const KEYBOARD_BG = "absolute left-0 right-0 bg-gradient-to-b from-[#d3d6dc] to-[#c4c8cf]";

/** An inset brushed panel — the caret pad, the scrub strip's well. */
export const WELL = "absolute rounded-[5] border border-[#a8abb2] bg-gradient-to-b from-[#e8e9ec] to-[#d5d7dc]";
export const WELL_HINT = "absolute left-0 right-0 text-center text-xs text-[#8a8f98]";
export const STRIP = "absolute rounded-[3] border border-[#a8abb2] bg-[#eceef1] overflow-hidden";
export const STRIP_BAR = "absolute h-[2] bg-[#aab1bc]";
export const STRIP_THUMB = "absolute left-0 right-0 rounded-[2] border border-[#2b6fd6] bg-[#5b9bf340]";

/** Run styles for the document, one whole literal per (kind, style). */
export const DIM = "text-[#a2a8b2]";
