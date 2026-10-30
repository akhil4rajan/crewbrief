// Builds docs/pitch/CrewBrief-pitch.pptx. Run from this folder: node build_deck.js
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const md = require("react-icons/md");
// Writes the CrewBrief colours into the file theme (from the pptx skill). Elements use theme colours, so
// without it the deck falls back to the Office default palette.
let applyTheme = async () => {};
try {
  ({ applyTheme } = require(process.env.PPTX_SKILL + "/scripts/apply_theme.js"));
} catch {
  console.warn("apply_theme.js not found (set PPTX_SKILL); building without the theme palette");
}

const THEME = {
  name: "CrewBrief",
  headFontFace: "Arial",
  bodyFontFace: "Calibri",
  colors: {
    dk1: "1B2A35", // deep slate (text, dark slides)
    lt1: "FFFFFF",
    dk2: "3D5363", // muted slate
    lt2: "EEF2F5", // light panel
    accent1: "F26B1D", // hi-vis safety orange
    accent2: "2E7D5B", // safe green
    accent3: "C62828", // critical red
    accent4: "5B8DB8", // steel blue
    accent5: "8A9BA8",
    accent6: "F2B01D",
    hlink: "F26B1D",
    folHlink: "3D5363",
  },
};
const HEX = THEME.colors;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.title = "CrewBrief";
pres.author = "Akhil Rajan";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;

// ---------- Layouts ----------
pres.defineSlideMaster({
  title: "DARK_TITLE",
  background: { color: C.text1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.3, w: 11.7, h: 1.6, fontSize: 48, bold: true, color: C.background1, valign: "bottom", align: "left" }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 4.0, w: 11.0, h: 1.2, fontSize: 22, color: C.accent1, valign: "top", align: "left" }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: C.background1 },
  margin: [0.5, 0.6, 0.6, 0.6],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontSize: 34, bold: true, color: C.text1, valign: "middle", align: "left" }, text: "" } },
    { text: { text: "CrewBrief", options: { x: 0.6, y: 7.0, w: 3, h: 0.3, fontSize: 10, color: C.text2, isTextBox: true, margin: 0 } } },
  ],
  slideNumber: { x: 12.3, y: 7.0, w: 0.5, h: 0.3, fontSize: 10, color: C.text2 },
});

// ---------- Helpers ----------
async function icon(Comp, hex, size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color: "#" + hex, size: String(size) }));
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
async function iconCircle(slide, Comp, x, y, d, fill, fg, name) {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: name + " circle" });
  const pad = d * 0.22;
  slide.addImage({ data: await icon(Comp, fg), x: x + pad, y: y + pad, w: d - 2 * pad, h: d - 2 * pad, objectName: name + " icon" });
}
function card(slide, x, y, w, h, name, fill = C.background2) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: fill }, objectName: name });
}
function text(slide, t, opts) {
  slide.addText(t, { isTextBox: true, margin: 0, fontFace: THEME.bodyFontFace, color: C.text1, ...opts });
}

