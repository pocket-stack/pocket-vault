// app/theme.ts — the design system: every colour, gradient and control
// shape the two screens share, in the classic Aqua / iOS 6 register the 3DS's
// LCDs show well — light surfaces, blue-gray toolbars, glossy blue for the
// selected state, white cells with gray rules. Tokens are whole class-string
// literals because the compiler collects class strings from source at build
// time; a string assembled at runtime styles nothing. Geometry that both
// screens measure against lives beside the tokens.

// ── Palette (documentation; the literals below repeat these values) ────────
//   paper        #ffffff   ink        #1c1c1e   ink-2      #5b616b
//   rule         #c9ced4   panel      #e6e8ec   panel-deep #d5d8de
//   nav-hi       #b2becf → #8d9cb4     nav-lo    #7d8ea8 → #66778f
//   blue         #5b9bf3 → #2b6fd6     link       #1b4fa8
//   highlight    #fff5c2   caret      #1e60d8   selection  #b3d7ff
//   code-bg      #f1f2f5   code-ink   #8a2b2b   quote-bar  #b5bcc6

// ── Geometry ───────────────────────────────────────────────────────────────
export const NAV_H = 32;
export const SEG_Y = 36;
export const SEG_H = 22;
export const CONTENT_Y = 62;

// ── Surfaces ───────────────────────────────────────────────────────────────
export const SCREEN = "relative w-full h-full bg-[#e6e8ec] overflow-hidden";
export const PAPER = "relative w-full h-full bg-white overflow-hidden";

/** The iOS 6 navigation bar: two gradient halves, a light top rule and a
 *  dark bottom one. */
export const NAV = "absolute left-0 right-0 top-0 h-[32] bg-[#6d7e99]";
export const NAV_HI = "absolute left-0 right-0 top-0 h-[16] bg-gradient-to-b from-[#b2becf] to-[#8d9cb4]";
export const NAV_LO = "absolute left-0 right-0 top-[16] h-[16] bg-gradient-to-b from-[#7d8ea8] to-[#66778f]";
export const NAV_RULE_TOP = "absolute left-0 right-0 top-0 h-[1] bg-[#ccd4df]";
export const NAV_RULE_BOTTOM = "absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]";
export const NAV_TITLE_SHADOW = "absolute left-[60] right-[60] top-[6] text-center text-base text-[#3c4d6480] font-bold";
export const NAV_TITLE = "absolute left-[60] right-[60] top-[7] text-center text-base text-white font-bold";
/** A bordered nav-bar button (the "Groups" / "Edit" bevel). */
export const NAV_BUTTON = "absolute top-[5] h-[22] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]";
export const NAV_BUTTON_GLOSS = "absolute left-[2] right-[2] top-[1] h-[1] bg-[#c8d1de80]";
export const NAV_BUTTON_TEXT_SHADOW = "absolute left-0 right-0 top-[2] text-center text-xs text-[#39495f80] font-bold";
export const NAV_BUTTON_TEXT = "absolute left-0 right-0 top-[3] text-center text-xs text-white font-bold";

/** Link indicator dots in the nav bar. */
export const DOT_LINKED = "absolute w-[8] h-[8] rounded-full bg-[#7be08a] border border-[#2f7a3a]";
export const DOT_SEARCHING = "absolute w-[8] h-[8] rounded-full bg-[#f5c04b] border border-[#8a6a12]";
export const DOT_ABSENT = "absolute w-[8] h-[8] rounded-full bg-[#e46a6a] border border-[#8a2b2b]";

