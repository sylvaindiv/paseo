export const priorityCss = `
.priorityDemo{--ink:#22382f;--accent:#335f4b;--line:#d8ded4;--paper:#fffefa;--ground:#f1f3ed;position:relative;isolation:isolate;box-sizing:border-box;display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;background:var(--ground);color:var(--ink);font:14px/1.45 "Inter",-apple-system,BlinkMacSystemFont,sans-serif}
.priorityDemo *{box-sizing:border-box}
.priorityDemo h1,.priorityDemo h2,.priorityDemo h3,.priorityDemo p{margin:0}
.priorityDemo button,.priorityDemo input,.priorityDemo select{font:inherit;color:inherit}
.priorityDemo button{cursor:pointer;background:transparent;border:0;text-align:left}
.priorityDemo button:hover,.priorityDemo a:hover{filter:brightness(.91)}
.priorityDemo :focus-visible{outline:2px solid #6889a7;outline-offset:1px}
.priorityDemo .detailtop small{font-size:11px;font-weight:650;letter-spacing:.035em}
.priorityDemo .scrollArea{min-height:0;overflow-y:auto;flex:1;padding:0 24px 22px}
.priorityDemo .projectrow{display:flex;align-items:flex-start;gap:12px;overflow-x:auto;overscroll-behavior-x:contain;padding:2px 2px 12px}
.priorityDemo article{background:var(--paper);border:1px solid var(--line);border-radius:14px;flex:1 0 174px;min-width:0;overflow:hidden}
.priorityDemo article.lead{flex:1.9 0 272px;border-color:#87a18f}
.priorityDemo header{padding:15px 16px 14px}
.priorityDemo .detailtop,.priorityDemo .pair,.priorityDemo .dispatch{display:flex;align-items:center;justify-content:space-between;gap:9px}
.priorityDemo header h2{margin:0;min-width:0}
.priorityDemo .projectTitle{display:block;width:100%;font:inherit;letter-spacing:inherit;padding:0;cursor:grab;touch-action:pan-y;user-select:none}
.priorityDemo .projectTitle:active{cursor:grabbing}
.priorityDemo h2{font:600 20px/1.18 Georgia,serif;letter-spacing:-.024em;margin:12px 0 3px}
.priorityDemo article.lead header{background:#284c3c;color:#fffdf2}
.priorityDemo article.lead h2{font-size:26px}
.priorityDemo section{padding:11px 12px 8px;border-top:1px solid var(--line)}
.priorityDemo .phase{width:100%;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:650;padding:1px 0 7px}
.priorityDemo .phase span{color:#647566}
.priorityDemo .taskline{display:flex;flex-direction:column;align-items:flex-start;gap:6px;width:100%;border-radius:5px;padding:8px 2px}
.priorityDemo .taskline:hover,.priorityDemo .taskline.selected{background:#eaf0e8}
.priorityDemo .taskname{font-weight:520;line-height:1.35;overflow-wrap:anywhere}
.priorityDemo .meta{display:flex;flex-wrap:wrap;gap:5px}
.priorityDemo .status,.priorityDemo .tag{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;padding:2px 6px;border-radius:5px;font-size:11px;line-height:1.3;font-weight:550}
.priorityDemo .status{color:#49564f;background:#ecefe9}.priorityDemo .status i{width:6px;height:6px;border-radius:50%;background:currentColor}
.priorityDemo .s1{background:#e1ebf5;color:#315579}.priorityDemo .s2{background:#fae7c5;color:#805014}.priorityDemo .s3{background:#daebdf;color:#365e45}
.priorityDemo .t0{color:#6a4577;background:#eee3ef}.priorityDemo .t1{color:#36597b;background:#e3edf6}.priorityDemo .t2{color:#83533c;background:#f4e1d4}.priorityDemo .t3{color:#3c6553;background:#dceae1}
.priorityDemo .add,.priorityDemo .projectlink{color:var(--accent);font-size:12px;padding:6px 0}
.priorityDemo .overlay{position:absolute;inset:0;z-index:2;background:#20332848;display:flex;justify-content:flex-end}
.priorityDemo .sheet{width:min(420px,100%);background:var(--paper);overflow-y:auto;padding-bottom:68px}
.priorityDemo .detail{background:var(--paper);padding:16px 18px}
.priorityDemo .detailtop{align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:9px;margin-bottom:14px}.priorityDemo .detailtop button{font-size:20px;line-height:1}
.priorityDemo .field{display:grid;gap:4px;font-size:11px;font-weight:600;color:#536056}
.priorityDemo .field input,.priorityDemo select,.priorityDemo form input{width:100%;min-width:0;padding:7px 8px;border-radius:5px;border:1px solid var(--line);background:white;color:#293a31;font-size:13px}
.priorityDemo .pair{justify-content:start;margin:9px 0 16px}.priorityDemo .pair label{flex:1}
.priorityDemo h3{font-size:13px}.priorityDemo ul{padding-left:17px;font-size:13px}
.priorityDemo form{display:flex;gap:4px}.priorityDemo form button,.priorityDemo .dispatch button{padding:7px 9px;border:1px solid var(--line);border-radius:6px;font-size:12px}
.priorityDemo .dispatch{margin-top:17px;padding-top:12px;border-top:1px solid var(--line);flex-wrap:wrap;font-size:13px}.priorityDemo .dispatch .primary{background:var(--accent);color:white;border-color:transparent}
.priorityDemo .empty{padding:16px}
.priorityDemo .compactLine,.priorityDemo .childline{display:flex;align-items:center;gap:7px;min-width:0;height:35px}
.priorityDemo .compactTask + .compactTask{border-top:1px solid #e6e8e1}
.priorityDemo .compactTitle,.priorityDemo .childline span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.priorityDemo .compactTitle{flex:1;min-width:0;font-size:13px;padding:4px 0}
.priorityDemo .compactLine:has(input:checked) .compactTitle,.priorityDemo .childline:has(input:checked) span{text-decoration:line-through;color:#707a71}
.priorityDemo .compactLine input,.priorityDemo .childline input{accent-color:#39664d;margin:0;width:14px;height:14px;flex:none}
.priorityDemo .disclose{font-size:11px;color:#58665b;padding:4px 0}
.priorityDemo select.compactStatus{width:81px;flex:none;margin-left:auto;padding:3px 2px 3px 5px;line-height:1.25;font-family:inherit;font-size:11px;font-weight:500;border:0;border-radius:5px;cursor:pointer;background-color:#eef0eb;color:#49564f}
.priorityDemo select.compactStatus.s1{background:#e1ebf5;color:#315579}.priorityDemo select.compactStatus.s2{background:#fae7c5;color:#805014}.priorityDemo select.compactStatus.s3{background:#daebdf;color:#365e45}
.priorityDemo .children{padding-left:20px}.priorityDemo .childline{font-size:12px;height:29px}.priorityDemo .detail .children{padding:3px 0}
.priorityDemo.carnet .detail h3{margin-top:16px}
.priorityDemo .extras{margin:16px 0}.priorityDemo .extras textarea{line-height:1.4;font-family:inherit;font-size:13px;resize:vertical;min-height:64px;padding:8px;color:var(--ink);background:white;border:1px solid var(--line);border-radius:6px}
.priorityDemo .attach{display:inline-flex;align-items:center;position:relative;border:1px solid var(--line);border-radius:6px;padding:5px 9px;margin-top:9px;font-size:12px;overflow:hidden}
.priorityDemo .attach:focus-within{outline:2px solid #6889a7}.priorityDemo .attach input{position:absolute;inset:0;width:100%;opacity:0;cursor:pointer}
.priorityDemo .gallery{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}.priorityDemo .lp-image{position:relative}.priorityDemo .lp-image>button:first-child{padding:0}.priorityDemo .lp-image>button>img{width:78px;height:60px;object-fit:cover;border-radius:5px}.priorityDemo .lp-remove{position:absolute;right:1px;top:1px;background:white;border-radius:50%;font-size:15px}
.priorityDemo .lp-lightbox{border:0;border-radius:8px;max-width:90vw}.priorityDemo .lp-lightbox img{display:block;max-width:80vw;max-height:72vh}.priorityDemo .lp-lightbox::backdrop{background:#17281ed9}
/* The compact board reads like a document, with one property at the end of each row. */
.priorityDemo.carnet {
  --ground:#fff; --paper:#fff; --ink:#37352f; --line:#e9e9e7; --accent:#45443f;
  font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
.carnet .scrollArea { padding:24px 22px 16px; }
.carnet .projectrow { gap:24px; }
.priorityDemo.carnet article { flex-basis:285px; background:transparent; border:0; border-radius:0; }
.priorityDemo.carnet article.lead { flex-basis:365px; }
.priorityDemo.carnet article header {
  display:flex; align-items:center; min-height:45px; padding:0 3px 12px;
  background:transparent; color:var(--ink); border-bottom:1px solid var(--line);
}
.priorityDemo.carnet header h2 { width:100%; font-family:inherit; font-size:18px; line-height:1.25; font-weight:650; letter-spacing:-.035em; }
.priorityDemo.carnet .lead h2 { font-size:21px; }
.carnet .projectTitle:hover { color:#171714; }
.priorityDemo.carnet section { padding:15px 0 3px; border:0; }
.carnet .phase {
  width:auto; border-radius:4px; padding:3px 7px 3px 5px; margin:0 0 7px;
  background:#f1f1ef; color:#47453f; font-size:12px; font-weight:600;
}
.carnet .phase span,.carnet .disclose { color:#6d6b65; }
.carnet .compactTask + .compactTask { border-color:#efefed; }
.carnet .compactLine,.carnet .childline { padding-inline:4px; border-radius:3px; }
.carnet .compactLine:hover,.carnet .childline:hover,.carnet .add:hover { background:#f7f7f5; }
.carnet .compactTitle { font-size:13px; color:var(--ink); }
.carnet .compactLine input,.carnet .childline input { accent-color:#53524c; }
.carnet select.compactStatus {
  --pill:#efefed; --label:#54534d; --dot:#86847d;
  width:83px; border-radius:12px; padding:3px 4px 3px 16px; appearance:none;
  color:var(--label); font-size:11.5px; line-height:1.25;
}
.carnet select.compactStatus.s1 { --dot:#5285a8; --pill:#e6f1f8; --label:#355b73; }
.carnet select.compactStatus.s2 { --dot:#b48634; --pill:#fbefd7; --label:#78581d; }
.carnet select.compactStatus.s3 { --dot:#56836b; --pill:#e3efe7; --label:#3d624d; }
.priorityDemo.carnet select.compactStatus { background:radial-gradient(circle at 8px 50%,var(--dot) 3px,transparent 3.5px) var(--pill); color:var(--label); }
.carnet select.compactStatus:hover { box-shadow:0 0 0 1px var(--dot); }
.carnet .add { color:#706f69; padding:5px 4px; border-radius:3px; }
.carnet .children { border-left:1px solid var(--line); margin:2px 0 5px 11px; padding-left:10px; }
.carnet .detail .children { border:0; margin:0; }
.carnet .overlay { background:#24232126; }
.carnet .sheet { border-left:1px solid var(--line); box-shadow:-5px 0 24px #25241f0b; }
.carnet .detail { padding:20px; }
.carnet .detailtop small,.carnet .field { color:#686760; }
.carnet .detail input,.carnet .extras textarea { color:var(--ink); }
.priorityDemo dialog.taskDrawer[open] { position:fixed; inset:0; width:100%; height:100%; max-width:none; max-height:none; margin:0; border:0; padding:0; background:transparent; color:var(--ink); overflow:hidden; }
.priorityDemo dialog.taskDrawer::backdrop { background:#24232130; }
.priorityDemo .taskDrawer .sheet { width:min(470px,100%); padding-bottom:24px; overscroll-behavior:contain; }
.priorityDemo .editTaskHeading { display:flex; align-items:flex-start; flex-direction:column; gap:9px; margin:18px 0 23px; }
.priorityDemo .editTaskHeading textarea { width:100%; min-height:30px; padding:2px 3px; border:0; border-radius:3px; background:transparent; color:var(--ink); font-family:inherit; font-size:23px; line-height:1.25; font-weight:650; letter-spacing:-.035em; }
.priorityDemo .editTaskHeading .compactStatus { margin:0; }
.priorityDemo .editTaskHeading textarea,.priorityDemo .extras textarea { field-sizing:content; resize:none; overflow-y:hidden; }
.priorityDemo .editChildren { padding-left:12px; border-left:2px solid var(--line); margin:9px 0 20px 4px; }
.priorityDemo .editChild { display:flex; align-items:center; gap:7px; min-height:34px; border-bottom:1px solid var(--line); }
.priorityDemo .editChild:last-child { border:0; }
.priorityDemo .editChild .childTitle { flex:1; min-width:0; padding:6px 3px; border:0; border-radius:3px; font:inherit; color:var(--ink); background:transparent; }
.priorityDemo .editTaskHeading textarea:focus,
.priorityDemo .editChild .childTitle:focus { outline:none; background-color:#f6f6f4; }
@media (forced-colors:active) {
  .priorityDemo .editTaskHeading textarea:focus-visible,
  .priorityDemo .editChild .childTitle:focus-visible { outline:2px solid Highlight; }
}
.priorityDemo .editChild:has(input:checked) .childTitle { color:#75746f; text-decoration:line-through; }
.priorityDemo .editChild input[type=checkbox] { width:14px; height:14px; margin:0; accent-color:#53524c; }
.priorityDemo .childPlus { width:14px; color:#77756e; }
.priorityDemo .removeChild { border-radius:4px; padding:2px 7px; font-size:17px; color:#77756e; }
.priorityDemo .removeChild:hover { color:#9c3b31; background:#f8eeeb; }
.priorityDemo .folderDispatch { display:grid; gap:10px; justify-content:stretch; }
.priorityDemo .folderDispatch pre { font:inherit; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; background:#f6f6f4; margin:0; padding:10px; border-radius:5px; }
.priorityDemo .folderDispatch ul { margin:0; padding-left:20px; overflow-wrap:anywhere; }
.priorityDemo .folderDispatch label { display:grid; grid-template-columns:55px minmax(0,1fr); align-items:center; }
.priorityDemo .dispatchActions { display:flex; gap:8px; align-items:center; justify-content:space-between; }
.priorityDemo .folderDispatch button { justify-self:start; }
.priorityDemo .folderDispatch button:disabled { opacity:.55; }
@media(max-width:700px){.priorityDemo .scrollArea{padding:0 12px 8px}.priorityDemo.carnet .scrollArea{padding-top:16px}}
`;
