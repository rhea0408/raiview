import * as vscode from "vscode";

export function getHtml(scriptUri: vscode.Uri, version: string): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    /* ============ RAIVIEW — design tokens ============ */
    body.vscode-dark, body.vscode-high-contrast {
      --accent: #5cb9ff;
      --accent-ink: #04101a;
      --accent-dim: rgba(92,185,255,.13);
      --accent-line: rgba(92,185,255,.30);
      --sev-crit: #ff5d6c;
      --sev-warn: #ffc14d;
      --sev-info: #5cb9ff;
      --sev-ok: #39ff8a;
      --panel-bg: #0c0e11;
      --surface: #14181d;
      --surface-2: #191e25;
      --surface-hover: #1c222a;
      --border: rgba(255,255,255,.07);
      --border-strong: rgba(255,255,255,.13);
      --text: #e7eaef;
      --text-dim: #8b94a1;
      --text-faint: #59616d;
      --code-bg: rgba(255,255,255,.06);
      --shadow: 0 8px 30px rgba(0,0,0,.5);
      --font-sans: var(--vscode-font-family), system-ui, sans-serif;
      --font-mono: var(--vscode-editor-font-family), 'Courier New', monospace;
    }
    body.vscode-light {
      --accent: #1d74d6;
      --accent-ink: #ffffff;
      --accent-dim: rgba(29,116,214,.10);
      --accent-line: rgba(29,116,214,.34);
      --sev-crit: #e0344a;
      --sev-warn: #c98300;
      --sev-info: #2b86d9;
      --sev-ok: #0fa968;
      --panel-bg: #ffffff;
      --surface: #f4f6f8;
      --surface-2: #eceff2;
      --surface-hover: #e6eaee;
      --border: rgba(15,20,30,.10);
      --border-strong: rgba(15,20,30,.18);
      --text: #1a1f26;
      --text-dim: #5c6672;
      --text-faint: #97a0ab;
      --code-bg: rgba(15,20,30,.06);
      --shadow: 0 8px 28px rgba(20,30,50,.14);
      --font-sans: var(--vscode-font-family), system-ui, sans-serif;
      --font-mono: var(--vscode-editor-font-family), 'Courier New', monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { font-family: var(--font-sans); font-size: 13px; background: var(--panel-bg); color: var(--text); -webkit-font-smoothing: antialiased; }
    ::selection { background: var(--accent-dim); }

    /* panel scroll */
    .panel-scroll { display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 40px; }
    .panel-scroll::-webkit-scrollbar { width: 10px; }
    .panel-scroll::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 6px; border: 3px solid transparent; background-clip: padding-box; }

    /* brand */
    .brand { display: flex; align-items: center; gap: 9px; }
    .brand .mark { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; background: var(--accent-dim); border: 1px solid var(--accent-line); flex: none; }
    .brand .mark svg { width: 13px; height: 13px; color: var(--accent); }
    .brand .name { font-family: var(--font-mono); font-size: 12.5px; font-weight: 600; letter-spacing: 3px; color: var(--text); }
    .brand .name b { color: var(--accent); font-weight: 600; }
    .brand .ver { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); letter-spacing: .5px; }

    /* topbar */
    .topbar { display: flex; align-items: center; gap: 4px; padding: 2px 0 12px; border-bottom: 1px solid var(--border); }
    .topbar .lbl { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; color: var(--text-faint); text-transform: uppercase; margin-right: auto; padding-left: 2px; }
    .iconbtn { width: 32px; height: 32px; border-radius: 8px; flex: none; display: grid; place-items: center; cursor: pointer; color: var(--text-dim); background: transparent; border: 1px solid transparent; transition: color .15s, border-color .15s; }
    .iconbtn:hover { color: var(--text); background: var(--surface); border-color: var(--border); }
    .iconbtn.on { color: var(--accent); border-color: var(--accent-line); background: var(--accent-dim); }
    .iconbtn svg { width: 16px; height: 16px; }
    .iconbtn.spin svg { animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* collapsible sections */
    .section-head { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; padding: 2px 0; }
    .section-head .chev { width: 12px; height: 12px; color: var(--text-faint); transition: transform .2s ease; flex: none; }
    .section-head.open .chev { transform: rotate(90deg); color: var(--accent); }
    .section-head h3 { margin: 0; font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--text-dim); }
    .section-head .tag { margin-left: auto; font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); padding: 1px 7px; border: 1px solid var(--border); border-radius: 999px; }
    .collapsible { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .25s ease; }
    .collapsible.open { grid-template-rows: 1fr; }
    .collapsible > .inner { overflow: hidden; }
    .collapsible.open > .inner { overflow: visible; }
    .coll-pad { padding-top: 10px; display: flex; flex-direction: column; gap: 0; }

    /* form controls */
    label.field-lbl { display: block; font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-faint); margin: 0 0 6px; }
    .select { position: relative; width: 100%; }
    .select select { width: 100%; appearance: none; -webkit-appearance: none; font-family: var(--font-mono); font-size: 12.5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 10px 34px 10px 12px; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
    .select select:hover { border-color: var(--border-strong); }
    .select select:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-dim); }
    .select .car { position: absolute; right: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--text-dim); width: 14px; height: 14px; }
    .input, .textarea { width: 100%; font-family: var(--font-mono); font-size: 12.5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; transition: border-color .15s, box-shadow .15s; }
    .textarea { resize: vertical; min-height: 78px; line-height: 1.55; }
    .input::placeholder, .textarea::placeholder { color: var(--text-faint); }
    .input:focus, .textarea:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-dim); }

    /* toggles */
    .toggle-row { display: flex; align-items: center; gap: 12px; padding: 7px 0; }
    .toggle-row .tx { flex: 1; }
    .toggle-row .tx .t1 { font-size: 12.5px; color: var(--text); }
    .toggle-row .tx .t1 span { color: var(--text-dim); }
    .switch { width: 38px; height: 22px; border-radius: 999px; flex: none; cursor: pointer; background: var(--surface-2); border: 1px solid var(--border-strong); position: relative; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-faint); transition: transform .2s ease; }
    .switch.on { background: var(--accent); border-color: var(--accent); }
    .switch.on::after { transform: translateX(16px); background: var(--accent-ink); }

    /* action buttons */
    .actions { display: flex; gap: 8px; align-items: stretch; }
    .act-btn { flex: 1 1 50%; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 8px; font-family: var(--font-sans); font-size: 13px; font-weight: 600; padding: 11px 12px; border-radius: 10px; cursor: pointer; border: 1px solid var(--accent-line); color: var(--accent); background: var(--accent-dim); transition: flex .2s, padding .2s, opacity .2s, transform .1s; white-space: nowrap; overflow: hidden; }
    .act-btn svg { width: 15px; height: 15px; flex: none; }
    .act-btn:hover { filter: brightness(1.1); }
    .act-btn:active { transform: translateY(1px); }
    .act-btn.primary { background: var(--accent); color: var(--accent-ink); }
    .act-btn.primary:hover { filter: brightness(1.06); }
    .act-btn.busy { color: var(--text-dim); background: var(--surface); border-color: var(--border); cursor: default; filter: none; }
    .act-btn.hidden-btn { flex: 0 0 0 !important; padding-left: 0 !important; padding-right: 0 !important; margin: 0 !important; opacity: 0 !important; border-width: 0 !important; pointer-events: none; }
    .act-btn .spin-ic { width: 14px; height: 14px; animation: spin .8s linear infinite; }
    .act-btn:disabled { opacity: .5; cursor: default; }

    /* settings card */
    .settings { border: 1px solid var(--accent-line); border-radius: 12px; background: linear-gradient(180deg, var(--surface), var(--panel-bg)); padding: 14px; box-shadow: var(--shadow); position: relative; overflow: hidden; display: none; }
    .settings.open { display: block; }
    .settings::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: linear-gradient(90deg, transparent, var(--accent), transparent); opacity: .6; }
    .settings .s-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .settings .s-head svg { width: 14px; height: 14px; color: var(--accent); }
    .settings .s-head h4 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .3px; color: var(--text); }
    .settings .hint { font-size: 11.5px; color: var(--text-dim); line-height: 1.5; margin: 4px 0 12px; }
    .settings .hint b { color: var(--text); }
    .divider { height: 1px; background: var(--border); margin: 12px 0; }
    .create-btn { width: 100%; text-align: center; font-family: var(--font-mono); font-size: 12px; letter-spacing: .5px; color: var(--accent); background: transparent; border: 1px dashed var(--accent-line); border-radius: 9px; padding: 9px; cursor: pointer; margin: 10px 0; transition: background .15s; }
    .create-btn:hover { background: var(--accent-dim); }
    .create-btn:disabled { opacity: .5; cursor: default; }
    .settings-sub-btn { display: block; margin: 8px auto 0; font-family: var(--font-sans); font-size: 12.5px; font-weight: 600; padding: 7px 18px; border-radius: 9px; cursor: pointer; background: var(--surface); border: 1px solid var(--accent-line); color: var(--accent); transition: background .15s; }
    .settings-sub-btn:hover { background: var(--surface-2); }
    .settings-sub-btn.danger { border-color: var(--sev-crit); color: var(--sev-crit); }
    .settings-sub-btn.danger:hover { background: color-mix(in srgb, var(--sev-crit) 12%, var(--surface)); }
    .settings-sub-btns { display: flex; gap: 8px; margin-top: 8px; }
    .settings-sub-btns .settings-sub-btn { flex: 1; margin: 0; }
    .key-status { font-size: 11.5px; color: var(--text-faint); margin: 6px 0; }
    .key-status.set { color: var(--sev-ok); }
    .reviewer-status { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; }
    .derived-model-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); font-size: 11.5px; font-family: var(--font-mono); margin-bottom: 4px; color: var(--text-dim); }
    .derived-model-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .derived-model-delete { background: none; border: none; color: var(--text-faint); cursor: pointer; padding: 0 2px; line-height: 1; flex-shrink: 0; width: auto; }
    .derived-model-delete:hover { color: var(--sev-crit); }
    .s-section-lbl { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-faint); margin: 14px 0 8px; }
    .reviewer-section { display: none; flex-direction: column; gap: 8px; padding-top: 8px; }
    .reviewer-section.visible { display: flex; }

    /* chat shell */
    .chat-shell { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); overflow: hidden; display: flex; flex-direction: column; }
    .chat-empty { padding: 38px 22px; text-align: center; min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
    .chat-empty .ring { width: 46px; height: 46px; border-radius: 50%; border: 1px solid var(--border-strong); display: grid; place-items: center; color: var(--text-faint); }
    .chat-empty .ring svg { width: 20px; height: 20px; }
    .chat-empty p { margin: 0; font-size: 12.5px; color: var(--text-dim); font-style: italic; }
    .chat-empty .kbd { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }
    .chat-body { padding: 14px; display: flex; flex-direction: column; gap: 14px; }

    /* streaming */
    .stream-meta { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-dim); line-height: 1.6; text-align: center; padding: 4px 6px; }
    .stream-meta .file { color: var(--accent); }
    .parts { display: flex; gap: 5px; justify-content: center; padding: 4px 0; }
    .parts i { height: 4px; flex: 1; max-width: 54px; border-radius: 3px; background: var(--surface-2); border: 1px solid var(--border); display: block; }
    .parts i.done { background: var(--accent); border-color: var(--accent); }
    .parts i.cur { background: var(--accent-dim); border-color: var(--accent-line); animation: pulseb 1.1s ease-in-out infinite; }
    @keyframes pulseb { 50% { background: var(--accent-line); } }
    .thinking { display: flex; align-items: center; gap: 11px; border: 1px solid var(--accent-line); border-radius: 10px; background: var(--accent-dim); padding: 12px 14px; }
    .thinking .cur { width: 9px; height: 16px; background: var(--accent); flex: none; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .thinking .lab { font-family: var(--font-mono); font-size: 12.5px; color: var(--accent); letter-spacing: .5px; }
    .thinking .dots::after { content: ""; animation: dots 1.4s steps(4) infinite; }
    @keyframes dots { 0%{content:"";} 25%{content:".";} 50%{content:"..";} 75%{content:"...";} }

    /* review output */
    .review { font-size: 13px; line-height: 1.62; color: var(--text); }
    .review h4 { margin: 16px 0 8px; font-size: 12.5px; font-weight: 700; letter-spacing: .3px; display: flex; align-items: center; gap: 8px; }
    .review h4:first-child { margin-top: 0; }
    .review h4 .num { font-family: var(--font-mono); font-size: 10px; color: var(--accent); border: 1px solid var(--accent-line); border-radius: 5px; padding: 1px 5px; background: var(--accent-dim); }
    .findings { display: flex; flex-direction: column; gap: 7px; margin: 0 0 4px; }
    .finding { display: flex; gap: 9px; align-items: flex-start; border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; padding: 8px 10px; background: var(--panel-bg); }
    .finding .chip { font-family: var(--font-mono); font-size: 9.5px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; padding: 3px 7px; border-radius: 5px; flex: none; display: inline-flex; align-items: center; gap: 5px; line-height: 1; white-space: nowrap; }
    .finding .chip .d { width: 6px; height: 6px; border-radius: 50%; }
    .finding .tx { flex: 1; font-size: 12.5px; line-height: 1.55; color: var(--text); }
    .finding .tx code { font-family: var(--font-mono); font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; color: var(--text); }
    .finding.crit { border-left-color: var(--sev-crit); }
    .finding.crit .chip { color: var(--sev-crit); background: color-mix(in srgb, var(--sev-crit) 14%, transparent); }
    .finding.crit .chip .d { background: var(--sev-crit); }
    .finding.warn { border-left-color: var(--sev-warn); }
    .finding.warn .chip { color: var(--sev-warn); background: color-mix(in srgb, var(--sev-warn) 14%, transparent); }
    .finding.warn .chip .d { background: var(--sev-warn); }
    .finding.info { border-left-color: var(--sev-info); }
    .finding.info .chip { color: var(--sev-info); background: color-mix(in srgb, var(--sev-info) 14%, transparent); }
    .finding.info .chip .d { background: var(--sev-info); }
    .finding.ok { border-left-color: var(--sev-ok); }
    .finding.ok .chip { color: var(--sev-ok); background: color-mix(in srgb, var(--sev-ok) 14%, transparent); }
    .finding.ok .chip .d { background: var(--sev-ok); }
    .summary { display: flex; align-items: center; gap: 11px; margin-top: 14px; border: 1px solid var(--sev-warn); border-radius: 10px; padding: 11px 13px; background: color-mix(in srgb, var(--sev-warn) 9%, transparent); }
    .summary .ic-w { width: 26px; height: 26px; border-radius: 7px; flex: none; display: grid; place-items: center; background: color-mix(in srgb, var(--sev-warn) 18%, transparent); color: var(--sev-warn); }
    .summary .ic-w svg { width: 15px; height: 15px; }
    .summary .st .l1 { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--text-faint); }
    .summary .st .l2 { font-size: 13.5px; font-weight: 700; color: var(--text); }
    .summary.ok { border-color: var(--sev-ok); background: color-mix(in srgb, var(--sev-ok) 9%, transparent); }
    .summary.ok .ic-w { background: color-mix(in srgb, var(--sev-ok) 18%, transparent); color: var(--sev-ok); }
    .summary.crit { border-color: var(--sev-crit); background: color-mix(in srgb, var(--sev-crit) 9%, transparent); }
    .summary.crit .ic-w { background: color-mix(in srgb, var(--sev-crit) 18%, transparent); color: var(--sev-crit); }
    .msg-foot { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); padding-top: 8px; border-top: 1px solid var(--border); margin-top: 4px; display: flex; align-items: center; gap: 6px; }
    .msg-foot .m { color: var(--accent); }

    /* chat messages */
    .user-msg { align-self: flex-end; max-width: 88%; background: var(--accent-dim); border: 1px solid var(--accent-line); border-radius: 10px 10px 3px 10px; padding: 8px 11px; font-size: 12.5px; color: var(--text); }
    .assistant-msg { font-size: 12.5px; line-height: 1.62; color: var(--text); }
    .assistant-msg p { margin: 5px 0; }
    .assistant-msg ul, .assistant-msg ol { margin: 5px 0; padding-left: 18px; }
    .assistant-msg li { margin: 2px 0; }
    .assistant-msg code { font-family: var(--font-mono); font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
    .assistant-msg pre { font-family: var(--font-mono); font-size: 11.5px; background: var(--panel-bg); border: 1px solid var(--border); border-radius: 9px; padding: 11px 12px; overflow-x: auto; margin: 8px 0; }
    .assistant-msg pre code { background: none; border: none; padding: 0; }
    .system-note { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); text-align: center; padding: 2px 4px; font-style: italic; }
    .error-msg { font-size: 12.5px; color: var(--sev-crit); border: 1px solid var(--sev-crit); border-radius: 8px; padding: 8px 10px; background: color-mix(in srgb, var(--sev-crit) 10%, transparent); }

    /* chat footer */
    .chat-foot { border-top: 1px solid var(--border); padding: 11px 12px; background: var(--panel-bg); display: none; }
    .chat-foot.visible { display: block; }
    .progress-row { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
    .progress-row .pn { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-dim); flex: none; }
    .bar { flex: 1; height: 4px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--accent); transition: width .4s ease; }
    .bar > i.warn { background: var(--sev-warn); }
    .bar > i.danger { background: var(--sev-crit); }
    .limit-warning { font-size: 11.5px; color: var(--sev-warn); margin-bottom: 8px; font-family: var(--font-mono); display: none; }
    .limit-warning.visible { display: block; }
    .followup { display: flex; gap: 8px; align-items: flex-end; }
    .followup .ta-wrap { flex: 1; }
    .followup textarea { width: 100%; resize: none; height: 40px; font-family: var(--font-sans); font-size: 12.5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 10px 11px; line-height: 1.4; }
    .followup textarea:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-dim); }
    .followup textarea:disabled { opacity: .5; }
    .send-btn { flex: none; font-family: var(--font-sans); font-size: 12.5px; font-weight: 600; padding: 0 16px; height: 40px; border-radius: 9px; cursor: pointer; background: var(--accent); color: var(--accent-ink); border: none; transition: filter .15s, transform .1s; }
    .send-btn:hover { filter: brightness(1.07); }
    .send-btn:active { transform: translateY(1px); }
    .send-btn:disabled { opacity: .5; cursor: default; }
    .send-btn.stop { background: color-mix(in srgb, var(--sev-crit) 18%, transparent); color: var(--sev-crit); border: 1px solid var(--sev-crit); }
    .foot-link { display: none; text-align: right; margin-top: 9px; font-size: 11.5px; color: var(--accent); cursor: pointer; }
    .foot-link.visible { display: block; }
    .foot-link:hover { text-decoration: underline; }

    /* sessions */
    .sessions { display: flex; flex-direction: column; gap: 8px; }
    .sess { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--surface); cursor: pointer; transition: border-color .15s, background .15s, transform .1s; display: flex; align-items: center; gap: 11px; }
    .sess:hover { border-color: var(--accent-line); background: var(--surface-hover); transform: translateX(2px); }
    .sess .tag-diff { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .5px; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--accent-line); border-radius: 6px; padding: 3px 7px; flex: none; }
    .sess .meta { flex: 1; min-width: 0; }
    .sess .meta .l1 { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sess .meta .l2 { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }
    .sess .rate { flex: none; width: 9px; height: 9px; border-radius: 50%; }
    .sess .arrow { flex: none; color: var(--text-faint); width: 14px; height: 14px; }
    .sess:hover .arrow { color: var(--accent); }
    .sess-foot { display: flex; justify-content: flex-end; padding-top: 4px; }
    .clear-all { font-size: 11.5px; color: var(--text-faint); cursor: pointer; }
    .clear-all:hover { color: var(--sev-crit); }
    .history-empty { font-size: 12px; color: var(--text-faint); font-style: italic; }

    /* session viewer */
    .viewer { border: 1px solid var(--accent-line); border-radius: 12px; overflow: hidden; background: var(--surface); box-shadow: var(--shadow); margin-top: 10px; display: none; }
    .viewer.visible { display: block; }
    .viewer .v-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--panel-bg); }
    .viewer .v-head .tag-diff { font-family: var(--font-mono); font-size: 10px; font-weight: 600; color: var(--accent); background: var(--accent-dim); border: 1px solid var(--accent-line); border-radius: 6px; padding: 3px 7px; }
    .viewer .v-head .vt { flex: 1; font-size: 11.5px; color: var(--text-dim); font-family: var(--font-mono); }
    .viewer .v-head .ro { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 1px; color: var(--text-faint); border: 1px solid var(--border); border-radius: 5px; padding: 2px 6px; }
    .viewer .v-close { display: flex; align-items: center; gap: 5px; cursor: pointer; color: var(--text-faint); font-size: 11.5px; background: none; border: none; padding: 0; }
    .viewer .v-close:hover { color: var(--sev-crit); }
    .viewer .v-close svg { width: 13px; height: 13px; }
    .viewer .v-body { padding: 14px; max-height: 420px; overflow-y: auto; }
    .viewer .v-body::-webkit-scrollbar { width: 9px; }
    .viewer .v-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 6px; border: 3px solid transparent; background-clip: padding-box; }

    .fade { animation: fade .3s ease both; }
    @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  </style>
