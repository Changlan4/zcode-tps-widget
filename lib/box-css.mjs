// 速度方框页面的样式与骨架（与 box.js 配套）。
// 框架刻意与「会话用量方框」(zcode-whale-widget/lib/box-css.mjs) 保持同一套视觉语言：
// 同样的底色/圆角/边框/阴影、同样的 head + 分隔线、同样的色板（绿=速度、蓝=延迟、
// 琥珀=采样）。这样两个方框紧挨在一起时看起来是一家人。
// 单独放在 .css 里而不是内联，是为了让 box.js 保持纯逻辑、样式可单独调。
export function boxCss() {
  return `
#box {
  position: fixed;
  box-sizing: border-box;
  padding: 10px 12px 8px;
  border-radius: 10px;
  background: rgba(22, 24, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.42);
  color: #e8e8ea;
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  cursor: default;
}

#box .head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 7px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}
#box .dot {
  flex: 0 0 auto;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #6cc4a8;
  box-shadow: 0 0 6px rgba(108, 196, 168, 0.7);
}
#box .dot.warn { background: #e0af68; box-shadow: 0 0 6px rgba(224, 175, 104, 0.7); }
#box .dot.bad { background: #f07178; box-shadow: 0 0 6px rgba(240, 113, 120, 0.7); }
#box .title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1em;
  font-weight: 600;
  color: #f2f2f4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#box .chip {
  flex: 0 0 auto;
  max-width: 45%;
  padding: 1px 6px;
  border-radius: 7px;
  background: rgba(122, 162, 247, 0.12);
  border: 1px solid rgba(122, 162, 247, 0.24);
  color: #a9bcfa;
  font-size: 0.78em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

#box .speed {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 2px 0 8px;
}
#box .speed .num {
  font-size: 1.9em;
  font-weight: 700;
  line-height: 1;
  color: #6cc4a8;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
#box .speed .num.idle { color: #7d7d87; }
#box .speed .unit { font-size: 0.86em; color: #9a9aa4; }

#box .row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
}
#box .swatch {
  flex: 0 0 auto;
  width: 3px; height: 12px;
  border-radius: 2px;
  opacity: 0.9;
}
#box .row .label {
  flex: 1 1 auto;
  min-width: 0;
  color: #9a9aa4;
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#box .row .val {
  flex: 0 0 auto;
  color: #e8e8ea;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  text-align: right;
}

#box .foot {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
  color: #7d7d87;
  font-size: 0.85em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`
}
