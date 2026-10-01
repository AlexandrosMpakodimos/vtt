// Form-field accessibility checks shared by the jsdom UI suites.
//
// Added 2026-10-01 after Chrome's DevTools Issues panel reported "A form field
// element should have an id or name attribute" twelve times on the production
// dashboard, and an axe-core run found unlabelled controls and broken
// label[for] links elsewhere. These are the checks Chrome itself makes, plus an
// accessible-name check for visible controls:
//   1. every input/select/textarea has an id or a name
//   2. every <label for> points at an existing form control
//   3. every rendered control (not type=hidden, not inside [hidden]) has an
//      accessible name: aria-label, aria-labelledby, title, or a <label>
// They inspect the DOM as rendered at the moment of the call, so a suite calls
// formFieldProblems(document) after it has opened the UI it wants covered. An
// optional root limits the scan to one widget (the suite's own scaffolding
// inputs are then left out); ids and labels still resolve against the document.

const CONTROL = /^(INPUT|SELECT|TEXTAREA|BUTTON|METER|OUTPUT|PROGRESS)$/;

function describe(node) {
  return node.outerHTML.replace(/\s+/g, ' ').slice(0, 140);
}

function hasAccessibleName(field, document) {
  if ((field.getAttribute('aria-label') || '').trim()) return true;
  if ((field.getAttribute('title') || '').trim()) return true;
  const by = (field.getAttribute('aria-labelledby') || '').trim();
  if (by && by.split(/\s+/).every((id) => document.getElementById(id))) return true;
  if (field.closest('label')) return true;
  if (field.id) {
    for (const label of document.querySelectorAll('label[for]')) {
      if (label.getAttribute('for') === field.id) return true;
    }
  }
  return false;
}

function formFieldProblems(document, root = document) {
  const problems = [];
  for (const field of root.querySelectorAll('input, select, textarea')) {
    if (!field.id && !field.getAttribute('name')) problems.push('no id or name: ' + describe(field));
    const rendered = field.type !== 'hidden' && !field.closest('[hidden]');
    if (rendered && !hasAccessibleName(field, document)) {
      problems.push('no accessible name: ' + describe(field));
    }
  }
  for (const label of root.querySelectorAll('label[for]')) {
    const target = document.getElementById(label.getAttribute('for'));
    if (!target || !CONTROL.test(target.tagName)) problems.push('label for= matches no control: ' + describe(label));
  }
  return problems;
}

module.exports = { formFieldProblems };
