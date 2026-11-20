// Turns recorded visual edits into a markdown brief for a coding agent.
function buildBrief(data) {
  const { root, capturedAt, viewport, shots, changes } = data;
  const out = [];
  out.push('# Studio changes');
  out.push('');
  out.push(`- Project: \`${root}\``);
  out.push(`- Captured: ${capturedAt}`);
  out.push(`- Viewport: ${viewport.w}×${viewport.h}`);
  if (shots?.before) out.push(`- Before screenshot: \`${shots.before}\``);
  if (shots?.after) out.push(`- After screenshot (changed elements outlined in pink): \`${shots.after}\``);
  out.push('');
  out.push('## Instructions');
  out.push('');
  out.push('These values come from dragging elements visually in the running app. They are the final target values in CSS pixels.');
  out.push('');
  out.push('- Make exactly these changes in the source. Do not change anything else.');
  out.push('- Edit the existing rule or component (see "Likely source") instead of adding inline styles or overrides.');
  out.push('- If a value matches an existing CSS variable (noted below), use the variable.');
  out.push('- If an edit was made to one instance of something that is shared, decide whether the shared rule or only that instance should change. Prefer the shared rule when the change looks like a general design decision, and say which you chose.');
  out.push('- `width`/`height` are the element\'s rendered size. Only set them if the layout genuinely needs a fixed size; otherwise get there with padding, gap, or min sizes.');
  out.push('- Look at the screenshots to understand the intent, then reply with a short summary of what you changed and anything you were unsure about.');
  out.push('');
  changes.forEach((c, i) => {
    out.push(`## ${i + 1}. ${c.removed ? 'Remove: ' : ''}${c.label}`);
    out.push('');
    out.push(`Selector: \`${c.selector}\``);
    if (c.removed) {
      out.push('');
      out.push(`**Delete this element from the UI**${c.childCount ? ` (it contains ${c.childCount} inner elements, which go with it)` : ''}. Remove it from the markup or component, along with any styles or code that exist only for it. If it is rendered by a loop or condition, remove the right thing and say what you did. If it appears in other places or is shared, tell me instead of guessing.`);
      out.push('');
      if (c.sources?.length) {
        out.push('Likely source:');
        for (const s of c.sources) out.push(`- \`${s.file}:${s.line}\` (${s.kind}) \`${s.text.replace(/`/g, "'")}\``);
      } else {
        out.push('Likely source: not found by search. Look for the selector or its classes.');
      }
      out.push('');
      return;
    }
    if (c.sharedCount > 1) out.push(`Shared: ${c.sharedCount} elements on this page match these classes. The edit was made to one of them.`);
    if (c.boxSizing) out.push(`Box sizing: \`${c.boxSizing}\``);
    out.push('');
    out.push('| Property | Before | After | Notes |');
    out.push('| --- | --- | --- | --- |');
    for (const p of c.props) out.push(`| ${p.prop} | ${p.before} | ${p.after} | ${p.variable ? `matches \`var(${p.variable})\`` : ''} |`);
    out.push('');
    if (c.sources?.length) {
      out.push('Likely source:');
      for (const s of c.sources) out.push(`- \`${s.file}:${s.line}\` (${s.kind}) \`${s.text.replace(/`/g, "'")}\``);
    } else {
      out.push('Likely source: not found by search. Look for the selector or its classes.');
    }
    out.push('');
  });
  return out.join('\n');
}

module.exports = { buildBrief };