</head>
<body>
<div class="panel-scroll">

  <!-- Brand -->
  <div class="brand">
    <span class="mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12C5 7.5 8.4 5.5 12 5.5S19 7.5 21.5 12C19 16.5 15.6 18.5 12 18.5S5 16.5 2.5 12Z"/><path d="M12 9.1l.86 1.93 1.93.86-1.93.86L12 15.5l-.86-1.95-1.93-.86 1.93-.86z" fill="currentColor" stroke="none"/></svg>
    </span>
    <span class="name">RAI<b>VIEW</b></span>
    <span class="ver">v${version}</span>
  </div>

  <!-- Topbar -->
  <div class="topbar">
    <span class="lbl" id="agentStatus">Local Agent · Ready</span>
    <button class="iconbtn" id="refreshBtn" title="Refresh models">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
    </button>
    <button class="iconbtn" id="freeMemoryBtn" style="display:none" title="Unload model from Ollama memory">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>
    </button>
    <button class="iconbtn" id="settingsBtn" title="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
  </div>

  <!-- Settings panel -->
  <div class="settings" id="settingsPanel">
    <div class="s-head">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <h4>Settings</h4>
    </div>
    <div class="toggle-row">
      <div class="tx"><div class="t1">Streaming <span>(chunked output)</span></div></div>
      <div class="switch on" id="streamSwitch"></div>
    </div>
    <div class="toggle-row" id="enhancedRow" style="display:none">
      <div class="tx"><div class="t1">Enhanced Reviewer <span>(Ollama)</span></div></div>
      <div class="switch" id="enhancedSwitch"></div>
    </div>
    <div class="reviewer-section" id="reviewerSection">
      <p class="hint">Creates a <b>code-reviewer</b> model in Ollama with optimized parameters and a structured code-review system prompt.</p>
      <label class="field-lbl" style="margin-top:4px">Base Model</label>
      <div class="select">
        <select id="baseModelSelect"><option value="">Select base model...</option></select>
        <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <button class="create-btn" id="createReviewerBtn">✦ Create code-reviewer Model</button>
      <div class="reviewer-status" id="reviewerStatus"></div>
      <div id="derivedModelsList" style="display:none; margin-top:6px;"></div>
    </div>
    <div id="ollamaSettingsRow" style="display:none">
      <div class="divider"></div>
      <div class="s-section-lbl" style="margin-top:0">Ollama</div>
      <label class="field-lbl">URL</label>
      <input class="input" type="text" id="ollamaUrlInput" placeholder="http://localhost:11434" />
      <button class="settings-sub-btn" id="saveOllamaUrlBtn">Save URL</button>
      <label class="field-lbl" style="margin-top:12px">Pinned Models <span style="font-weight:400;font-size:10px;">(one per line — leave empty to fetch from server)</span></label>
      <textarea class="textarea" id="ollamaPinnedModels" rows="3" placeholder="qwen3.5:397b-cloud&#10;llama3.3:70b"></textarea>
      <button class="settings-sub-btn" id="savePinnedModelsBtn">Save Models</button>
    </div>
    <div class="divider"></div>
    <div class="s-section-lbl" style="margin-top:0">API Keys</div>
    <label class="field-lbl">Provider</label>
    <div class="select">
      <select id="keyProviderSelect"></select>
      <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <input class="input" type="password" id="apiKeyInput" placeholder="Enter API key..." style="margin-top:8px" />
    <div id="apiKeyHint" style="font-size:11.5px; color:var(--text-dim); margin-top:6px;"></div>
    <div class="key-status" id="apiKeyStatus">No key saved.</div>
    <div class="settings-sub-btns">
      <button class="settings-sub-btn" id="saveKeyBtn">Save Key</button>
      <button class="settings-sub-btn danger" id="clearKeyBtn">Clear Key</button>
    </div>
  </div>

  <!-- Action buttons -->
  <div class="actions">
    <button class="act-btn primary" id="reviewBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><circle cx="18" cy="8" r="3"/><path d="M18 11a6 6 0 0 1-6 6"/></svg>
      Review Git Changes
    </button>
    <button class="act-btn" id="sendBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12L21 4l-5 8 5 8z"/></svg>
      Send for Review
    </button>
  </div>

  <!-- Provider section -->
  <div class="sect">
    <div class="section-head open" id="providerHeader">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <h3>Provider</h3>
    </div>
    <div class="collapsible open" id="providerCollapsible">
      <div class="inner">
        <div class="coll-pad" id="providerBody">
          <div class="select">
            <select id="providerSelect"><option value="">Loading...</option></select>
            <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </div>
          <label class="field-lbl" style="margin-top:12px">Model</label>
          <div class="select">
            <select id="availableModels"><option value="">Detecting...</option></select>
            <svg class="car" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- System prompt section -->
  <div class="sect" id="sysPromptSection">
    <div class="section-head" id="sysPromptHeader">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <h3>System Prompt</h3>
      <span class="tag" id="sysPromptTag" style="display:none">set</span>
    </div>
    <div class="collapsible" id="sysPromptCollapsible">
      <div class="inner">
        <div class="coll-pad">
          <textarea class="textarea" id="systemPrompt" rows="4" placeholder="Enter a system prompt to guide the review..."></textarea>
        </div>
      </div>
    </div>
  </div>

  <!-- Chat shell -->
  <div class="chat-shell">
    <div id="chatMessages">
      <div class="chat-empty" id="chatEmpty">
        <div class="ring">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M3 12h18"/></svg>
        </div>
        <p>No review started yet.</p>
        <div class="kbd">▸ Click a review button above</div>
      </div>
    </div>
    <div class="chat-foot" id="followupArea">
      <div class="progress-row" id="limitBar" style="display:none">
        <span class="pn" id="limitText">0 / 20</span>
        <div class="bar"><i id="limitFill" style="width:0%"></i></div>
      </div>
      <div class="limit-warning" id="limitWarning"></div>
      <div class="followup">
        <div class="ta-wrap">
          <textarea id="followupInput" placeholder="Ask a follow-up question about the review..."></textarea>
        </div>
        <button class="send-btn" id="followupSend">Send</button>
      </div>
      <a class="foot-link" id="newSessionBtn">↺ Start new session</a>
    </div>
  </div>

  <!-- Recent Sessions -->
  <div class="sect">
    <div class="section-head open" id="historyHeader">
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
      <h3>Recent Sessions</h3>
      <span class="tag" id="historyCount" style="display:none"></span>
    </div>
    <div class="collapsible open" id="historyCollapsible">
      <div class="inner">
        <div class="coll-pad">
          <div class="sessions" id="historyPanel">
            <div class="history-empty" id="historyEmpty">No past sessions.</div>
          </div>
          <div class="sess-foot" id="historyActions" style="display:none">
            <span class="clear-all" id="clearHistoryBtn">Clear All</span>
          </div>
          <div class="viewer" id="sessionOverlay">
            <div class="v-head">
              <span class="tag-diff">\`\`\`diff</span>
              <span class="vt" id="overlayTitle">Session transcript</span>
              <span class="ro">READ-ONLY</span>
              <button class="v-close" id="overlayCloseBtn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
                Close
              </button>
            </div>
            <div class="v-body" id="overlayMessages"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
