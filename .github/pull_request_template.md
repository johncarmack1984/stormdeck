<!--
PR title is the changelog line (auto-release.yml generates notes from it) and the
squash subject. Make it descriptive, and add a label so it sorts into the right
section of .github/release.yml. Put [skip release] in the title to skip the auto patch.
-->

## Summary

<!-- What changed and why. -->

## Docs & attribution

Merging deploys, so stale docs ship to production. Tick every box (or the N/A).

- [ ] **README** updated if this changed data sources, behavior, costs, or architecture (intro, the mermaid diagram, and the *What it costs* / *Configuration* tables).
- [ ] **On-map attribution** (`web/src/App.tsx` and `web/src/basemap.ts`) updated if a tile/data source was added, removed, or swapped.
- [ ] **Every new external source is credited** in both the on-map attribution and the README *Attribution* section — free/open data still carries license terms (an uncredited source is a licensing bug, not just a doc gap).
- [ ] N/A — no data sources, user-facing behavior, costs, or architecture changed.
