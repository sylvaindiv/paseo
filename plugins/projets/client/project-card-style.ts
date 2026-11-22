export const cardCss = `
.priorityDemo.cardStudy { --ground:var(--colors-surface-sidebar,#eff0f3); }
.priorityDemo.cardStudy article { background:#fff; }
.projectsHeaderAction { flex:none; margin-left:6px; padding:3px 9px; border:1px solid var(--colors-border,#dededb); border-radius:5px; background:transparent; color:var(--colors-foreground-muted,#53534e); font:500 12px/1.4 system-ui; cursor:pointer; -webkit-app-region:no-drag; }
.projectsHeaderAction:hover,.projectsHeaderAction:focus-visible { color:var(--colors-foreground,#302f2b); background:var(--colors-surface-sidebar,#eff0f3); }
.folderOverview dialog { position:fixed; inset:var(--overview-top,36px) auto 0 0; margin:0; width:min(460px,100%); height:calc(100dvh - var(--overview-top,36px)); max-height:none; max-width:100%; padding:0 18px 12px; border:0; border-right:1px solid var(--line); color:var(--ink); background:#fff; overflow-y:auto; }
.folderOverview dialog::backdrop { background:#24232135; }
.folderOverview .overviewHead,.folderOverview .overviewRow { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); padding:13px 0; }
.folderOverview .overviewHead h2 { line-height:1.3; font-family:inherit; font-size:17px; font-weight:650; margin:0; }
.folderOverview .overviewHead button { font-size:21px; padding:0 5px; }
.folderOverview .overviewRow { display:grid; grid-template-columns:minmax(0,1fr) auto; }
.folderOverview .overviewRow strong { display:block; line-height:1.4; overflow-wrap:break-word; font-size:14px; font-weight:600; }
.folderOverview .phaseSummary { display:flex; flex-wrap:wrap; align-items:center; gap:7px; color:#66645d; font-size:12px; }
.folderOverview .overviewTrack { display:inline-flex; gap:3px; }
.folderOverview .overviewTrack i { width:12px; height:5px; border-radius:2px; background:#dededb; }
.folderOverview .overviewTrack [data-state="EN COURS"] { background:#7490ac; }
.folderOverview .overviewTrack [data-state="OK"] { background:#789985; }
.folderOverview .overviewRow select { width:auto; max-width:100%; align-self:center; min-height:28px; border:0; border-radius:5px; padding:4px; color:#53534e; background:#f0f0ee; font:inherit; font-size:12px; cursor:pointer; }
.folderOverview .overviewRow select[data-status="En cours"] { background:#e6edf5; color:#365b7a; }
.folderOverview .overviewRow select[data-status="En attente"] { background:#f5ebd8; color:#795722; }
.folderOverview .overviewRow select[data-status="Terminé"] { background:#e5eee6; color:#42654b; }

/* Original keeps its compact phase labels on a neutral column. */
.cardStudy.original .projectrow { align-items:stretch; }
.cardStudy.original article { --tone:var(--ink); --wash:#e9e9e7; --edge:#c9c9c5; border-radius:10px; padding:12px; }
.cardStudy.original article header { position:relative; padding:0 0 6px; }
.cardStudy.original .folderPhaseBar { --phase-blue:#0968cf; margin-bottom:5px; border-bottom:1px solid #dedfe1; }
.cardStudy.original .folderPhaseBar .phase { width:100%; margin:0; padding:2px 0; border-radius:0; background:transparent; color:var(--ink); font-size:13px; font-weight:650; }
.cardStudy.original .folderPhaseBar .phase[aria-expanded=true] span { display:none; }
.cardStudy.original .folderPhaseBar .phase span { color:inherit; }
.cardStudy.original .folderPhaseBar .folderAction { color:var(--phase-blue); }
.cardStudy.original .folderPhase + .folderPhase { padding-top:23px; }

.cardStudy.original header .projectTitle { display:flex; align-items:center; gap:8px; padding-right:40px; }
.cardStudy.original .projectIcon { display:inline-flex; flex:none; pointer-events:none; }
.cardStudy.original .projectName { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cardStudy.original .folderAction { flex:none; display:grid; place-items:center; height:24px; width:26px; padding:0; border-radius:4px; color:var(--tone); font-size:17px; opacity:0; }
.cardStudy.original .folderAdd { position:absolute; right:6px; top:50%; transform:translateY(-50%); }
.cardStudy.original :is(header,.folderPhaseBar):is(:hover,:focus-within) > .folderAction,
.cardStudy.original .folderAction[aria-expanded=true] { opacity:1; }
.cardStudy.original .folderAction:hover { background:var(--wash); }
@media (hover:none), (pointer:coarse) { .cardStudy.original .folderAction { opacity:1; } }
.cardStudy.original .folderPhaseBar { display:flex; align-items:center; min-height:26px; }
.cardStudy.original .folderPhaseBar > .projets-title-drag-region,
.cardStudy.original .compactLine > .projets-title-drag-region { display:flex; flex:1; min-width:0; }
.cardStudy.original .projets-title-drag-region { user-select:none; }
.cardStudy.original .folderTask .compactTitle { width:100%; margin:0; cursor:grab; }
.cardStudy.original [data-moving] { position:relative; z-index:2; opacity:.7; background:white; }
.cardStudy.original .folderPhase[data-over]:not([data-moving]) { box-shadow:inset 3px 0 var(--edge); }
.priorityDemo .phaseDialog { box-sizing:border-box; width:min(370px,90vw); padding:22px; border:1px solid #dad9d5; border-radius:10px; background:white; color:#302f2b; box-shadow:0 12px 40px #2222; }
.priorityDemo .phaseDialog::backdrop { background:#23232145; }
.priorityDemo .phaseDialog form { display:block; }
.priorityDemo .phaseDialog small,.priorityDemo .phaseDialog label { color:#68655f; font-size:12px; }
.priorityDemo .phaseDialog h2 { font-size:20px; margin:5px 0 14px; }
.priorityDemo .phaseDialog input { margin-top:5px; }
.priorityDemo .phaseDialog p { font-size:14px; line-height:1.5; }
.priorityDemo .phaseDialog form > div { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
.priorityDemo .phaseDialog .danger { background:#993a34; color:white; }
.priorityDemo .phaseDialog .primary { background:#3e5246; color:white; }
.priorityDemo .phaseDialog button:disabled { opacity:.5; }

`;