(async () => {
  // 1. Title
  pres.addSection({ title: "Opening" });
  let s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Opening" });
  s.addText("CrewBrief", { placeholder: "title" });
  s.addText("The crew's pre-job briefing, turned into a completed hazard assessment", { placeholder: "body" });
  await iconCircle(s, md.MdRecordVoiceOver, 0.8, 0.9, 1.1, HEX.accent1, HEX.lt1, "Logo");
  text(s, "Voice AI for utility field crews · Built on Azure", { x: 0.8, y: 6.4, w: 8, h: 0.4, fontSize: 14, color: C.background2 });
  s.addNotes("CrewBrief listens to the briefing crews already do and drafts the hazard assessment from it.");

  // 2. Problem
  pres.addSection({ title: "Problem" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Problem" });
  s.addText("Every job starts with a 40-minute form", { placeholder: "title" });
  card(s, 0.6, 1.6, 4.6, 4.9, "Stat card", C.text1);
  text(s, "40", { x: 0.9, y: 2.0, w: 4.0, h: 1.6, fontSize: 96, bold: true, color: C.accent1, fontFace: THEME.headFontFace });
  text(s, "minutes to complete a hazard assessment (JSA / SWMS) by hand, before every job", { x: 0.9, y: 3.8, w: 4.0, h: 1.4, fontSize: 18, color: C.background1 });
  const problems = [
    [md.MdTimerOff, "Time out of productive work", "Crews fill the form in on the tailgate while the job waits."],
    [md.MdEditNote, "Quality depends on who holds the pen", "Hazards discussed out loud never make it onto paper."],
    [md.MdWarningAmber, "Missed controls stay missed", "Nobody checks that a critical hazard has a real control until an audit."],
  ];
  for (let i = 0; i < problems.length; i++) {
    const y = 1.7 + i * 1.6;
    await iconCircle(s, problems[i][0], 5.8, y, 0.8, HEX.lt2, HEX.dk1, "Problem " + (i + 1));
    text(s, problems[i][1], { x: 6.9, y: y - 0.05, w: 5.8, h: 0.45, fontSize: 20, bold: true, fontFace: THEME.headFontFace });
    text(s, problems[i][2], { x: 6.9, y: y + 0.42, w: 5.8, h: 0.6, fontSize: 15, color: C.text2 });
  }
  s.addNotes("Crews already talk through hazards in their tailboard / Take 5. The form is a separate, slow, after-the-fact chore.");

  // 3. Insight
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Problem" });
  s.addText("Crews already say it out loud. Capture it.", { placeholder: "title" });
  card(s, 0.6, 1.7, 5.7, 4.6, "Today card");
  text(s, "Today", { x: 1.0, y: 2.0, w: 5, h: 0.5, fontSize: 22, bold: true, color: C.text2, fontFace: THEME.headFontFace });
  text(s, [
    { text: "Crew talks through the job", options: { bullet: true, breakLine: true } },
    { text: "Leading hand writes the form afterwards", options: { bullet: true, breakLine: true } },
    { text: "Details are lost between the two", options: { bullet: true } },
  ], { x: 1.0, y: 2.7, w: 5.0, h: 2.5, fontSize: 18, paraSpaceAfter: 10 });
  card(s, 7.0, 1.7, 5.7, 4.6, "CrewBrief card", C.text1);
  text(s, "With CrewBrief", { x: 7.4, y: 2.0, w: 5, h: 0.5, fontSize: 22, bold: true, color: C.accent1, fontFace: THEME.headFontFace });
  text(s, [
    { text: "Crew talks through the job, as normal", options: { bullet: true, breakLine: true } },
    { text: "The form drafts itself from what was said", options: { bullet: true, breakLine: true } },
    { text: "The crew lead reviews and signs in minutes", options: { bullet: true } },
  ], { x: 7.4, y: 2.7, w: 5.0, h: 2.5, fontSize: 18, paraSpaceAfter: 10, color: C.background1 });
  await iconCircle(s, md.MdArrowForward, 6.25, 3.6, 0.8, HEX.accent1, HEX.lt1, "Arrow");

  // 4. How it works
  pres.addSection({ title: "Solution" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Solution" });
  s.addText("How it works: one standup, one signed form", { placeholder: "title" });
  const steps = [
    [md.MdMic, "Record", "One device records the whole crew's briefing. Live, or upload a recording."],
    [md.MdGraphicEq, "Understand", "Azure AI Speech separates the voices. AI maps what was said to the company hazard library."],
    [md.MdHelpOutline, "Clarify", "No interruptions. At the end, CrewBrief asks only the critical questions it still has."],
    [md.MdTaskAlt, "Sign", "The crew lead reviews the drafted form with evidence for every field, then signs and submits."],
  ];
  for (let i = 0; i < steps.length; i++) {
    const x = 0.6 + i * 3.1;
    card(s, x, 1.8, 2.8, 4.5, "Step " + (i + 1));
    await iconCircle(s, steps[i][0], x + 0.3, 2.1, 0.9, HEX.accent1, HEX.lt1, "Step " + (i + 1));
    text(s, `${i + 1}  ${steps[i][1]}`, { x: x + 0.3, y: 3.2, w: 2.3, h: 0.5, fontSize: 20, bold: true, fontFace: THEME.headFontFace });
    text(s, steps[i][2], { x: x + 0.3, y: 3.8, w: 2.3, h: 2.3, fontSize: 15, color: C.text2, valign: "top" });
  }
  s.addNotes("Standup mode: the AI never talks over the crew. It waits until they are done, then asks at most three critical questions.");

  // 5. Demo divider
  pres.addSection({ title: "Demo" });
  s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Demo" });
  s.addText("Live demo", { placeholder: "title" });
  s.addText("LV service connection · Pole replacement with a crane · Night storm restoration", { placeholder: "body" });
  await iconCircle(s, md.MdPlayCircle, 0.8, 0.9, 1.1, HEX.accent1, HEX.lt1, "Play");
  s.addNotes("Play the demo video here. Scenario 1 shows the clarification question about isolating live LV.");

  // 6. Trust
  pres.addSection({ title: "Trust" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Trust" });
  s.addText("Built so a wrong form never looks complete", { placeholder: "title" });
  const trust = [
    [md.MdFormatQuote, "Evidence for every field", "Each hazard and control links to the exact words the crew said."],
    [md.MdRule, "Safety rules in code, not prompts", "A critical hazard needs an isolation or engineering control. Absence is never assumed."],
    [md.MdPerson, "A person always signs", "The form is never submitted without the crew lead's sign-off."],
    [md.MdHistory, "Full audit trail", "Every change records its source, model and prompt version, and who approved it."],
  ];
  for (let i = 0; i < trust.length; i++) {
    const x = 0.6 + (i % 2) * 6.2, y = 1.7 + Math.floor(i / 2) * 2.5;
    card(s, x, y, 5.9, 2.2, "Trust " + (i + 1));
    await iconCircle(s, trust[i][0], x + 0.3, y + 0.35, 0.8, HEX.dk1, HEX.lt1, "Trust " + (i + 1));
    text(s, trust[i][1], { x: x + 1.35, y: y + 0.3, w: 4.3, h: 0.5, fontSize: 19, bold: true, fontFace: THEME.headFontFace });
    text(s, trust[i][2], { x: x + 1.35, y: y + 0.85, w: 4.3, h: 1.1, fontSize: 15, color: C.text2, valign: "top" });
  }

  // 7. Accuracy
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Trust" });
  s.addText("Measured, not assumed", { placeholder: "title" });
  const stats = [
    ["100%", "Critical hazard recall", "Target ≥ 98%"],
    ["100%", "Fields backed by evidence", "Target ≥ 95%"],
    ["0%", "Unsupported (hallucinated) fields", "Target ≤ 2%"],
  ];
  for (let i = 0; i < stats.length; i++) {
    const x = 0.6 + i * 4.15;
    card(s, x, 1.7, 3.85, 2.9, "Stat " + (i + 1));
    text(s, stats[i][0], { x: x + 0.3, y: 1.95, w: 3.3, h: 1.2, fontSize: 60, bold: true, color: C.accent2, fontFace: THEME.headFontFace });
    text(s, stats[i][1], { x: x + 0.3, y: 3.2, w: 3.3, h: 0.6, fontSize: 18, bold: true });
    text(s, stats[i][2], { x: x + 0.3, y: 3.85, w: 3.3, h: 0.4, fontSize: 14, color: C.text2 });
  }
  text(s, "Offline evaluation on 6 synthetic briefings (sample set). Every pull request runs this gate in CI. Next: 20 real briefings scored by safety experts, then a shadow pilot.", { x: 0.6, y: 5.0, w: 12.1, h: 1.0, fontSize: 15, color: C.text2, italic: true });
  s.addNotes("Be clear these are synthetic sample results; the real proof is the SME gold set and the shadow pilot.");

  // 8. Architecture
  pres.addSection({ title: "Platform" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Platform" });
  s.addText("Enterprise-ready on Azure", { placeholder: "title" });
  const arch = [
    [md.MdGraphicEq, "Azure AI Speech", "Transcription and speaker separation"],
    [md.MdPsychology, "Azure OpenAI", "Understands the briefing, checks the draft"],
    [md.MdSearch, "Azure AI Search", "Company hazard and control library"],
    [md.MdStorage, "Cosmos DB", "Drafts, transcripts, audit log"],
    [md.MdSync, "Web PubSub", "Live updates to the crew's screen"],
    [md.MdCloudQueue, "Container Apps", "Autoscaling services for 1,000+ crews"],
  ];
  for (let i = 0; i < arch.length; i++) {
    const x = 0.6 + (i % 3) * 4.15, y = 1.7 + Math.floor(i / 3) * 2.1;
    card(s, x, y, 3.85, 1.8, "Service " + (i + 1));
    await iconCircle(s, arch[i][0], x + 0.25, y + 0.45, 0.85, HEX.accent4, HEX.lt1, "Service " + (i + 1));
    text(s, arch[i][1], { x: x + 1.3, y: y + 0.35, w: 2.4, h: 0.5, fontSize: 18, bold: true, fontFace: THEME.headFontFace });
    text(s, arch[i][2], { x: x + 1.3, y: y + 0.85, w: 2.4, h: 0.8, fontSize: 14, color: C.text2, valign: "top" });
  }
  text(s, "Deterministic orchestrator (not an LLM) decides what runs when, so every decision is auditable. Infrastructure as code (Bicep, azd); CI with an accuracy gate.", { x: 0.6, y: 6.0, w: 12.1, h: 0.8, fontSize: 14, color: C.text2 });

  // 9. Privacy
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Platform" });
  s.addText("Privacy and security by default", { placeholder: "title" });
  const priv = [
    [md.MdMicOff, "No raw audio stored", "Transcripts only, with personal details redacted."],
    [md.MdFingerprint, "No voice biometrics", "Voices are separated, never identified by voiceprint."],
    [md.MdCampaign, "Crews are told", "A recording notice is acknowledged before every briefing."],
    [md.MdLock, "Australian data residency", "Private networking, managed identity, Entra ID sign-in."],
  ];
  for (let i = 0; i < priv.length; i++) {
    const y = 1.6 + i * 1.3;
    await iconCircle(s, priv[i][0], 0.6, y, 0.85, HEX.accent2, HEX.lt1, "Privacy " + (i + 1));
    text(s, priv[i][1], { x: 1.75, y: y, w: 4.5, h: 0.45, fontSize: 19, bold: true, fontFace: THEME.headFontFace });
    text(s, priv[i][2], { x: 1.75, y: y + 0.45, w: 4.8, h: 0.5, fontSize: 15, color: C.text2 });
  }
  card(s, 7.2, 1.6, 5.5, 4.9, "Compliance card", C.text1);
  text(s, "Deployment needs legal review under workplace surveillance and listening-device laws in each state.", { x: 7.6, y: 2.0, w: 4.7, h: 2.2, fontSize: 20, color: C.background1, valign: "top" });
  text(s, "CrewBrief assists with hazard assessment. It does not replace the crew's responsibility for job safety.", { x: 7.6, y: 4.4, w: 4.7, h: 1.8, fontSize: 16, italic: true, color: C.accent1, valign: "top" });

  // 10. Impact
  pres.addSection({ title: "Impact" });
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Impact" });
  s.addText("The time comes back to the job", { placeholder: "title" });
  s.addChart(pres.charts.BAR, [{ name: "Minutes per form", labels: ["With CrewBrief (review)", "By hand today"], values: [5, 40] }], {
    x: 0.6, y: 1.6, w: 6.6, h: 4.8, barDir: "bar", chartColors: [HEX.accent1, HEX.dk2], showValue: true, dataLabelPosition: "outEnd",
    dataLabelFontSize: 16, dataLabelColor: HEX.dk1, dataLabelFontFace: "+mn-lt", showLegend: false, showTitle: true,
    title: "Minutes per hazard assessment", titleFontSize: 16, titleColor: HEX.dk1, titleFontFace: "+mn-lt",
    catAxisLabelColor: HEX.dk2, catAxisLabelFontSize: 14, catAxisLabelFontFace: "+mn-lt", valAxisHidden: true,
    valGridLine: { style: "none" }, catGridLine: { style: "none" },
  });
  card(s, 7.7, 1.8, 5.0, 4.4, "Impact card", C.text1);
  text(s, "≈580", { x: 8.1, y: 2.1, w: 4.3, h: 1.5, fontSize: 80, bold: true, color: C.accent1, fontFace: THEME.headFontFace });
  text(s, "crew-hours back every working day across 1,000 crews (35 minutes saved per form, one form per crew per day)", { x: 8.1, y: 3.7, w: 4.3, h: 1.6, fontSize: 16, color: C.background1, valign: "top" });
  text(s, "Illustrative estimate", { x: 8.1, y: 5.5, w: 4.3, h: 0.4, fontSize: 12, italic: true, color: C.background2 });

  // 11. Roadmap
  s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Impact" });
  s.addText("From prototype to every crew", { placeholder: "title" });
  const phases = [
    ["Done", "Prototype", "Form schema, hazard library, live pipeline, standup clarifications, eval gate", HEX.accent2],
    ["Next", "Gold data", "20 real briefings scored by safety experts; Azure speech tuned on utility terms", HEX.accent1],
    ["Then", "Shadow pilot", "10 crews fill forms as today while CrewBrief drafts in parallel", HEX.accent4],
    ["Scale", "Rollout", "Provisioned throughput, multi-region speech, offline mode for poor coverage", HEX.dk2],
  ];
  s.addShape(pres.shapes.LINE, { x: 0.9, y: 2.45, w: 11.5, h: 0, line: { color: HEX.accent5, width: 2 }, objectName: "Timeline" });
  for (let i = 0; i < phases.length; i++) {
    const x = 0.6 + i * 3.1;
    s.addShape(pres.shapes.OVAL, { x: x + 0.15, y: 2.2, w: 0.5, h: 0.5, fill: { color: phases[i][3] }, line: { color: phases[i][3] }, objectName: "Milestone " + (i + 1) });
    text(s, phases[i][0].toUpperCase(), { x, y: 1.6, w: 2.8, h: 0.4, fontSize: 13, bold: true, color: C.text2 });
    text(s, phases[i][1], { x, y: 3.0, w: 2.8, h: 0.5, fontSize: 20, bold: true, fontFace: THEME.headFontFace });
    text(s, phases[i][2], { x, y: 3.6, w: 2.8, h: 2.2, fontSize: 15, color: C.text2, valign: "top" });
  }
  text(s, "Later: work-order and switching-instruction context, weather and fire-danger inputs.", { x: 0.6, y: 6.0, w: 12.1, h: 0.5, fontSize: 15, italic: true, color: C.text2 });

  // 12. Ask
  pres.addSection({ title: "Close" });
  s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Close" });
  s.addText("Let's pilot it with 10 crews", { placeholder: "title" });
  s.addText("We need: a pilot depot, 20 recorded briefings for the gold set, and an Azure subscription in Australia East", { placeholder: "body" });
  await iconCircle(s, md.MdHandshake, 0.8, 0.9, 1.1, HEX.accent1, HEX.lt1, "Handshake");

  await pres.writeFile({ fileName: "CrewBrief-pitch.pptx" });
  await applyTheme("CrewBrief-pitch.pptx", THEME);
  console.log("written");
})();
