export const prototypeCss = `
.lp-root {--ink:#302f29;--dim:#626559;--line:#deded1;--leaf:#476346;--paper:#fffef8;display:flex;flex:1;min-height:0;min-width:0;flex-direction:column;background:#f4f2e9;color:var(--ink);font:15px/1.45 system-ui,sans-serif;color-scheme:light;container-type:inline-size}
.lp-root * {box-sizing:border-box}
.lp-root [hidden]{display:none!important}
.lp-root input,.lp-root button {font:inherit;color:inherit}
.lp-root button {background:none;border:0;cursor:pointer}
.lp-root :is(button,input):focus-visible {outline:2px solid #758865;outline-offset:1px}
.lp-scroll {flex:1;min-height:0;overflow:auto}
.lp-sheet {max-width:840px;margin:0 auto;padding:clamp(20px,4cqw,48px) clamp(16px,4cqw,48px) 25px}
.lp-simple {max-width:740px}.lp-detail {max-width:1020px}
.lp-head {margin-bottom:24px}
.lp-eyebrow,.lp-muted {font-size:13px;color:var(--dim)}
.lp-head h1 {font:500 clamp(26px,4cqw,40px)/1.15 Georgia,serif;letter-spacing:-.035em;margin:7px 0 12px}
.lp-progress {display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px}
.lp-progress progress {width:68px;height:4px;border:0;border-radius:4px;overflow:hidden;appearance:none;background:var(--line)}
.lp-progress progress::-webkit-progress-bar {background:var(--line)}.lp-progress progress::-webkit-progress-value {background:var(--leaf)}
.lp-paper,.lp-split {background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.lp-paper {padding:0 18px}
.lp-sheet h2 {font-size:14px;font-weight:650;margin:16px 0 10px}
.lp-row,.lp-indexrow,.lp-add,.lp-children label {display:flex;align-items:center;gap:11px}
.lp-row {min-height:43px;border-top:1px solid #eae9df}
.lp-check {margin:0;width:17px;height:17px;accent-color:var(--leaf);cursor:pointer;flex:none}
.lp-title,.lp-add input {width:100%;min-width:0;background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 1px}
.lp-title:hover,.lp-title:focus {border-color:var(--line)}
.lp-row[data-done=true] .lp-title,.lp-indexrow[data-done=true] button,.lp-children label:has(:checked) span {text-decoration:line-through;color:var(--dim)}
.lp-root .lp-disclose {display:flex;align-items:center;gap:6px;padding:2px 7px;background:#eeefe5;color:var(--dim);border-radius:5px;font-size:12px}
.lp-children {padding:2px 0 10px 28px;display:grid;gap:8px}
.lp-children label {font-size:14px;cursor:pointer}
.lp-add {border-top:1px dashed var(--line);min-height:44px;color:var(--leaf);gap:6px}
.lp-add button {padding:0;width:20px;font-size:20px}.lp-add input::placeholder {color:var(--dim)}
.lp-groups {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.lp-phase {display:flex;width:100%;align-items:center;gap:7px;min-height:50px;padding:0;text-align:left}.lp-phase strong {flex:1}.lp-phase span {color:var(--dim);font-size:12px}.lp-phase b {font-size:17px;font-weight:400}
.lp-split {display:grid;grid-template-columns:minmax(0, 1fr) minmax(0, 1fr)}
.lp-index,.lp-detailpane {padding:6px 18px 12px;min-width:0}
.lp-index {border-right:1px solid var(--line)}.lp-indexrow {min-height:39px;padding:0 5px;border-radius:5px}.lp-indexrow button {flex:1;text-align:left;padding:5px 0}
.lp-indexrow[data-selected=true] {background:#e7eddf;color:#2e492e}
.lp-detailpane {background:#fafaf2;padding-top:21px}
.lp-detailpane .lp-title {font:500 clamp(16px,2.5cqw,24px)/1.3 Georgia,serif;margin:5px 0 18px}.lp-detailpane .lp-children {padding:3px 0 10px}
.lp-switch {align-self:center;display:flex;gap:2px;margin:8px auto 14px;padding:4px;background:#33392e;border-radius:20px;box-shadow:0 3px 12px #3333}
.lp-switch button {border-radius:16px;color:#f3f4ed;font-size:13px;padding:6px 12px;white-space:nowrap}
.lp-switch button[aria-pressed=true] {background:#f7f8ef;color:#293024}
@container (max-width:660px){.lp-groups {grid-template-columns:1fr}.lp-paper{padding:0 12px}.lp-index,.lp-detailpane{padding-inline:10px}}
@container (max-width:440px){.lp-sheet{padding-inline:10px}.lp-switch button{padding-inline:8px}.lp-root{font-size:14px}}
`;
