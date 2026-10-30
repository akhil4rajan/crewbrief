# Pitch deck

`CrewBrief-pitch.pptx` is the 12-slide pitch deck to present alongside the demo video
(problem, how it works, demo, trust and accuracy, Azure platform, privacy, impact, roadmap, ask).
Speaker notes are on the key slides. Edit it directly in PowerPoint.

To regenerate it from `build_deck.js` (e.g. after changing numbers), from this folder:

```bash
npm install --no-save pptxgenjs react react-dom react-icons sharp
node build_deck.js
```

Set `PPTX_SKILL` to the pptx skill folder so the CrewBrief colours are written into the theme; without it
the deck builds with Office's default colours. The committed `.pptx` already has the CrewBrief theme.