// ── Segmented control (the mode tabs) ──────────────────────────────────────
export const SEG = "absolute h-[22] rounded-[5] border border-[#7c7c82] bg-gradient-to-b from-[#fbfbfb] to-[#dedede] overflow-hidden";
export const SEG_ITEM = "absolute top-0 h-[20] items-center justify-center";
export const SEG_ITEM_ON = "absolute top-0 h-[20] items-center justify-center bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const SEG_TEXT = "text-xs text-[#3c3c3c] font-bold";
export const SEG_TEXT_ON = "text-xs text-white font-bold";
export const SEG_DIVIDER = "absolute top-0 w-[1] h-[20] bg-[#a9a9ae]";

// ── Fields, lists, panels ──────────────────────────────────────────────────
export const FIELD = "absolute h-[24] rounded-[12] bg-white border border-[#9aa0a8]";
export const FIELD_TEXT = "absolute left-[12] top-[4] text-sm text-[#1c1c1e]";
export const FIELD_PLACEHOLDER = "absolute left-[12] top-[4] text-sm text-[#8b9199]";

export const CELL = "absolute left-0 right-0 top-0 bg-white";
export const CELL_ON = "absolute left-0 right-0 top-0 bg-gradient-to-b from-[#4c9bf5] to-[#0a63dd]";
export const CELL_RULE = "absolute left-0 right-0 bottom-0 h-[1] bg-[#c9ced4]";
export const CELL_RULE_ON = "absolute left-0 right-0 bottom-0 h-[1] bg-[#0a55c4]";
export const CELL_TEXT = "absolute left-[10] top-[6] text-sm text-[#1c1c1e]";
export const CELL_TEXT_ON = "absolute left-[10] top-[6] text-sm text-white";
export const CELL_META = "absolute right-[10] top-[8] text-xs text-[#5b616b]";
export const CELL_META_ON = "absolute right-[10] top-[8] text-xs text-[#d6e4ff]";
export const CELL_TEXT_BOLD = "absolute top-[4] text-sm text-[#1c1c1e] font-bold";
export const CELL_TEXT_SMALL = "absolute top-[5] text-xs text-[#1c1c1e]";
export const CELL_TEXT_DIM = "absolute top-[5] text-xs text-[#5b616b]";

/** An inset brushed panel — the trackpad, the minimap well. */
export const WELL = "absolute rounded-[6] border border-[#a8abb2] bg-gradient-to-b from-[#e8e9ec] to-[#d5d7dc]";
export const WELL_HINT = "absolute left-0 right-0 text-center text-xs text-[#8a8f98]";
export const MINIMAP_BAR = "absolute h-[2] bg-[#9aa1ad]";
export const MINIMAP_VIEW = "absolute rounded-[2] border border-[#2b6fd6] bg-[#5b9bf340]";

// ── Buttons ────────────────────────────────────────────────────────────────
export const BUTTON = "absolute items-center justify-center rounded-[5] border border-[#8e8f94] bg-gradient-to-b from-[#fdfdfd] to-[#e2e2e6]";
export const BUTTON_ON = "absolute items-center justify-center rounded-[5] border border-[#1f57b0] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const BUTTON_TEXT = "text-xs text-[#1c1c1e] font-bold";
export const BUTTON_TEXT_ON = "text-xs text-white font-bold";

// ── Keyboard ───────────────────────────────────────────────────────────────
export const KEY = "absolute items-center justify-center rounded-[4] border border-[#8e8f94] bg-gradient-to-b from-[#fdfdfd] to-[#e9e9ec]";
export const KEY_DARK = "absolute items-center justify-center rounded-[4] border border-[#6f7681] bg-gradient-to-b from-[#a9b0bb] to-[#8b93a1]";
export const KEY_HOT = "absolute items-center justify-center rounded-[4] border border-[#1f57b0] bg-gradient-to-b from-[#5b9bf3] to-[#2b6fd6]";
export const KEY_TEXT = "text-sm text-[#1c1c1e]";
export const KEY_TEXT_DARK = "text-xs text-white font-bold";
export const KEY_TEXT_HOT = "text-sm text-white font-bold";
export const KEYBOARD_BG = "absolute left-0 right-0 bg-gradient-to-b from-[#d3d6dc] to-[#c4c8cf]";

// ── Sheet (the status & settings card) ─────────────────────────────────────
export const SHEET_DIM = "absolute left-0 right-0 top-0 bottom-0 bg-[#00000066]";
export const SHEET = "absolute rounded-[8] border border-[#5a6a84] bg-gradient-to-b from-[#f4f6f9] to-[#dfe3ea]";
export const SHEET_TITLE = "absolute left-0 right-0 top-[8] text-center text-base text-[#1c1c1e] font-bold";
export const SHEET_LABEL = "absolute text-xs text-[#5b616b] font-bold";
export const SHEET_VALUE = "absolute text-xs text-[#1c1c1e]";
export const SHEET_RULE = "absolute left-[12] right-[12] h-[1] bg-[#c9ced4]";

// ── Document (the top screen) ──────────────────────────────────────────────
export const DOC_ROW = "absolute left-0 right-0";
export const DOC_ROW_ACTIVE = "absolute left-0 right-0 bg-[#fff5c2]";
export const DOC_ROW_CODE = "absolute left-[6] right-[6] bg-[#f1f2f5]";
export const DOC_HR = "absolute left-[12] right-[12] top-[6] h-[1] bg-[#c9ced4]";
export const DOC_QUOTE_BAR = "absolute left-[12] top-[2] w-[3] h-[14] rounded-[1] bg-[#b5bcc6]";
export const DOC_CARET = "absolute top-[1] w-[2] h-[16] bg-[#1e60d8]";
export const DOC_SELECTION = "absolute top-0 bottom-0 bg-[#b3d7ff]";
export const DOC_SCROLLBAR = "absolute right-[2] w-[3] rounded-[1] bg-[#5b616b80]";

export const SPLASH_TITLE = "text-2xl text-[#1c1c1e] font-bold";
export const SPLASH_SUB = "text-sm text-[#5b616b] mt-[6]";
export const SPLASH_HINT = "text-xs text-[#8a8f98] mt-[18]";
