export const prototypeCss = `
.lp-root {--ink:#302f29;--dim:#626559;--line:#deded1;--leaf:#476346;--paper:#fffef8;display:flex;flex:1;min-height:0;min-width:0;flex-direction:column;background:#f4f2e9;color:var(--ink);font:15px/1.45 system-ui,sans-serif;color-scheme:light;container-type:inline-size}
.lp-root * {box-sizing:border-box}
.lp-root [hidden]{display:none!important}
.lp-root input,.lp-root button {font:inherit;color:inherit}
.lp-root button {background:none;border:0;cursor:pointer}
.lp-root :is(button,input):focus-visible {outline:2px solid #758865;outline-offset:1px}
.lp-scroll {flex:1;min-height:0;overflow:auto}
.lp-board {padding:24px 18px 14px;min-width:0}
.lp-board h1 {display:flex;align-items:center;gap:10px;margin:0 0 20px;font-size:26px;font-weight:600;letter-spacing:-.035em}
.lp-board h1 span {font:500 13px/1 system-ui;background:#e5e5d9;border-radius:6px;padding:5px 7px}
.lp-layout {min-width:0}.lp-detail .lp-layout {display:grid;grid-template-columns:minmax(0,1fr) clamp(200px,20cqw,270px);gap:12px;align-items:start}
.lp-rail {display:grid;grid-auto-flow:column;grid-auto-columns:minmax(min(255px,80cqw),1fr);align-items:start;gap:12px;overflow-x:auto;overscroll-behavior-x:contain;padding:1px 1px 14px;min-width:0}
.lp-detail .lp-rail {grid-auto-columns:minmax(min(214px,80cqw),1fr)}
.lp-card {background:var(--paper);border:1px solid var(--line);border-radius:10px;overflow:hidden;min-width:0}
.lp-cardhead {display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;width:100%;padding:13px 14px;text-align:left;align-items:center}
.lp-cardtitle {font-size:18px;font-weight:650;letter-spacing:-.025em}
.lp-cardhead .lp-progress {grid-column:1/-1}
.lp-fold {color:var(--dim);font-size:16px}
.lp-cardbody {border-top:1px solid var(--line)}
.lp-eyebrow,.lp-muted {font-size:13px;color:var(--dim)}
.lp-progress {display:flex;align-items:center;gap:10px;color:var(--dim);font-size:12px}
.lp-progress progress {width:68px;height:4px;border:0;border-radius:4px;overflow:hidden;appearance:none;background:var(--line)}
.lp-progress progress::-webkit-progress-bar {background:var(--line)}.lp-progress progress::-webkit-progress-value {background:var(--leaf)}
.lp-paper,.lp-index {padding:0 12px}
.lp-board h2 {font-size:14px;font-weight:650;margin:16px 0 10px}
.lp-paper>div:first-child .lp-row {border-top:0}
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
.lp-groups .lp-paper + .lp-paper {border-top:1px solid var(--line)}
.lp-phase {display:flex;width:100%;align-items:center;gap:7px;min-height:50px;padding:0;text-align:left}.lp-phase strong {flex:1}.lp-phase span {color:var(--dim);font-size:12px}.lp-phase b {font-size:17px;font-weight:400}
.lp-index {padding-block:6px}
.lp-indexrow {min-height:39px;padding:0 5px;border-radius:5px}.lp-indexrow button {flex:1;text-align:left;padding:5px 0}
.lp-indexrow[data-selected=true] {background:#e7eddf;color:#2e492e}
.lp-detailpane {background:#fafaf2;border:1px solid var(--line);border-radius:10px;padding:15px;min-width:0}
.lp-detailpane .lp-title {font:500 17px/1.3 Georgia,serif;margin:5px 0 18px}.lp-detailpane .lp-children {padding:3px 0 10px}
.lp-switch {align-self:center;display:flex;gap:2px;margin:8px auto 14px;padding:4px;background:#33392e;border-radius:20px;box-shadow:0 3px 12px #3333}
.lp-switch button {border-radius:16px;color:#f3f4ed;font-size:13px;padding:6px 12px;white-space:nowrap}
.lp-switch button[aria-pressed=true] {background:#f7f8ef;color:#293024}
@container (max-width:960px){.lp-detail .lp-layout{display:block}.lp-detailpane{margin-top:4px}.lp-detail .lp-rail{grid-auto-columns:minmax(min(255px,80cqw),1fr)}}
@container (max-width:550px){.lp-board{padding:18px 10px}.lp-rail{gap:8px}.lp-switch button{padding-inline:8px}.lp-root{font-size:14px}}
`;
