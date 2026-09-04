// app/keyboard.tsx — the deck's touch keyboard, hand-laid for the 320 px
// auxiliary panel the way Pocket Shell's is: 31 px columns, 26 px rows, hit
// by the deck's one gesture through `keyboardHit`. Four rows fit in 104 px,
// which leaves the strip below for the trackpad. Shift is one-shot (the
// resistive panel has one contact); "123" latches the symbol layer until
// "abc". Styled as the iOS 6 keyboard: white gradient keys, dark function
// keys, blue while pressed.

import { createSignal, Index } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { KbLayer, VaultStore } from "./store.ts";
import { KEY, KEY_DARK, KEY_HOT, KEY_TEXT, KEY_TEXT_DARK, KEY_TEXT_HOT, KEYBOARD_BG } from "./theme.ts";

export const KB_TOP = 62;
export const KEY_PITCH = 26;
export const KB_ROWS = 4;
export const KB_BOTTOM = KB_TOP + KB_ROWS * KEY_PITCH + 4; // 170
const KEY_H = KEY_PITCH - 3;
const UNIT = 31;
const PRESS_FRAMES = 6;

export type KeyAction =
  | { ch: string }
  | { key: "enter" | "backspace" | "space" }
  | { layer: KbLayer };

interface KeyDef {
  label: string;
  /** Width in UNIT columns. */
  w: number;
  act: KeyAction;
  dark?: boolean;
}

const chars = (row: string): KeyDef[] => [...row].map((ch) => ({ label: ch, w: 1, act: { ch } }));

const ROWS: Record<KbLayer, KeyDef[][]> = {
  lower: [
    chars("qwertyuiop"),
    chars("asdfghjkl"),
    [
      { label: "shift", w: 1.5, act: { layer: "upper" }, dark: true },
      ...chars("zxcvbnm"),
      { label: "del", w: 1.5, act: { key: "backspace" }, dark: true },
    ],
    [
      { label: "123", w: 1.5, act: { layer: "sym" }, dark: true },
      { label: ",", w: 1, act: { ch: "," } },
      { label: "space", w: 4, act: { key: "space" } },
      { label: ".", w: 1, act: { ch: "." } },
      { label: "return", w: 2.5, act: { key: "enter" }, dark: true },
    ],
  ],
  upper: [
    chars("QWERTYUIOP"),
    chars("ASDFGHJKL"),
    [
      { label: "shift", w: 1.5, act: { layer: "lower" }, dark: true },
      ...chars("ZXCVBNM"),
      { label: "del", w: 1.5, act: { key: "backspace" }, dark: true },
    ],
    [
      { label: "123", w: 1.5, act: { layer: "sym" }, dark: true },
      { label: "!", w: 1, act: { ch: "!" } },
      { label: "space", w: 4, act: { key: "space" } },
      { label: "?", w: 1, act: { ch: "?" } },
      { label: "return", w: 2.5, act: { key: "enter" }, dark: true },
    ],
  ],
  sym: [
    chars("1234567890"),
    chars("-/:;()&@\""),
    [
      { label: "#", w: 1.5, act: { ch: "#" }, dark: true },
      ...chars(".,?!'*="),
      { label: "del", w: 1.5, act: { key: "backspace" }, dark: true },
    ],
    [
      { label: "abc", w: 1.5, act: { layer: "lower" }, dark: true },
      { label: "[", w: 1, act: { ch: "[" } },
      { label: "space", w: 4, act: { key: "space" } },
      { label: "]", w: 1, act: { ch: "]" } },
      { label: "return", w: 2.5, act: { key: "enter" }, dark: true },
    ],
  ],
};

/** Left offset that centres a row's total width on the 320 px panel. */
function rowStart(row: KeyDef[]): number {
  const total = row.reduce((sum, k) => sum + k.w, 0) * UNIT;
  return Math.round((320 - total) / 2);
}

export interface KeyHit {
  act: KeyAction;
  row: number;
  index: number;
}

export function keyboardHit(x: number, y: number, layer: KbLayer): KeyHit | null {
  const row = Math.floor((y - KB_TOP - 2) / KEY_PITCH);
  if (row < 0 || row >= KB_ROWS) return null;
  const keys = ROWS[layer][row]!;
  let left = rowStart(keys);
  for (let index = 0; index < keys.length; index++) {
    const w = keys[index]!.w * UNIT;
    if (x >= left && x < left + w) return { act: keys[index]!.act, row, index };
    left += w;
  }
  return null;
}

export function Keyboard(props: { store: VaultStore; pressed: () => KeyHit | null }) {
  const store = props.store;
  const rows = () => ROWS[store.kbLayer()];
  return (
    <View debugName="Keyboard" class={KEYBOARD_BG} style={{ insetT: KB_TOP, height: KB_BOTTOM - KB_TOP }}>
      <Index each={rows()}>
        {(row, r) => (
          <Index each={row()}>
            {(key, i) => {
              const left = () => rowStart(row()) + row().slice(0, i).reduce((sum, k) => sum + k.w, 0) * UNIT;
              const hot = () => {
                const p = props.pressed();
                return p !== null && p.row === r && p.index === i;
              };
              return (
                <View
                  class={hot() ? KEY_HOT : key().dark ? KEY_DARK : KEY}
                  style={{
                    insetL: left() + 2,
                    insetT: 2 + r * KEY_PITCH,
                    width: key().w * UNIT - 4,
                    height: KEY_H,
                  }}
                >
                  <Text class={hot() ? KEY_TEXT_HOT : key().dark ? KEY_TEXT_DARK : KEY_TEXT}>{key().label}</Text>
                </View>
              );
            }}
          </Index>
        )}
      </Index>
    </View>
  );
}

/** Pressed-key highlight that lasts PRESS_FRAMES frames. */
export function createKeyPress(): { pressed: () => KeyHit | null; press: (hit: KeyHit) => void } {
  const [pressed, setPressed] = createSignal<KeyHit | null>(null);
  let left = 0;
  onFrame(() => {
    if (left > 0 && --left === 0) setPressed(null);
  });
  return {
    pressed,
    press: (hit) => {
      setPressed(hit);
      left = PRESS_FRAMES;
    },
  };
}
